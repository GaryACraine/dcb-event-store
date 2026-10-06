import { Pool } from "pg"
import { AnyEvent, Query, SequencePosition, SequencedEvent, TaggedEvent, Tags } from "@dcb-es/event-store"
import { getTestPgDatabasePool } from "@test/testPgDbPool"
import { collectUncaught, waitFor } from "@test/waitFor"
import { PostgresEventStore } from "./PostgresEventStore.js"
import { NotificationListener } from "./notificationListener.js"
import { ensureHandlersInstalled } from "../eventHandling/ensureHandlersInstalled.js"
import { waitUntilProcessed } from "../eventHandling/waitUntilProcessed.js"

const event = (type: string): TaggedEvent<AnyEvent> => ({
    event: { type, data: {} } as AnyEvent,
    tags: Tags.fromObj({ e: "1" })
})
const checkedOut = (pool: Pool) => pool.totalCount - pool.idleCount
const silent = { warn: () => {} }

// The backends LISTENing in this test's database (their last statement was a LISTEN).
const listeners = async (pool: Pool): Promise<number[]> =>
    (
        await pool.query(
            "SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND query ILIKE 'LISTEN%' AND state = 'idle'"
        )
    ).rows.map(r => r.pid)

describe("NotificationListener (phase 20)", () => {
    let pool: Pool
    let store: PostgresEventStore

    beforeEach(async () => {
        pool = await getTestPgDatabasePool({ max: 5 })
        store = new PostgresEventStore({
            pool,
            notificationListener: new NotificationListener(pool, {
                logger: silent,
                backoff: { initialMs: 50, maxMs: 200 }
            })
        })
        await store.ensureInstalled()
    })

    afterEach(async () => {
        await pool.end()
    })

    test("100 subscriptions share one connection, on a pool of 5", async () => {
        const controller = new AbortController()
        const received: SequencedEvent[][] = Array.from({ length: 100 }, () => [])
        const runs = received.map(async (into, i) => {
            for await (const ev of store.subscribe(Query.all(), { signal: controller.signal, pollIntervalMs: 50 + i }))
                into.push(ev)
        })

        await waitFor("every subscription to be listening", async () => (await listeners(pool)).length === 1)
        await store.append({ events: event("Shared") })
        await waitFor("every subscription to receive the event", () => received.every(r => r.length === 1))
        await waitFor("only the listener to stay checked out", () => checkedOut(pool) === 1)

        controller.abort()
        await Promise.all(runs)
        await waitFor("the listener's connection to go back to the pool", () => checkedOut(pool) === 0)
    })

    test("a lost listener: subscriptions poll meanwhile, then it reconnects", async () => {
        const uncaught = collectUncaught()
        const controller = new AbortController()
        const received: SequencedEvent[] = []
        const run = (async () => {
            for await (const ev of store.subscribe(Query.all(), { signal: controller.signal, pollIntervalMs: 50 }))
                received.push(ev)
        })()
        await waitFor("the subscription to be listening", async () => (await listeners(pool)).length === 1)
        const [first] = await listeners(pool)

        await pool.query("SELECT pg_terminate_backend($1)", [first])
        await store.append({ events: event("WhileDown") })
        await waitFor("the event to arrive", () => received.length === 1)
        await waitFor("a new listener", async () => {
            const now = await listeners(pool)
            return now.length === 1 && now[0] !== first
        })
        await store.append({ events: event("AfterReconnect") })
        await waitFor("the next event to arrive", () => received.length === 2)

        controller.abort()
        await run
        uncaught.stop()
        expect(uncaught.errors).toEqual([])
        expect(received.map(e => e.event.type)).toEqual(["WhileDown", "AfterReconnect"])
    })

    test("a handler is told when notifications may have been missed: on loss and on reconnect", async () => {
        const listener = new NotificationListener(pool, { logger: silent, backoff: { initialMs: 50, maxMs: 200 } })
        const payloads: (string | undefined)[] = []
        const stop = await listener.listen("phase20_test", p => payloads.push(p))
        await pool.query("SELECT pg_notify('phase20_test', 'hello')")
        await waitFor("the notification", () => payloads.includes("hello"))

        const [pid] = await listeners(pool)
        await pool.query("SELECT pg_terminate_backend($1)", [pid])
        await waitFor("a wake on loss and one on reconnect", () => payloads.filter(p => p === undefined).length >= 2)
        await pool.query("SELECT pg_notify('phase20_test', 'again')")
        await waitFor("notifications again after the reconnect", () => payloads.includes("again"))

        await stop()
        await waitFor("the connection to go back to the pool", () => checkedOut(pool) === 0)
    })

    test("waitUntilProcessed's slow path shares the store's listener", async () => {
        const handler = "phase20-waiter"
        await ensureHandlersInstalled(pool, [handler], "_handler_bookmarks")
        const target = SequencePosition.fromString("5")
        const waits = Array.from({ length: 20 }, () =>
            waitUntilProcessed(pool, handler, target, { timeoutMs: 5000, listener: store.notificationListener })
        )
        await waitFor("the waits to be listening", async () => (await listeners(pool)).length === 1)
        expect(checkedOut(pool)).toBeLessThanOrEqual(2)

        await pool.query("UPDATE _handler_bookmarks SET last_sequence_position = 5 WHERE handler_id = $1", [handler])
        await pool.query("SELECT pg_notify('_handler_bookmarks', $1)", [`${handler}:5`])
        await Promise.all(waits)
        await waitFor("the listener's connection to go back to the pool", () => checkedOut(pool) === 0)
    })
})
