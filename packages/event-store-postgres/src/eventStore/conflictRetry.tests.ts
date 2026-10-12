import { Pool } from "pg"
import {
    AnyEvent,
    AppendConditionError,
    Command,
    EventHandlerWithState,
    EventStore,
    IllegalStateError,
    Query,
    TaggedEvent,
    Tags,
    decider,
    handleCommand,
    streamAllEventsToArray
} from "@dcb-es/event-store"
import { PostgresEventStore } from "./PostgresEventStore.js"
import { LockStrategy, advisoryLocks, rowLocks } from "./lockStrategy.js"
import { getTestPgDatabasePool } from "@test/testPgDbPool"

// Phase 24: a command decided again after a conflict sees the winner's events, so its own decider refuses it

type Activate = Command<"activate", { userId: string; organisationId: string }>

const activated = (userId: string, organisationId: string): TaggedEvent<AnyEvent> => ({
    event: { type: "organisationWasActivated", data: { userId, organisationId } } as AnyEvent,
    tags: Tags.fromObj({ userId })
})

const HasOrganisation = (userId: string): EventHandlerWithState<AnyEvent, boolean> => ({
    tagFilter: Tags.fromObj({ userId }),
    init: false,
    when: { organisationWasActivated: () => true }
})

const activate = decider<Activate, { has: ReturnType<typeof HasOrganisation> }>({
    handlers: cmd => ({ has: HasOrganisation(cmd.data.userId) }),
    decide: (cmd, state) => {
        if (state.has) throw new IllegalStateError("You already belong to an organisation")
        return activated(cmd.data.userId, cmd.data.organisationId)
    }
})

const command = (organisationId: string): Activate => ({ type: "activate", data: { userId: "u1", organisationId } })

// Holds each first append until both commands have decided, so they decide on the same events and race
function racing(store: EventStore, racers = 2): EventStore {
    let waiting = 0
    let release!: () => void
    const bothDecided = new Promise<void>(resolve => (release = resolve))
    let first = 0
    return {
        append: async cmd => {
            if (first++ < racers) {
                if (++waiting === racers) release()
                await bothDecided
            }
            return store.append(cmd)
        },
        read: (query, options) => store.read(query, options),
        subscribe: (query, options) => store.subscribe(query, options)
    }
}

const strategies: [string, () => LockStrategy][] = [
    ["advisory", () => advisoryLocks()],
    ["row-locks", () => rowLocks()]
]

describe.each(strategies)("deciding again after a conflict [%s]", (_name, createStrategy) => {
    let pool: Pool
    let store: PostgresEventStore

    beforeAll(async () => {
        pool = await getTestPgDatabasePool({ max: 30 })
        store = new PostgresEventStore({ pool, lockStrategy: createStrategy() })
        await store.ensureInstalled()
    })

    afterEach(async () => {
        await pool.query("TRUNCATE table events")
        await pool.query("ALTER SEQUENCE events_sequence_position_seq RESTART WITH 1")
    })

    afterAll(async () => {
        if (pool) await pool.end()
    })

    const stored = async () => streamAllEventsToArray(store.read(Query.all()))

    test("without retry, the loser gets the conflict", async () => {
        const s = racing(store)
        const results = await Promise.allSettled([
            handleCommand(s, activate, command("o1")),
            handleCommand(s, activate, command("o2"))
        ])
        expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1)
        const lost = results.find(r => r.status === "rejected") as PromiseRejectedResult
        expect(lost.reason).toBeInstanceOf(AppendConditionError)
        expect(await stored()).toHaveLength(1)
    })

    test("with retry, the loser decides again and is refused by its decider", async () => {
        const s = racing(store)
        const retry = { onConflict: { backoff: { initialMs: 1, maxMs: 1 } } }
        const results = await Promise.allSettled([
            handleCommand(s, activate, command("o1"), { retry }),
            handleCommand(s, activate, command("o2"), { retry })
        ])
        expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1)
        const lost = results.find(r => r.status === "rejected") as PromiseRejectedResult
        expect(lost.reason).toBeInstanceOf(IllegalStateError)
        expect((lost.reason as Error).message).toBe("You already belong to an organisation")
        expect(await stored()).toHaveLength(1)
    })
})
