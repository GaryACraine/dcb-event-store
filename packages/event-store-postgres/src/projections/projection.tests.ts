import { Pool } from "pg"
import { AnyEvent, TaggedEvent, Query, Tags } from "@dcb-es/event-store"
import { PostgresEventStore } from "../eventStore/PostgresEventStore.js"
import { ensureHandlersInstalled } from "../eventHandling/ensureHandlersInstalled.js"
import { createConsumer } from "../eventHandling/consumer.js"
import { getTestPgDatabasePool } from "@test/testPgDbPool"
import { rawSqlProjection } from "./rawSqlProjection.js"
import { projectionToProcessor } from "./projectionAdapter.js"

const event = (
    type: string,
    data: Record<string, unknown> = {},
    tags: Tags = Tags.fromObj({ e: "1" })
): TaggedEvent<AnyEvent> => ({
    event: { type, data } as AnyEvent,
    tags
})

describe("rawSqlProjection", () => {
    let pool: Pool

    beforeAll(async () => {
        pool = await getTestPgDatabasePool({ max: 20 })
    })

    afterAll(async () => {
        if (pool) await pool.end()
    })

    test("wraps evolve into handle and processes events", async () => {
        const projection = rawSqlProjection({
            name: "test-rawsql",
            canHandle: Query.fromItems([{ types: ["ItemAdded"] }]),
            init: async client => {
                await client.query(`
                    CREATE TABLE IF NOT EXISTS test_items (
                        name TEXT NOT NULL
                    )
                `)
            },
            evolve: async (event, client) => {
                if (event.event.type === "ItemAdded") {
                    await client.query("INSERT INTO test_items (name) VALUES ($1)", [
                        (event.event.data as { name: string }).name
                    ])
                }
            },
            truncate: async client => {
                await client.query("TRUNCATE test_items")
            }
        })

        const client = await pool.connect()
        try {
            await client.query("BEGIN")
            await projection.init!(client)

            const { SequencePosition } = await import("@dcb-es/event-store")
            const { v4: uuid } = await import("uuid")

            await projection.handle(
                [
                    {
                        event: event("ItemAdded", { name: "item-1" }).event,
                        tags: Tags.fromObj({ e: "1" }),
                        position: SequencePosition.fromString("1"),
                        id: uuid(),
                        recordedAt: new Date()
                    },
                    {
                        event: event("ItemAdded", { name: "item-2" }).event,
                        tags: Tags.fromObj({ e: "1" }),
                        position: SequencePosition.fromString("2"),
                        id: uuid(),
                        recordedAt: new Date()
                    }
                ],
                { client }
            )

            const result = await client.query("SELECT name FROM test_items ORDER BY name")
            expect(result.rows).toEqual([{ name: "item-1" }, { name: "item-2" }])

            // Test truncate
            await projection.truncate!(client)
            const afterTruncate = await client.query("SELECT count(*) as cnt FROM test_items")
            expect(afterTruncate.rows[0].cnt).toBe("0")
        } finally {
            await client.query("ROLLBACK")
            client.release()
        }
    })

    test("version defaults to undefined", () => {
        const projection = rawSqlProjection({
            name: "no-version",
            canHandle: Query.fromItems([{ types: ["A"] }]),
            evolve: async () => {}
        })
        expect(projection.version).toBeUndefined()
    })

    test("version is passed through", () => {
        const projection = rawSqlProjection({
            name: "with-version",
            version: 3,
            canHandle: Query.fromItems([{ types: ["A"] }]),
            evolve: async () => {}
        })
        expect(projection.version).toBe(3)
    })
})

describe("projectionToProcessor", () => {
    let pool: Pool
    let store: PostgresEventStore
    const TABLE = "_handler_bookmarks"

    beforeAll(async () => {
        pool = await getTestPgDatabasePool({ max: 20 })
        store = new PostgresEventStore({ pool })
        await store.ensureInstalled()
    })

    afterEach(async () => {
        await pool.query("TRUNCATE table events")
        await pool.query("ALTER SEQUENCE events_sequence_position_seq RESTART WITH 1")
        await pool.query("DELETE FROM _handler_bookmarks")
        await pool.query("DROP TABLE IF EXISTS proj_test_counts")
    })

    afterAll(async () => {
        if (pool) await pool.end()
    })

    test("creates a working ConsumerProcessorConfig", async () => {
        const HANDLER = "proj-adapter-test"
        await ensureHandlersInstalled(pool, [HANDLER], TABLE)

        const processed: string[] = []

        const projection = rawSqlProjection({
            name: HANDLER,
            canHandle: Query.fromItems([{ types: ["Evt"] }]),
            evolve: async event => {
                processed.push(event.event.type)
            }
        })

        const config = projectionToProcessor(projection, { stopAfter: 2 })

        await store.append({ events: event("Evt") })
        await store.append({ events: event("Evt") })

        const consumer = createConsumer({
            pool,
            eventStore: store,
            processors: [config]
        })

        await Promise.all(consumer.processors.map(p => p.promise))
        expect(processed).toEqual(["Evt", "Evt"])
    })

    test("end-to-end: append events → consumer with projection → read model populated", async () => {
        const HANDLER = "proj-e2e-test"
        await ensureHandlersInstalled(pool, [HANDLER], TABLE)

        const projection = rawSqlProjection({
            name: HANDLER,
            canHandle: Query.fromItems([{ types: ["CountEvent"] }]),
            init: async client => {
                await client.query(`
                    CREATE TABLE IF NOT EXISTS proj_test_counts (
                        key TEXT PRIMARY KEY,
                        count INTEGER NOT NULL DEFAULT 0
                    )
                `)
            },
            evolve: async (event, client) => {
                const key = (event.event.data as { key: string }).key
                await client.query(
                    `INSERT INTO proj_test_counts (key, count) VALUES ($1, 1)
                     ON CONFLICT (key) DO UPDATE SET count = proj_test_counts.count + 1`,
                    [key]
                )
            }
        })

        // Init tables outside the consumer
        const initClient = await pool.connect()
        try {
            await projection.init!(initClient)
        } finally {
            initClient.release()
        }

        await store.append({ events: event("CountEvent", { key: "a" }) })
        await store.append({ events: event("CountEvent", { key: "a" }) })
        await store.append({ events: event("CountEvent", { key: "b" }) })

        const config = projectionToProcessor(projection, { stopAfter: 3 })

        const consumer = createConsumer({
            pool,
            eventStore: store,
            processors: [config]
        })

        await Promise.all(consumer.processors.map(p => p.promise))

        const result = await pool.query("SELECT key, count FROM proj_test_counts ORDER BY key")
        expect(result.rows).toEqual([
            { key: "a", count: 2 },
            { key: "b", count: 1 }
        ])
    })

    test("canHandle query is passed through to processor", async () => {
        const HANDLER = "proj-query-test"
        await ensureHandlersInstalled(pool, [HANDLER], TABLE)

        const processed: string[] = []

        const projection = rawSqlProjection({
            name: HANDLER,
            canHandle: Query.fromItems([{ types: ["Wanted"] }]),
            evolve: async event => {
                processed.push(event.event.type)
            }
        })

        // Append both wanted and unwanted events
        await store.append({ events: event("Wanted") })
        await store.append({ events: event("Unwanted") })
        await store.append({ events: event("Wanted") })

        const config = projectionToProcessor(projection, { stopAfter: 2 })

        const consumer = createConsumer({
            pool,
            eventStore: store,
            processors: [config]
        })

        await Promise.all(consumer.processors.map(p => p.promise))

        // Only "Wanted" events should have been processed
        expect(processed).toEqual(["Wanted", "Wanted"])
    })

    test("adapter passes through options", () => {
        const projection = rawSqlProjection({
            name: "opts-test",
            canHandle: Query.fromItems([{ types: ["A"] }]),
            evolve: async () => {}
        })

        const config = projectionToProcessor(projection, {
            pollIntervalMs: 200,
            startFrom: "CURRENT",
            stopAfter: 10,
            batchSize: 50
        })

        expect(config.processorName).toBe("opts-test")
        expect(config.pollIntervalMs).toBe(200)
        expect(config.startFrom).toBe("CURRENT")
        expect(config.stopAfter).toBe(10)
        expect(config.batchSize).toBe(50)
    })
})
