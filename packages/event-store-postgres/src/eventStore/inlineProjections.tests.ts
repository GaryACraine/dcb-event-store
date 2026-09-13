import { Pool, PoolClient } from "pg"
import { DcbEvent, Query, SequencedEvent, Tags, streamAllEventsToArray } from "@dcb-es/event-store"
import { PostgresEventStore } from "./PostgresEventStore.js"
import { Projection } from "../projections/projection.js"
import { getTestPgDatabasePool } from "@test/testPgDbPool"

const event = (type: string, tags: Tags, data: unknown = {}): DcbEvent => ({
    type,
    tags,
    data,
    metadata: {}
})

/** Creates a trivial SQL projection that inserts into a tracking table. */
function trackingProjection(
    name: string,
    canHandle: Query,
    trackingTable = "inline_proj_log"
): Projection & { received: SequencedEvent[][] } {
    const received: SequencedEvent[][] = []
    return {
        name,
        canHandle,
        received,
        init: async (client: PoolClient) => {
            await client.query(`
                CREATE TABLE IF NOT EXISTS ${trackingTable} (
                    id SERIAL PRIMARY KEY,
                    event_type TEXT NOT NULL,
                    event_position BIGINT NOT NULL,
                    projection_name TEXT NOT NULL
                )
            `)
        },
        handle: async (events: SequencedEvent[], ctx: { client: PoolClient }) => {
            received.push(events)
            for (const se of events) {
                await ctx.client.query(
                    `INSERT INTO ${trackingTable} (event_type, event_position, projection_name) VALUES ($1, $2, $3)`,
                    [se.event.type, se.position.toString(), name]
                )
            }
        },
        truncate: async (client: PoolClient) => {
            await client.query(`DELETE FROM ${trackingTable}`)
        }
    }
}

describe("Inline Projections", () => {
    let pool: Pool

    beforeAll(async () => {
        pool = await getTestPgDatabasePool({ max: 30 })
    })

    afterAll(async () => {
        if (pool) await pool.end()
    })

    describe("function path (≤ copyThreshold events)", () => {
        test("inline projection sees appended events with correct SequencedEvent data", async () => {
            const projection = trackingProjection("test-proj", Query.all())
            const store = new PostgresEventStore({ pool, inlineProjections: [projection] })
            await store.ensureInstalled()

            const initClient = await pool.connect()
            try {
                await projection.init!(initClient)
            } finally {
                initClient.release()
            }

            try {
                const pos = await store.append({
                    events: [
                        event("OrderPlaced", Tags.fromObj({ orderId: "O1" }), { total: 100 }),
                        event("OrderShipped", Tags.fromObj({ orderId: "O1" }), { carrier: "UPS" })
                    ]
                })

                expect(pos.toString()).toBe("2")
                expect(projection.received).toHaveLength(1)
                expect(projection.received[0]).toHaveLength(2)

                const [first, second] = projection.received[0]
                expect(first.event.type).toBe("OrderPlaced")
                expect(first.event.data).toEqual({ total: 100 })
                expect(first.position.toString()).toBe("1")
                expect(first.id).toBeDefined()
                expect(first.recordedAt).toBeInstanceOf(Date)

                expect(second.event.type).toBe("OrderShipped")
                expect(second.position.toString()).toBe("2")

                // Verify the projection's SQL writes committed
                const logResult = await pool.query("SELECT * FROM inline_proj_log ORDER BY event_position")
                expect(logResult.rows).toHaveLength(2)
                expect(logResult.rows[0].event_type).toBe("OrderPlaced")
                expect(logResult.rows[1].event_type).toBe("OrderShipped")
            } finally {
                await pool.query("TRUNCATE table events")
                await pool.query("ALTER SEQUENCE events_sequence_position_seq RESTART WITH 1")
                await pool.query("DROP TABLE IF EXISTS inline_proj_log")
            }
        })

        test("throw in projection rolls back events and projection writes", async () => {
            const failingProjection: Projection = {
                name: "failing-proj",
                canHandle: Query.all(),
                handle: async () => {
                    throw new Error("Projection failed!")
                }
            }
            const store = new PostgresEventStore({ pool, inlineProjections: [failingProjection] })
            await store.ensureInstalled()

            try {
                await expect(store.append({ events: event("TestEvent", Tags.fromObj({ e: "1" })) })).rejects.toThrow(
                    "Projection failed!"
                )

                // Events should NOT have been persisted
                const events = await streamAllEventsToArray(new PostgresEventStore({ pool }).read(Query.all()))
                expect(events).toHaveLength(0)
            } finally {
                await pool.query("TRUNCATE table events")
                await pool.query("ALTER SEQUENCE events_sequence_position_seq RESTART WITH 1")
            }
        })

        test("onBeforeCommit hook runs after projections and receives appended events", async () => {
            const callOrder: string[] = []
            const hookEvents: SequencedEvent[] = []

            const projection: Projection = {
                name: "order-proj",
                canHandle: Query.all(),
                handle: async () => {
                    callOrder.push("projection")
                }
            }

            const onBeforeCommit = async (events: SequencedEvent[]) => {
                callOrder.push("hook")
                hookEvents.push(...events)
            }

            const store = new PostgresEventStore({
                pool,
                inlineProjections: [projection],
                onBeforeCommit
            })
            await store.ensureInstalled()

            try {
                await store.append({
                    events: event("TestEvent", Tags.fromObj({ e: "1" }), { value: 42 })
                })

                expect(callOrder).toEqual(["projection", "hook"])
                expect(hookEvents).toHaveLength(1)
                expect(hookEvents[0].event.type).toBe("TestEvent")
                expect(hookEvents[0].event.data).toEqual({ value: 42 })
                expect(hookEvents[0].position.toString()).toBe("1")
            } finally {
                await pool.query("TRUNCATE table events")
                await pool.query("ALTER SEQUENCE events_sequence_position_seq RESTART WITH 1")
            }
        })

        test("throw in onBeforeCommit rolls back events and projection writes", async () => {
            const initClient = await pool.connect()
            try {
                await initClient.query(`
                    CREATE TABLE IF NOT EXISTS hook_rollback_log (
                        id SERIAL PRIMARY KEY,
                        event_type TEXT NOT NULL
                    )
                `)
            } finally {
                initClient.release()
            }

            const projection: Projection = {
                name: "write-then-fail",
                canHandle: Query.all(),
                handle: async (events, ctx) => {
                    for (const se of events) {
                        await ctx.client.query("INSERT INTO hook_rollback_log (event_type) VALUES ($1)", [
                            se.event.type
                        ])
                    }
                }
            }

            const store = new PostgresEventStore({
                pool,
                inlineProjections: [projection],
                onBeforeCommit: async () => {
                    throw new Error("Hook failed!")
                }
            })
            await store.ensureInstalled()

            try {
                await expect(store.append({ events: event("TestEvent", Tags.fromObj({ e: "1" })) })).rejects.toThrow(
                    "Hook failed!"
                )

                // Events rolled back
                const events = await streamAllEventsToArray(new PostgresEventStore({ pool }).read(Query.all()))
                expect(events).toHaveLength(0)

                // Projection SQL writes also rolled back
                const logResult = await pool.query("SELECT * FROM hook_rollback_log")
                expect(logResult.rows).toHaveLength(0)
            } finally {
                await pool.query("TRUNCATE table events")
                await pool.query("ALTER SEQUENCE events_sequence_position_seq RESTART WITH 1")
                await pool.query("DROP TABLE IF EXISTS hook_rollback_log")
            }
        })

        test("inline projection filters by canHandle query", async () => {
            const orderProjection = trackingProjection(
                "order-proj",
                Query.fromItems([{ types: ["OrderPlaced", "OrderShipped"] }]),
                "order_proj_log"
            )
            const paymentProjection = trackingProjection(
                "payment-proj",
                Query.fromItems([{ types: ["PaymentReceived"] }]),
                "payment_proj_log"
            )

            const store = new PostgresEventStore({
                pool,
                inlineProjections: [orderProjection, paymentProjection]
            })
            await store.ensureInstalled()

            const initClient = await pool.connect()
            try {
                await orderProjection.init!(initClient)
                await paymentProjection.init!(initClient)
            } finally {
                initClient.release()
            }

            try {
                await store.append({
                    events: [
                        event("OrderPlaced", Tags.fromObj({ orderId: "O1" })),
                        event("PaymentReceived", Tags.fromObj({ paymentId: "P1" })),
                        event("OrderShipped", Tags.fromObj({ orderId: "O1" }))
                    ]
                })

                // Order projection received OrderPlaced + OrderShipped
                expect(orderProjection.received).toHaveLength(1)
                expect(orderProjection.received[0]).toHaveLength(2)
                expect(orderProjection.received[0][0].event.type).toBe("OrderPlaced")
                expect(orderProjection.received[0][1].event.type).toBe("OrderShipped")

                // Payment projection received only PaymentReceived
                expect(paymentProjection.received).toHaveLength(1)
                expect(paymentProjection.received[0]).toHaveLength(1)
                expect(paymentProjection.received[0][0].event.type).toBe("PaymentReceived")
            } finally {
                await pool.query("TRUNCATE table events")
                await pool.query("ALTER SEQUENCE events_sequence_position_seq RESTART WITH 1")
                await pool.query("DROP TABLE IF EXISTS order_proj_log")
                await pool.query("DROP TABLE IF EXISTS payment_proj_log")
            }
        })

        test("multiple inline projections run in same transaction", async () => {
            const proj1 = trackingProjection("proj-1", Query.all(), "proj1_log")
            const proj2 = trackingProjection("proj-2", Query.all(), "proj2_log")

            const store = new PostgresEventStore({
                pool,
                inlineProjections: [proj1, proj2]
            })
            await store.ensureInstalled()

            const initClient = await pool.connect()
            try {
                await proj1.init!(initClient)
                await proj2.init!(initClient)
            } finally {
                initClient.release()
            }

            try {
                await store.append({
                    events: event("TestEvent", Tags.fromObj({ e: "1" }))
                })

                // Both projections received the event
                expect(proj1.received).toHaveLength(1)
                expect(proj2.received).toHaveLength(1)

                // Both wrote to their tables atomically
                const log1 = await pool.query("SELECT * FROM proj1_log")
                const log2 = await pool.query("SELECT * FROM proj2_log")
                expect(log1.rows).toHaveLength(1)
                expect(log2.rows).toHaveLength(1)
            } finally {
                await pool.query("TRUNCATE table events")
                await pool.query("ALTER SEQUENCE events_sequence_position_seq RESTART WITH 1")
                await pool.query("DROP TABLE IF EXISTS proj1_log")
                await pool.query("DROP TABLE IF EXISTS proj2_log")
            }
        })

        test("onBeforeCommit alone (without projections) triggers transactional path", async () => {
            const hookEvents: SequencedEvent[] = []

            const store = new PostgresEventStore({
                pool,
                onBeforeCommit: async events => {
                    hookEvents.push(...events)
                }
            })
            await store.ensureInstalled()

            try {
                const pos = await store.append({
                    events: event("TestEvent", Tags.fromObj({ e: "1" }))
                })

                expect(pos.toString()).toBe("1")
                expect(hookEvents).toHaveLength(1)
                expect(hookEvents[0].event.type).toBe("TestEvent")
            } finally {
                await pool.query("TRUNCATE table events")
                await pool.query("ALTER SEQUENCE events_sequence_position_seq RESTART WITH 1")
            }
        })

        test("default path (no projections) still works via autocommit", async () => {
            const store = new PostgresEventStore({ pool })
            await store.ensureInstalled()

            try {
                const pos = await store.append({
                    events: [event("A", Tags.fromObj({ e: "1" })), event("B", Tags.fromObj({ e: "2" }))]
                })
                expect(pos.toString()).toBe("2")

                const events = await streamAllEventsToArray(store.read(Query.all()))
                expect(events).toHaveLength(2)
            } finally {
                await pool.query("TRUNCATE table events")
                await pool.query("ALTER SEQUENCE events_sequence_position_seq RESTART WITH 1")
            }
        })
    })

    describe("COPY path (> copyThreshold events)", () => {
        test("inline projection runs correctly with COPY path", async () => {
            const projection = trackingProjection("copy-proj", Query.all(), "copy_proj_log")

            // Set copyThreshold to 2 so we trigger the COPY path with 3 events
            const store = new PostgresEventStore({
                pool,
                copyThreshold: 2,
                inlineProjections: [projection]
            })
            await store.ensureInstalled()

            const initClient = await pool.connect()
            try {
                await projection.init!(initClient)
            } finally {
                initClient.release()
            }

            try {
                const pos = await store.append({
                    events: [
                        event("A", Tags.fromObj({ e: "1" })),
                        event("B", Tags.fromObj({ e: "2" })),
                        event("C", Tags.fromObj({ e: "3" }))
                    ]
                })

                expect(pos.toString()).toBe("3")
                expect(projection.received).toHaveLength(1)
                expect(projection.received[0]).toHaveLength(3)
                expect(projection.received[0][0].event.type).toBe("A")
                expect(projection.received[0][2].event.type).toBe("C")

                // Verify committed to DB
                const logResult = await pool.query("SELECT * FROM copy_proj_log ORDER BY event_position")
                expect(logResult.rows).toHaveLength(3)
            } finally {
                await pool.query("TRUNCATE table events")
                await pool.query("ALTER SEQUENCE events_sequence_position_seq RESTART WITH 1")
                await pool.query("DROP TABLE IF EXISTS copy_proj_log")
            }
        })

        test("throw in projection rolls back COPY-path events", async () => {
            const failingProjection: Projection = {
                name: "copy-fail",
                canHandle: Query.all(),
                handle: async () => {
                    throw new Error("COPY projection failed!")
                }
            }

            const store = new PostgresEventStore({
                pool,
                copyThreshold: 2,
                inlineProjections: [failingProjection]
            })
            await store.ensureInstalled()

            try {
                await expect(
                    store.append({
                        events: [
                            event("A", Tags.fromObj({ e: "1" })),
                            event("B", Tags.fromObj({ e: "2" })),
                            event("C", Tags.fromObj({ e: "3" }))
                        ]
                    })
                ).rejects.toThrow("COPY projection failed!")

                const events = await streamAllEventsToArray(new PostgresEventStore({ pool }).read(Query.all()))
                expect(events).toHaveLength(0)
            } finally {
                await pool.query("TRUNCATE table events")
                await pool.query("ALTER SEQUENCE events_sequence_position_seq RESTART WITH 1")
            }
        })
    })

    describe("canHandle tag filtering", () => {
        test("projection with tag filter only receives matching events", async () => {
            const o1Projection = trackingProjection(
                "o1-proj",
                Query.fromItems([{ types: ["OrderPlaced"], tags: Tags.fromObj({ orderId: "O1" }) }]),
                "o1_proj_log"
            )

            const store = new PostgresEventStore({
                pool,
                inlineProjections: [o1Projection]
            })
            await store.ensureInstalled()

            const initClient = await pool.connect()
            try {
                await o1Projection.init!(initClient)
            } finally {
                initClient.release()
            }

            try {
                await store.append({
                    events: [
                        event("OrderPlaced", Tags.fromObj({ orderId: "O1" }), { total: 50 }),
                        event("OrderPlaced", Tags.fromObj({ orderId: "O2" }), { total: 75 }),
                        event("OrderShipped", Tags.fromObj({ orderId: "O1" }))
                    ]
                })

                // Only the O1 OrderPlaced event should match (O2 has wrong tag, OrderShipped has wrong type)
                expect(o1Projection.received).toHaveLength(1)
                expect(o1Projection.received[0]).toHaveLength(1)
                expect(o1Projection.received[0][0].event.data).toEqual({ total: 50 })
            } finally {
                await pool.query("TRUNCATE table events")
                await pool.query("ALTER SEQUENCE events_sequence_position_seq RESTART WITH 1")
                await pool.query("DROP TABLE IF EXISTS o1_proj_log")
            }
        })
    })
})
