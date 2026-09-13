import { Pool } from "pg"
import { DcbEvent, Tags } from "@dcb-es/event-store"
import { PostgresEventStore } from "../eventStore/PostgresEventStore.js"
import { ensureHandlersInstalled } from "./ensureHandlersInstalled.js"
import { createConsumer } from "./consumer.js"
import { getTestPgDatabasePool } from "@test/testPgDbPool"

const event = (type: string, tags: Tags = Tags.fromObj({ e: "1" })): DcbEvent => ({
    type,
    tags,
    data: {},
    metadata: {}
})

describe("consumer", () => {
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
    })

    afterAll(async () => {
        if (pool) await pool.end()
    })

    test("creates and starts multiple processors", async () => {
        const HANDLER_A = "consumer-proc-a"
        const HANDLER_B = "consumer-proc-b"
        await ensureHandlersInstalled(pool, [HANDLER_A, HANDLER_B], TABLE)

        await store.append({ events: event("Evt") })

        const processedA: string[] = []
        const processedB: string[] = []

        const consumer = createConsumer({
            pool,
            eventStore: store,
            processors: [
                {
                    processorName: HANDLER_A,
                    handlerFactory: () => ({
                        when: {
                            Evt: async () => {
                                processedA.push("A")
                            }
                        }
                    }),
                    stopAfter: 1
                },
                {
                    processorName: HANDLER_B,
                    handlerFactory: () => ({
                        when: {
                            Evt: async () => {
                                processedB.push("B")
                            }
                        }
                    }),
                    stopAfter: 1
                }
            ]
        })

        expect(consumer.processors.length).toBe(2)

        await Promise.all(consumer.processors.map(p => p.promise))
        expect(processedA).toEqual(["A"])
        expect(processedB).toEqual(["B"])
    })

    test("stop() aborts all processors and resolves when all done", async () => {
        const HANDLER_A = "consumer-stop-a"
        const HANDLER_B = "consumer-stop-b"
        await ensureHandlersInstalled(pool, [HANDLER_A, HANDLER_B], TABLE)

        const consumer = createConsumer({
            pool,
            eventStore: store,
            processors: [
                {
                    processorName: HANDLER_A,
                    handlerFactory: () => ({ when: { Evt: async () => {} } }),
                    pollIntervalMs: 50
                },
                {
                    processorName: HANDLER_B,
                    handlerFactory: () => ({ when: { Evt: async () => {} } }),
                    pollIntervalMs: 50
                }
            ]
        })

        // Give processors time to start
        await new Promise(r => setTimeout(r, 100))

        await consumer.stop()

        // All promises should be settled
        const results = await Promise.allSettled(consumer.processors.map(p => p.promise))
        expect(results.every(r => r.status === "fulfilled")).toBe(true)
    })

    test("error in one processor does not affect others", async () => {
        const HANDLER_GOOD = "consumer-good"
        const HANDLER_BAD = "consumer-bad"
        await ensureHandlersInstalled(pool, [HANDLER_GOOD, HANDLER_BAD], TABLE)

        await store.append({ events: event("Evt") })

        const processed: string[] = []

        const consumer = createConsumer({
            pool,
            eventStore: store,
            processors: [
                {
                    processorName: HANDLER_BAD,
                    handlerFactory: () => ({
                        when: {
                            Evt: async () => {
                                throw new Error("bad processor")
                            }
                        }
                    })
                },
                {
                    processorName: HANDLER_GOOD,
                    handlerFactory: () => ({
                        when: {
                            Evt: async () => {
                                processed.push("good")
                            }
                        }
                    }),
                    stopAfter: 1
                }
            ]
        })

        const results = await Promise.allSettled(consumer.processors.map(p => p.promise))

        // Bad processor should reject
        expect(results[0].status).toBe("rejected")
        // Good processor should resolve
        expect(results[1].status).toBe("fulfilled")
        expect(processed).toEqual(["good"])
    })

    test("empty processors array throws", () => {
        expect(() =>
            createConsumer({
                pool,
                eventStore: store,
                processors: []
            })
        ).toThrow("Consumer requires at least one processor configuration")
    })

    test("stop() is idempotent (second call resolves immediately)", async () => {
        const HANDLER = "consumer-idempotent-stop"
        await ensureHandlersInstalled(pool, [HANDLER], TABLE)

        const consumer = createConsumer({
            pool,
            eventStore: store,
            processors: [
                {
                    processorName: HANDLER,
                    handlerFactory: () => ({ when: { Evt: async () => {} } }),
                    pollIntervalMs: 50
                }
            ]
        })

        await new Promise(r => setTimeout(r, 50))

        await consumer.stop()
        // Second stop should not throw or hang
        await consumer.stop()
    })
})
