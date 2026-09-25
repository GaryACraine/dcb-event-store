import { Pool } from "pg"
import {
    AnyEvent,
    TaggedEvent,
    SequencePosition,
    Tags,
    WaitTimeoutError as CoreWaitTimeoutError
} from "@dcb-es/event-store"
import { PostgresEventStore } from "../eventStore/PostgresEventStore.js"
import { runHandler } from "./runHandler.js"
import { waitUntilProcessed } from "./waitUntilProcessed.js"
import { WaitTimeoutError } from "./WaitTimeoutError.js"
import { ensureHandlersInstalled } from "./ensureHandlersInstalled.js"
import { getTestPgDatabasePool } from "@test/testPgDbPool"
import { trackConnections, mostListeners } from "@test/trackConnections"

const event = (type: string): TaggedEvent<AnyEvent> => ({
    event: { type, data: {} } as AnyEvent,
    tags: Tags.fromObj({ e: "1" })
})

const HANDLER = "TestHandler"

describe("waitUntilProcessed", () => {
    let pool: Pool
    let store: PostgresEventStore

    beforeAll(async () => {
        pool = await getTestPgDatabasePool({ max: 20 })
        store = new PostgresEventStore({ pool })
        await store.ensureInstalled()
        await ensureHandlersInstalled(pool, [HANDLER], "_handler_bookmarks")
    })

    afterEach(async () => {
        await pool.query("TRUNCATE table events")
        await pool.query("ALTER SEQUENCE events_sequence_position_seq RESTART WITH 1")
        await pool.query("UPDATE _handler_bookmarks SET last_sequence_position = 0")
    })

    afterAll(async () => {
        if (pool) await pool.end()
    })

    test("returns immediately when bookmark already past position", async () => {
        // Manually set bookmark ahead
        await pool.query("UPDATE _handler_bookmarks SET last_sequence_position = 10 WHERE handler_id = $1", [HANDLER])

        const start = Date.now()
        await waitUntilProcessed(pool, HANDLER, SequencePosition.fromString("5"))
        expect(Date.now() - start).toBeLessThan(100)
    })

    test("waits and returns when handler advances bookmark", async () => {
        const controller = new AbortController()

        // Start handler in background
        const { promise } = runHandler({
            pool,
            eventStore: store,
            handlerName: HANDLER,
            handlerFactory: () => ({
                when: {
                    Evt: async () => {}
                }
            }),
            signal: controller.signal
        })

        // Append event
        const position = await store.append({ events: event("Evt") })

        // Wait for handler to process it
        await waitUntilProcessed(pool, HANDLER, position)

        // Verify bookmark advanced
        const bookmark = await pool.query(
            "SELECT last_sequence_position FROM _handler_bookmarks WHERE handler_id = $1",
            [HANDLER]
        )
        expect(Number(bookmark.rows[0].last_sequence_position)).toBe(1)

        controller.abort()
        await promise.catch(() => {})
    })

    test("throws WaitTimeoutError on timeout", async () => {
        await store.append({ events: event("Evt") })

        // No handler running — bookmark stays at 0
        await expect(
            waitUntilProcessed(pool, HANDLER, SequencePosition.fromString("1"), { timeoutMs: 200 })
        ).rejects.toThrow(WaitTimeoutError)
    })

    test("works with concurrent waiters on different positions", async () => {
        const controller = new AbortController()

        const { promise } = runHandler({
            pool,
            eventStore: store,
            handlerName: HANDLER,
            handlerFactory: () => ({
                when: {
                    Evt: async () => {}
                }
            }),
            signal: controller.signal
        })

        const pos1 = await store.append({ events: event("Evt") })
        const pos2 = await store.append({ events: event("Evt") })

        // Both should resolve
        await Promise.all([waitUntilProcessed(pool, HANDLER, pos1), waitUntilProcessed(pool, HANDLER, pos2)])

        controller.abort()
        await promise.catch(() => {})
    })

    describe("listeners (phase 18, Emmett PR #405's lesson)", () => {
        test("a long wait holds one notification listener and gives no MaxListeners warning", async () => {
            const clients = trackConnections(pool)
            const warnings: string[] = []
            const onWarning = (w: Error) => warnings.push(w.name)
            process.on("warning", onWarning)
            let most = 0
            const sampler = setInterval(() => (most = Math.max(most, mostListeners(clients, "notification"))), 20)
            try {
                // 1.5 s in the slow path is ~14 of its 100 ms waits.
                await expect(
                    waitUntilProcessed(pool, HANDLER, SequencePosition.fromString("1"), { timeoutMs: 1500 })
                ).rejects.toThrow(WaitTimeoutError)
            } finally {
                clearInterval(sampler)
                process.off("warning", onWarning)
            }

            expect(most).toBeLessThanOrEqual(1)
            expect(mostListeners(clients, "notification")).toBe(0)
            expect(warnings).not.toContain("MaxListenersExceededWarning")
        })

        test("another handler's notifications don't end the wait", async () => {
            // A busy system notifies for every processor; only this handler's bookmark matters.
            const done = waitUntilProcessed(pool, HANDLER, SequencePosition.fromString("5"), { timeoutMs: 600 })
            const noise = setInterval(() => {
                void pool.query("SELECT pg_notify('_handler_bookmarks', 'OtherHandler:9')").catch(() => {})
            }, 10)
            try {
                await expect(done).rejects.toThrow(WaitTimeoutError)
            } finally {
                clearInterval(noise)
            }
        })

        test("this handler's notification ends the wait without waiting out the poll", async () => {
            const done = waitUntilProcessed(pool, HANDLER, SequencePosition.fromString("5"), { timeoutMs: 3000 })
            await new Promise(r => setTimeout(r, 300))
            await pool.query("UPDATE _handler_bookmarks SET last_sequence_position = 5 WHERE handler_id = $1", [
                HANDLER
            ])
            const start = Date.now()
            await pool.query(`SELECT pg_notify('_handler_bookmarks', '${HANDLER}:5')`)
            await done

            expect(Date.now() - start).toBeLessThan(90)
        })
    })

    test("the timeout is the core WaitTimeoutError, a 504", async () => {
        const err = await waitUntilProcessed(pool, HANDLER, SequencePosition.fromString("1"), { timeoutMs: 50 }).catch(
            (e: unknown) => e
        )
        expect(err).toBeInstanceOf(CoreWaitTimeoutError)
        expect(err).toMatchObject({ name: "WaitTimeoutError", status: 504, code: "WAIT_TIMEOUT" })
    })
})
