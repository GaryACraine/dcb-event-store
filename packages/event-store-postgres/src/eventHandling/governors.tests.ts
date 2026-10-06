import { Pool } from "pg"
import { AnyEvent, Query, SequencedEvent, TaggedEvent, Tags } from "@dcb-es/event-store"
import { getTestPgDatabasePool } from "@test/testPgDbPool"
import { waitFor } from "@test/waitFor"
import { PostgresEventStore } from "../eventStore/PostgresEventStore.js"
import { NotificationListener } from "../eventStore/notificationListener.js"
import { ensureHandlersInstalled } from "./ensureHandlersInstalled.js"
import { createConsumer, ConsumerOnHandlerError, RunningConsumer } from "./consumer.js"

const event = (type: string): TaggedEvent<AnyEvent> => ({
    event: { type, data: {} } as AnyEvent,
    tags: Tags.fromObj({ e: "1" })
})
const quiet = { error: () => {}, warn: () => {} }
const names = (n: number) => Array.from({ length: n }, (_, i) => `gov-${i}`)

/** The most connections checked out of `pool` at once, from now on (pg's `acquire` and `release` events). */
function peakCheckedOut(pool: Pool): { peak: () => number } {
    let now = pool.totalCount - pool.idleCount
    let peak = now
    pool.on("acquire", () => (peak = Math.max(peak, ++now)))
    pool.on("release", () => now--)
    return { peak: () => peak }
}

/**
 * Marten-style governors (phase 21): a store caps its subscriptions' concurrent reads, and a consumer its processors'
 * concurrent handling, so the connections they borrow at once stop growing with the number of processors.
 */
describe("concurrency governors (phase 21)", () => {
    let pool: Pool

    afterEach(async () => {
        await pool.end()
    })

    async function setUp(max: number, processorNames: string[], caps: { reads?: number; handling?: number }) {
        pool = await getTestPgDatabasePool({ max })
        const store = new PostgresEventStore({
            pool,
            maxConcurrentSubscriptionReads: caps.reads,
            notificationListener: new NotificationListener(pool, { logger: quiet })
        })
        await store.ensureInstalled()
        await ensureHandlersInstalled(pool, processorNames, "_handler_bookmarks")
        await pool.query("CREATE TABLE handled (processor TEXT, position BIGINT, PRIMARY KEY (processor, position))")
        return store
    }

    // Each handler borrows a second connection inside its transaction, as an automation's command does.
    function consumerOf(
        store: PostgresEventStore,
        processorNames: string[],
        handling: number | undefined,
        onError?: (name: string) => ConsumerOnHandlerError | undefined,
        active?: { now: number; peak: number }
    ): RunningConsumer {
        return createConsumer({
            pool,
            eventStore: store,
            logger: quiet,
            maxConcurrentHandling: handling,
            processors: processorNames.map(processorName => ({
                processorName,
                pollIntervalMs: 50,
                backoff: { initialMs: 20, maxMs: 50 },
                onError: onError?.(processorName),
                handlerFactory: client => ({
                    when: {
                        Evt: async ({ position }: SequencedEvent) => {
                            if (active) active.peak = Math.max(active.peak, ++active.now)
                            try {
                                if (processorName === "gov-broken") throw new Error("always fails")
                                await pool.query("SELECT 1")
                                await client.query("INSERT INTO handled VALUES ($1, $2)", [
                                    processorName,
                                    position.toString()
                                ])
                            } finally {
                                if (active) active.now--
                            }
                        }
                    }
                })
            }))
        })
    }

    const handled = async () => Number((await pool.query("SELECT count(*) AS n FROM handled")).rows[0].n)
    const running = (c: RunningConsumer) => c.status().every(s => s.state === "running")

    test("with the caps, 30 processors handling a burst borrow at most 2 + 4 reads + 4 handling + 4 nested", async () => {
        const all = names(30)
        const store = await setUp(60, all, { reads: 4 })
        const active = { now: 0, peak: 0 }
        const consumer = consumerOf(store, all, 4, undefined, active)
        await waitFor("every processor running", () => running(consumer))

        const connections = peakCheckedOut(pool)
        await store.append({ events: [event("Evt"), event("Evt"), event("Evt"), event("Evt"), event("Evt")] })
        await waitFor("every processor to handle the burst", async () => (await handled()) === 30 * 5, 20_000)
        await consumer.stop()

        expect(active.peak).toBeLessThanOrEqual(4)
        // + 1 for this test's own count query
        expect(connections.peak()).toBeLessThanOrEqual(2 + 4 + 4 + 4 + 1)
    })

    test("without the caps, the same burst borrows about one connection per processor (what phase 21 fixes)", async () => {
        const all = names(30)
        const store = await setUp(80, all, { reads: Infinity })
        const consumer = consumerOf(store, all, Infinity)
        await waitFor("every processor running", () => running(consumer))

        const connections = peakCheckedOut(pool)
        await store.append({ events: [event("Evt"), event("Evt"), event("Evt"), event("Evt"), event("Evt")] })
        await waitFor("every processor to handle the burst", async () => (await handled()) === 30 * 5, 20_000)
        await consumer.stop()

        expect(connections.peak()).toBeGreaterThan(2 + 4 + 4 + 4 + 1)
    })

    test("no deadlock on a pool of 2 + 4 + 4 + 1, with every handler borrowing a second connection", async () => {
        const all = names(30)
        const store = await setUp(2 + 4 + 4 + 1, all, { reads: 4 })
        const consumer = consumerOf(store, all, 4)
        await waitFor("every processor running", () => running(consumer))

        await store.append({ events: [event("Evt"), event("Evt"), event("Evt")] })
        await waitFor("every processor to handle every event", async () => (await handled()) === 30 * 3, 20_000)
        await consumer.stop()
    })

    test("a blocked processor holds no turn while it waits to retry, so the others carry on", async () => {
        const all = [...names(5), "gov-broken"]
        const store = await setUp(20, all, { reads: 4 })
        const consumer = consumerOf(store, all, 1, () => "retry")
        await waitFor("the processors running", () => consumer.status().length === 6)

        await store.append({ events: [event("Evt"), event("Evt"), event("Evt")] })
        await waitFor("the broken processor to be blocked", () =>
            consumer.status().some(s => s.processorName === "gov-broken" && s.state === "blocked")
        )
        await waitFor(
            "the five others to handle every event, one turn at a time",
            async () => (await handled()) === 5 * 3
        )
        await consumer.stop()
    })

    test("a store caps its subscriptions' reads: 50 subscriptions borrow at most 2 at once", async () => {
        const store = await setUp(60, [], { reads: 2 })
        const controller = new AbortController()
        const received: number[] = Array(50).fill(0)
        const runs = received.map(async (_, i) => {
            for await (const ev of store.subscribe(Query.all(), { signal: controller.signal, pollIntervalMs: 1000 })) {
                if (ev) received[i]++
            }
        })
        await waitFor("every subscription to be idle", () => pool.totalCount - pool.idleCount <= 1)

        const connections = peakCheckedOut(pool)
        await store.append({ events: event("Shared") })
        await waitFor("every subscription to receive the event", () => received.every(n => n === 1))
        controller.abort()
        await Promise.all(runs)

        // the listener, 2 reads, and the append
        expect(connections.peak()).toBeLessThanOrEqual(1 + 2 + 1)
    })
})
