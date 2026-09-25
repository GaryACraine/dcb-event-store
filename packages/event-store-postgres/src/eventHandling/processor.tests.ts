import { Pool } from "pg"
import { AnyEvent, TaggedEvent, Tags } from "@dcb-es/event-store"
import { PostgresEventStore } from "../eventStore/PostgresEventStore.js"
import { ensureHandlersInstalled } from "./ensureHandlersInstalled.js"
import { createProcessor } from "./processor.js"
import { waitUntilProcessed } from "./waitUntilProcessed.js"
import { getTestPgDatabasePool } from "@test/testPgDbPool"

const event = (type: string, tags: Tags = Tags.fromObj({ e: "1" }), data: unknown = {}): TaggedEvent<AnyEvent> => ({
    event: { type, data } as AnyEvent,
    tags
})

describe("processor", () => {
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

    test("processes historical events and advances bookmark", async () => {
        const HANDLER = "proc-historical"
        await ensureHandlersInstalled(pool, [HANDLER], TABLE)

        await store.append({ events: event("A") })
        await store.append({ events: event("B") })

        const processed: string[] = []

        const { promise } = createProcessor({
            pool,
            eventStore: store,
            processorName: HANDLER,
            handlerFactory: () => ({
                when: {
                    A: async ({ event: { type } }: { event: { type: string } }) => {
                        processed.push(type)
                    },
                    B: async ({ event: { type } }: { event: { type: string } }) => {
                        processed.push(type)
                    }
                }
            }),
            stopAfter: 2
        })

        await promise
        expect(processed).toEqual(["A", "B"])

        const bookmark = await pool.query(`SELECT last_sequence_position FROM ${TABLE} WHERE handler_id = $1`, [
            HANDLER
        ])
        expect(Number(bookmark.rows[0].last_sequence_position)).toBe(2)
    })

    test("processes live events via NOTIFY wakeup", async () => {
        const HANDLER = "proc-live"
        await ensureHandlersInstalled(pool, [HANDLER], TABLE)

        const processed: string[] = []
        const controller = new AbortController()

        const { promise } = createProcessor({
            pool,
            eventStore: store,
            processorName: HANDLER,
            handlerFactory: () => ({
                when: {
                    Live: async ({ event: { type } }: { event: { type: string } }) => {
                        processed.push(type)
                        if (processed.length >= 2) controller.abort()
                    }
                }
            }),
            signal: controller.signal,
            pollIntervalMs: 50
        })

        // Append events after processor is running
        await new Promise(r => setTimeout(r, 50))
        await store.append({ events: event("Live") })
        await store.append({ events: event("Live") })

        await promise
        expect(processed).toEqual(["Live", "Live"])
    })

    test("restart resumes from stored checkpoint (no reprocessing)", async () => {
        const HANDLER = "proc-resume"
        await ensureHandlersInstalled(pool, [HANDLER], TABLE)

        await store.append({ events: event("First") })

        // First run: process one event
        const { promise: p1 } = createProcessor({
            pool,
            eventStore: store,
            processorName: HANDLER,
            handlerFactory: () => ({
                when: {
                    First: async () => {}
                }
            }),
            stopAfter: 1
        })
        await p1

        // Append another event
        await store.append({ events: event("Second") })

        // Second run: should only see Second
        const processed: string[] = []
        const { promise: p2 } = createProcessor({
            pool,
            eventStore: store,
            processorName: HANDLER,
            handlerFactory: () => ({
                when: {
                    First: async () => {
                        processed.push("First")
                    },
                    Second: async () => {
                        processed.push("Second")
                    }
                }
            }),
            stopAfter: 1
        })
        await p2
        expect(processed).toEqual(["Second"])
    })

    test("batching: 50 events with batchSize=10 → all 50 processed", async () => {
        const HANDLER = "proc-batch"
        await ensureHandlersInstalled(pool, [HANDLER], TABLE)

        for (let i = 0; i < 50; i++) {
            await store.append({ events: event("Evt") })
        }

        let count = 0
        const { promise } = createProcessor({
            pool,
            eventStore: store,
            processorName: HANDLER,
            handlerFactory: () => ({
                when: {
                    Evt: async () => {
                        count++
                    }
                }
            }),
            batchSize: 10,
            stopAfter: 50
        })

        await promise
        expect(count).toBe(50)
    })

    test("handler error → bookmark does not advance, promise rejects", async () => {
        const HANDLER = "proc-error"
        await ensureHandlersInstalled(pool, [HANDLER], TABLE)

        await store.append({ events: event("Boom") })

        const { promise } = createProcessor({
            pool,
            eventStore: store,
            processorName: HANDLER,
            handlerFactory: () => ({
                when: {
                    Boom: async () => {
                        throw new Error("handler exploded")
                    }
                }
            })
        })

        await expect(promise).rejects.toThrow("handler exploded")

        const bookmark = await pool.query(`SELECT last_sequence_position FROM ${TABLE} WHERE handler_id = $1`, [
            HANDLER
        ])
        expect(Number(bookmark.rows[0].last_sequence_position)).toBe(0)
    })

    test("stopAfter(3): processes exactly 3 events then resolves", async () => {
        const HANDLER = "proc-stop-after"
        await ensureHandlersInstalled(pool, [HANDLER], TABLE)

        for (let i = 0; i < 10; i++) {
            await store.append({ events: event("Evt") })
        }

        let count = 0
        const { promise } = createProcessor({
            pool,
            eventStore: store,
            processorName: HANDLER,
            handlerFactory: () => ({
                when: {
                    Evt: async () => {
                        count++
                    }
                }
            }),
            stopAfter: 3
        })

        await promise
        expect(count).toBe(3)
    })

    test("abort signal: stops cleanly after current event", async () => {
        const HANDLER = "proc-abort"
        await ensureHandlersInstalled(pool, [HANDLER], TABLE)

        await store.append({ events: event("A") })
        await store.append({ events: event("B") })

        const processed: string[] = []
        const controller = new AbortController()

        const { promise } = createProcessor({
            pool,
            eventStore: store,
            processorName: HANDLER,
            handlerFactory: () => ({
                when: {
                    A: async ({ event: { type } }: { event: { type: string } }) => {
                        processed.push(type)
                        controller.abort()
                    },
                    B: async ({ event: { type } }: { event: { type: string } }) => {
                        processed.push(type)
                    }
                }
            }),
            signal: controller.signal
        })

        await promise
        // Should have processed A, then stopped (B may or may not be processed
        // depending on timing, but A should definitely be there)
        expect(processed).toContain("A")
    })

    test('startFrom("BEGINNING"): processes all events from position 0', async () => {
        const HANDLER = "proc-beginning"
        await ensureHandlersInstalled(pool, [HANDLER], TABLE)

        await store.append({ events: event("A") })
        await store.append({ events: event("B") })

        const processed: string[] = []
        const { promise } = createProcessor({
            pool,
            eventStore: store,
            processorName: HANDLER,
            handlerFactory: () => ({
                when: {
                    A: async () => {
                        processed.push("A")
                    },
                    B: async () => {
                        processed.push("B")
                    }
                }
            }),
            startFrom: "BEGINNING",
            stopAfter: 2
        })

        await promise
        expect(processed).toEqual(["A", "B"])
    })

    test('startFrom("CURRENT") with empty store: only processes new events', async () => {
        const HANDLER = "proc-current-empty"
        await ensureHandlersInstalled(pool, [HANDLER], TABLE)

        const processed: string[] = []
        const controller = new AbortController()

        const { promise } = createProcessor({
            pool,
            eventStore: store,
            processorName: HANDLER,
            handlerFactory: () => ({
                when: {
                    New: async () => {
                        processed.push("New")
                        controller.abort()
                    }
                }
            }),
            startFrom: "CURRENT",
            signal: controller.signal,
            pollIntervalMs: 50
        })

        // Append after processor is running
        await new Promise(r => setTimeout(r, 100))
        await store.append({ events: event("New") })

        await promise
        expect(processed).toEqual(["New"])
    })

    test('startFrom("CURRENT") with existing events: skips them, processes new', async () => {
        const HANDLER = "proc-current-existing"
        await ensureHandlersInstalled(pool, [HANDLER], TABLE)

        // Pre-existing events
        await store.append({ events: event("Old") })
        await store.append({ events: event("Old") })

        const processed: string[] = []
        const controller = new AbortController()

        const { promise } = createProcessor({
            pool,
            eventStore: store,
            processorName: HANDLER,
            handlerFactory: () => ({
                when: {
                    Old: async () => {
                        processed.push("Old")
                    },
                    New: async () => {
                        processed.push("New")
                        controller.abort()
                    }
                }
            }),
            startFrom: "CURRENT",
            signal: controller.signal,
            pollIntervalMs: 50
        })

        // Append new event after processor starts
        await new Promise(r => setTimeout(r, 100))
        await store.append({ events: event("New") })

        await promise
        expect(processed).toEqual(["New"])
    })

    test("two instances: second rejects (lock not acquired)", async () => {
        const HANDLER = "proc-exclusive"
        await ensureHandlersInstalled(pool, [HANDLER], TABLE)

        const controller = new AbortController()

        const first = createProcessor({
            pool,
            eventStore: store,
            processorName: HANDLER,
            handlerFactory: () => ({ when: { Evt: async () => {} } }),
            signal: controller.signal,
            pollIntervalMs: 50
        })

        // Give first processor time to acquire lock
        await new Promise(r => setTimeout(r, 100))

        const second = createProcessor({
            pool,
            eventStore: store,
            processorName: HANDLER,
            handlerFactory: () => ({ when: { Evt: async () => {} } }),
            pollIntervalMs: 50
        })

        await expect(second.promise).rejects.toThrow("Processor lock not acquired")

        controller.abort()
        await first.promise
    })

    test("after first stops, second acquires lock and resumes from checkpoint", async () => {
        const HANDLER = "proc-handoff"
        await ensureHandlersInstalled(pool, [HANDLER], TABLE)

        await store.append({ events: event("A") })

        // First processor: process one event then stop
        const { promise: p1 } = createProcessor({
            pool,
            eventStore: store,
            processorName: HANDLER,
            handlerFactory: () => ({ when: { A: async () => {}, B: async () => {} } }),
            stopAfter: 1
        })
        await p1

        // Append more events
        await store.append({ events: event("B") })

        // Second processor: should pick up from checkpoint
        const processed: string[] = []
        const { promise: p2 } = createProcessor({
            pool,
            eventStore: store,
            processorName: HANDLER,
            handlerFactory: () => ({
                when: {
                    A: async () => {
                        processed.push("A")
                    },
                    B: async () => {
                        processed.push("B")
                    }
                }
            }),
            stopAfter: 1
        })
        await p2
        expect(processed).toEqual(["B"])
    })

    test("handler receives transaction client (projection writes are atomic)", async () => {
        const HANDLER = "proc-atomic"
        await ensureHandlersInstalled(pool, [HANDLER], TABLE)

        await store.append({ events: event("Counter") })

        const { promise } = createProcessor({
            pool,
            eventStore: store,
            processorName: HANDLER,
            handlerFactory: client => ({
                when: {
                    Counter: async () => {
                        await client.query("CREATE TABLE IF NOT EXISTS _proc_test_counter (n INT)")
                        await client.query("INSERT INTO _proc_test_counter VALUES (1)")
                    }
                }
            }),
            stopAfter: 1
        })

        await promise

        const counter = await pool.query("SELECT COUNT(*) as n FROM _proc_test_counter")
        expect(Number(counter.rows[0].n)).toBe(1)

        const bookmark = await pool.query(`SELECT last_sequence_position FROM ${TABLE} WHERE handler_id = $1`, [
            HANDLER
        ])
        expect(Number(bookmark.rows[0].last_sequence_position)).toBe(1)

        await pool.query("DROP TABLE IF EXISTS _proc_test_counter")
    })

    test("NOTIFY fires on each bookmark advance", async () => {
        const HANDLER = "proc-notify"
        await ensureHandlersInstalled(pool, [HANDLER], TABLE)

        await store.append({ events: event("A") })
        await store.append({ events: event("B") })

        const notifications: string[] = []
        const listener = await pool.connect()
        await listener.query(`LISTEN ${TABLE}`)
        listener.on("notification", msg => {
            if (msg.payload) notifications.push(msg.payload)
        })

        const { promise } = createProcessor({
            pool,
            eventStore: store,
            processorName: HANDLER,
            handlerFactory: () => ({
                when: {
                    A: async () => {},
                    B: async () => {}
                }
            }),
            stopAfter: 2
        })

        await promise

        // Give notifications time to arrive
        await new Promise(r => setTimeout(r, 50))

        await listener.query(`UNLISTEN ${TABLE}`)
        listener.release()

        expect(notifications.length).toBe(2)
        expect(notifications[0]).toBe(`${HANDLER}:1`)
        expect(notifications[1]).toBe(`${HANDLER}:2`)
    })

    test("instance_id and version written to bookmark table", async () => {
        const HANDLER = "proc-metadata"
        await ensureHandlersInstalled(pool, [HANDLER], TABLE)

        await store.append({ events: event("A") })

        const myInstanceId = "test-instance-123"
        const { promise } = createProcessor({
            pool,
            eventStore: store,
            processorName: HANDLER,
            handlerFactory: () => ({
                when: { A: async () => {} }
            }),
            instanceId: myInstanceId,
            stopAfter: 1
        })

        await promise

        const result = await pool.query(`SELECT version, instance_id FROM ${TABLE} WHERE handler_id = $1`, [HANDLER])
        expect(Number(result.rows[0].version)).toBe(2) // initial 1 + 1 event
        expect(result.rows[0].instance_id).toBe(myInstanceId)
    })

    describe("the checkpoint means 'has seen everything up to X' (phase 18)", () => {
        // Emmett stores a processor's checkpoint at the last message it read, whether it handled it or not. Our
        // processor reads only the events it handles, so without `onCaughtUp` its checkpoint stayed on the last one
        // it handled, and a read-your-writes wait on any later position timed out.
        const bookmark = async (handler: string) =>
            Number(
                (await pool.query(`SELECT last_sequence_position FROM ${TABLE} WHERE handler_id = $1`, [handler]))
                    .rows[0].last_sequence_position
            )
        const onlyA =
            (seen: string[] = []) =>
            () => ({
                when: {
                    A: async ({ position }: { position: { toString(): string } }) => {
                        seen.push(position.toString())
                    }
                }
            })

        test("unrelated events move the checkpoint, and a wait on their position returns at once", async () => {
            const HANDLER = "proc-caught-up"
            await ensureHandlersInstalled(pool, [HANDLER], TABLE)
            const controller = new AbortController()
            const { promise } = createProcessor({
                pool,
                eventStore: store,
                processorName: HANDLER,
                handlerFactory: onlyA(),
                pollIntervalMs: 20,
                signal: controller.signal
            })

            await store.append({ events: event("B") })
            const position = await store.append({ events: event("B") })
            const start = Date.now()
            await waitUntilProcessed(pool, HANDLER, position, { timeoutMs: 2000 })
            const waited = Date.now() - start

            controller.abort()
            await promise
            expect(waited).toBeLessThan(1000)
            expect(await bookmark(HANDLER)).toBe(2)
        })

        test("a handled event is processed before the checkpoint passes it", async () => {
            const HANDLER = "proc-caught-up-order"
            await ensureHandlersInstalled(pool, [HANDLER], TABLE)
            const bookmarkWhileHandling: number[] = []
            const controller = new AbortController()
            const { promise } = createProcessor({
                pool,
                eventStore: store,
                processorName: HANDLER,
                handlerFactory: () => ({
                    when: {
                        A: async () => {
                            bookmarkWhileHandling.push(await bookmark(HANDLER))
                            await new Promise(r => setTimeout(r, 100))
                        }
                    }
                }),
                pollIntervalMs: 20,
                signal: controller.signal
            })

            await store.append({ events: event("B") })
            await store.append({ events: event("A") })
            const last = await store.append({ events: event("B") })
            await waitUntilProcessed(pool, HANDLER, last, { timeoutMs: 3000 })

            controller.abort()
            await promise
            // When A (at 2) was handled, the checkpoint was at most 1.
            expect(bookmarkWhileHandling.length).toBe(1)
            expect(bookmarkWhileHandling[0]).toBeLessThan(2)
            expect(await bookmark(HANDLER)).toBe(3)
        })

        test("a restart resumes from the advanced checkpoint and handles only what's new", async () => {
            const HANDLER = "proc-caught-up-restart"
            await ensureHandlersInstalled(pool, [HANDLER], TABLE)
            const first: string[] = []
            const controller1 = new AbortController()
            const p1 = createProcessor({
                pool,
                eventStore: store,
                processorName: HANDLER,
                handlerFactory: onlyA(first),
                pollIntervalMs: 20,
                signal: controller1.signal
            })
            await store.append({ events: event("A") })
            const b = await store.append({ events: event("B") })
            await waitUntilProcessed(pool, HANDLER, b, { timeoutMs: 2000 })
            controller1.abort()
            await p1.promise

            await store.append({ events: event("A") })
            const second: string[] = []
            const p2 = createProcessor({
                pool,
                eventStore: store,
                processorName: HANDLER,
                handlerFactory: onlyA(second),
                stopAfter: 1
            })
            await p2.promise

            expect(first).toEqual(["1"])
            expect(second).toEqual(["3"])
        })

        test("each advance notifies waiters", async () => {
            const HANDLER = "proc-caught-up-notify"
            await ensureHandlersInstalled(pool, [HANDLER], TABLE)
            const listener = await pool.connect()
            const notifications: string[] = []
            listener.on("notification", msg => {
                if (msg.payload?.startsWith(`${HANDLER}:`)) notifications.push(msg.payload)
            })
            await listener.query(`LISTEN ${TABLE}`)
            const controller = new AbortController()
            const { promise } = createProcessor({
                pool,
                eventStore: store,
                processorName: HANDLER,
                handlerFactory: onlyA(),
                pollIntervalMs: 20,
                signal: controller.signal
            })
            try {
                const b = await store.append({ events: event("B") })
                await waitUntilProcessed(pool, HANDLER, b, { timeoutMs: 2000 })
                await new Promise(r => setTimeout(r, 100))
            } finally {
                controller.abort()
                await promise
                await listener.query(`UNLISTEN ${TABLE}`)
                listener.release()
            }
            expect(notifications).toEqual([`${HANDLER}:1`])
        })

        test("a checkpoint moved by another instance stops the processor when it next advances", async () => {
            const HANDLER = "proc-caught-up-mismatch"
            await ensureHandlersInstalled(pool, [HANDLER], TABLE)
            const { promise } = createProcessor({
                pool,
                eventStore: store,
                processorName: HANDLER,
                handlerFactory: onlyA(),
                pollIntervalMs: 20
            })
            await new Promise(r => setTimeout(r, 50))
            await pool.query(`UPDATE ${TABLE} SET version = version + 10 WHERE handler_id = $1`, [HANDLER])
            await store.append({ events: event("B") })

            await expect(promise).rejects.toThrow(/version mismatch/)
        })
    })
})
