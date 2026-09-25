import { getEventListeners } from "node:events"
import { Pool, PoolClient } from "pg"
import { AnyEvent, TaggedEvent, Query, SequencePosition, SequencedEvent, Tags } from "@dcb-es/event-store"
import { PostgresEventStore } from "./PostgresEventStore.js"
import { advisoryLocks, rowLocks, LockStrategy } from "./lockStrategy.js"
import { getTestPgDatabasePool } from "@test/testPgDbPool"
import { trackConnections, mostListeners } from "@test/trackConnections"

// Phase 18. A filtered subscription reports how far it has seen (`onCaughtUp`), so a processor's checkpoint can
// mean "has seen everything up to X" (Emmett's meaning) and not "the last event it handled". And an idle
// subscription holds no more listeners than it needs (Emmett PR #405's lesson: a listener outliving its race leaks).

const EMPTY_PAYLOAD = '{"data":{},"metadata":{}}'

const event = (type: string, tag = "e=1"): TaggedEvent<AnyEvent> => ({
    event: { type, data: {} } as AnyEvent,
    tags: Tags.from([tag])
})

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        if (predicate()) return
        await new Promise(r => setTimeout(r, 10))
    }
    throw new Error("Timed out waiting for predicate")
}

// Subscriptions a test started; stopped after each test, so a failed assertion doesn't leave one running.
const running: AbortController[] = []
afterEach(() => running.splice(0).forEach(c => c.abort()))

/** Drives a subscription in the background, recording what it yields and reports, in order. */
function drive(
    store: PostgresEventStore,
    query: Query,
    options: { after?: SequencePosition; pollIntervalMs?: number } = {}
) {
    const controller = new AbortController()
    running.push(controller)
    const log: string[] = []
    const events: SequencedEvent[] = []
    const caughtUp: string[] = []
    const done = (async () => {
        for await (const ev of store.subscribe(query, {
            ...options,
            pollIntervalMs: options.pollIntervalMs ?? 20,
            signal: controller.signal,
            onCaughtUp: position => {
                caughtUp.push(position.toString())
                log.push(`caughtUp ${position.toString()}`)
            }
        })) {
            events.push(ev)
            log.push(`event ${ev.event.type} ${ev.position.toString()}`)
        }
    })()
    return {
        controller,
        log,
        events,
        caughtUp,
        stop: async () => {
            controller.abort()
            await done
        }
    }
}

const strategies: [string, () => LockStrategy][] = [
    ["advisory", () => advisoryLocks()],
    ["row-locks", () => rowLocks()]
]

describe.each(strategies)("PostgresEventStore.subscribe onCaughtUp [%s]", (_name, createStrategy) => {
    let pool: Pool
    let store: PostgresEventStore
    let lockStrategy: LockStrategy

    beforeAll(async () => {
        pool = await getTestPgDatabasePool({ max: 30 })
        lockStrategy = createStrategy()
        store = new PostgresEventStore({ pool, lockStrategy })
        await store.ensureInstalled()
    })

    beforeEach(async () => {
        // As in concurrentCommitGap.tests.ts: pre-create the row-lock scopes the held-open writer takes.
        const exists = await pool.query(
            `SELECT 1 FROM information_schema.tables WHERE table_name = 'events_lock_scopes'`
        )
        if (exists.rows.length === 0) return
        const keys = new Set<bigint>()
        for (const ev of [event("A", "scope=X"), event("B", "scope=Y")]) {
            const wk = lockStrategy.computeWriterKeys([ev])
            for (const k of [...wk.leafX, ...wk.intentS]) keys.add(k)
        }
        await pool.query(
            `INSERT INTO events_lock_scopes (scope_key) SELECT unnest($1::bigint[]) ON CONFLICT DO NOTHING`,
            [Array.from(keys)]
        )
    })

    afterEach(async () => {
        await pool.query("TRUNCATE table events")
        await pool.query("ALTER SEQUENCE events_sequence_position_seq RESTART WITH 1")
    })

    afterAll(async () => {
        if (pool) await pool.end()
    })

    test("reports the position it has seen up to when only unrelated events were appended", async () => {
        const sub = drive(store, Query.fromItems([{ types: ["A"] }]))
        await store.append({ events: event("B") })
        await store.append({ events: event("B") })

        await waitFor(() => sub.caughtUp.includes("2"))
        await sub.stop()

        expect(sub.events).toEqual([])
    })

    test("yields a matching event before reporting a position past it", async () => {
        await store.append({ events: event("A") })
        await store.append({ events: event("B") })

        const sub = drive(store, Query.fromItems([{ types: ["A"] }]))
        await waitFor(() => sub.caughtUp.includes("2"))
        await sub.stop()

        expect(sub.log).toEqual(["event A 1", "caughtUp 2"])
    })

    test("reports once per advance, not on every idle poll", async () => {
        await store.append({ events: event("B") })
        const sub = drive(store, Query.fromItems([{ types: ["A"] }]), { pollIntervalMs: 10 })

        await waitFor(() => sub.caughtUp.length > 0)
        await new Promise(r => setTimeout(r, 200))
        await store.append({ events: event("B") })
        await waitFor(() => sub.caughtUp.includes("2"))
        await new Promise(r => setTimeout(r, 100))
        await sub.stop()

        expect(sub.caughtUp).toEqual(["1", "2"])
    })

    test("doesn't report when nothing lies past `after`", async () => {
        await store.append({ events: event("B") })
        const sub = drive(store, Query.fromItems([{ types: ["A"] }]), { after: SequencePosition.fromString("1") })

        await new Promise(r => setTimeout(r, 150))
        await sub.stop()

        expect(sub.caughtUp).toEqual([])
    })

    test("a later subscription resumes from the reported position and misses nothing", async () => {
        const first = drive(store, Query.fromItems([{ types: ["A"] }]))
        await store.append({ events: event("B") })
        await waitFor(() => first.caughtUp.includes("1"))
        await first.stop()

        await store.append({ events: event("A") })
        const second = drive(store, Query.fromItems([{ types: ["A"] }]), {
            after: SequencePosition.fromString(first.caughtUp.at(-1)!)
        })
        await waitFor(() => second.events.length === 1)
        await second.stop()

        expect(second.events.map(e => e.position.toString())).toEqual(["2"])
    })

    test("doesn't trust a cached high-water mark: a test that restarts the sequence misses nothing", async () => {
        // A read fills the barrier cache with hwm 2; the suite then empties the table and restarts the sequence,
        // as test suites do between tests. The next event is written at 1 again.
        await store.append({ events: event("B") })
        await store.append({ events: event("B") })
        for await (const _ of store.read(Query.fromItems([{ types: ["A"] }]))) void _
        await pool.query("TRUNCATE table events")
        await pool.query("ALTER SEQUENCE events_sequence_position_seq RESTART WITH 1")

        const sub = drive(store, Query.fromItems([{ types: ["A"] }]))
        await new Promise(r => setTimeout(r, 30))
        await store.append({ events: event("A") })
        await waitFor(() => sub.events.length === 1)
        await sub.stop()

        expect(sub.log).toEqual(["event A 1"])
    })

    test("never reports past a matching event that is still being written", async () => {
        // The matching writer takes position 1 and holds its transaction open; an unrelated writer commits
        // position 2. The subscriber must not report 2 (or 1) until it has yielded the event at 1.
        const slowWriter: PoolClient = await pool.connect()
        try {
            await slowWriter.query("BEGIN")
            const held = event("A", "scope=X")
            await lockStrategy.acquireWriter(slowWriter, lockStrategy.computeWriterKeys([held]), "events")
            await slowWriter.query("INSERT INTO events (type, tags, payload) VALUES ($1, $2, $3)", [
                "A",
                ["scope=X"],
                EMPTY_PAYLOAD
            ])

            await store.append({ events: event("B", "scope=Y") })

            const sub = drive(store, Query.fromItems([{ types: ["A"] }]))
            await new Promise(r => setTimeout(r, 200))
            expect(sub.caughtUp).toEqual([])

            await slowWriter.query("COMMIT")
            await waitFor(() => sub.caughtUp.includes("2"))
            await sub.stop()

            expect(sub.log).toEqual(["event A 1", "caughtUp 2"])
        } finally {
            await slowWriter.query("ROLLBACK").catch(() => {})
            slowWriter.release()
        }
    })
})

describe("PostgresEventStore.subscribe listeners", () => {
    let pool: Pool
    let store: PostgresEventStore
    let clients: Set<PoolClient>

    beforeAll(async () => {
        pool = await getTestPgDatabasePool({ max: 10 })
        store = new PostgresEventStore({ pool })
        await store.ensureInstalled()
        clients = trackConnections(pool)
    })

    afterAll(async () => {
        if (pool) await pool.end()
    })

    const notificationListeners = () => mostListeners(clients, "notification")

    test("an idle subscription holds one notification and one abort listener, however long it waits", async () => {
        const controller = new AbortController()
        running.push(controller)
        const sub = store.subscribe(Query.fromItems([{ types: ["Never"] }]), {
            pollIntervalMs: 5,
            signal: controller.signal
        })
        const pending = sub.next()

        // ~100 idle polls
        await new Promise(r => setTimeout(r, 500))
        expect(notificationListeners()).toBeLessThanOrEqual(1)
        expect(getEventListeners(controller.signal, "abort").length).toBeLessThanOrEqual(1)

        controller.abort()
        await pending
        expect(getEventListeners(controller.signal, "abort").length).toBe(0)
        expect(notificationListeners()).toBe(0)
    })

    test("a notification doesn't leave listeners behind either", async () => {
        const controller = new AbortController()
        running.push(controller)
        const sub = store.subscribe(Query.fromItems([{ types: ["Never"] }]), {
            pollIntervalMs: 5,
            signal: controller.signal
        })
        const pending = sub.next()
        await new Promise(r => setTimeout(r, 50))
        for (let i = 0; i < 20; i++) await store.append({ events: event("Other") })
        await new Promise(r => setTimeout(r, 100))

        expect(notificationListeners()).toBeLessThanOrEqual(1)
        expect(getEventListeners(controller.signal, "abort").length).toBeLessThanOrEqual(1)

        controller.abort()
        await pending
        expect(getEventListeners(controller.signal, "abort").length).toBe(0)
    })

    test("the connection goes back to the pool without the subscription's error listener", async () => {
        const cycle = async () => {
            const controller = new AbortController()
            running.push(controller)
            const sub = store.subscribe(Query.fromItems([{ types: ["Never"] }]), {
                pollIntervalMs: 5,
                signal: controller.signal
            })
            const pending = sub.next()
            await new Promise(r => setTimeout(r, 30))
            controller.abort()
            await pending
        }
        const errorListeners = () => mostListeners(clients, "error")

        await cycle()
        const settled = errorListeners()
        for (let i = 0; i < 5; i++) await cycle()

        // The pool reuses its connections, so a listener left on one would show here as a growing count.
        expect(errorListeners()).toBe(settled)
    })
})
