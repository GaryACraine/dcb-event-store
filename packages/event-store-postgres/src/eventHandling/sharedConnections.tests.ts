import { Pool } from "pg"
import { AnyEvent, TaggedEvent, Tags } from "@dcb-es/event-store"
import { getTestPgDatabasePool } from "@test/testPgDbPool"
import { collectUncaught, waitFor } from "@test/waitFor"
import { PostgresEventStore } from "../eventStore/PostgresEventStore.js"
import { NotificationListener } from "../eventStore/notificationListener.js"
import { ensureHandlersInstalled } from "./ensureHandlersInstalled.js"
import { createConsumer, ConsumerProcessorConfig, RunningConsumer } from "./consumer.js"

const event = (type: string): TaggedEvent<AnyEvent> => ({
    event: { type, data: {} } as AnyEvent,
    tags: Tags.fromObj({ e: "1" })
})
const checkedOut = (pool: Pool) => pool.totalCount - pool.idleCount
const quiet = { error: () => {}, warn: () => {} }
const NAMES = ["proc-1", "proc-2", "proc-3", "proc-4", "proc-5", "proc-6"]

const lockHolders = async (pool: Pool): Promise<number[]> =>
    (
        await pool.query(
            `SELECT DISTINCT pid FROM pg_locks
              WHERE locktype = 'advisory' AND granted AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`
        )
    ).rows.map(r => r.pid)

/**
 * A consumer's processors hold two connections between them (phase 20, kit ADR-047): the store's listener and the
 * consumer's lock holder. Each handler records the events it commits in a table with a unique key, so an event
 * handled twice fails the test.
 */
describe("a consumer's shared connections (phase 20)", () => {
    let pool: Pool
    let store: PostgresEventStore

    beforeEach(async () => {
        pool = await getTestPgDatabasePool({ max: 6 })
        store = new PostgresEventStore({
            pool,
            notificationListener: new NotificationListener(pool, {
                logger: quiet,
                backoff: { initialMs: 50, maxMs: 200 }
            })
        })
        await store.ensureInstalled()
        await ensureHandlersInstalled(pool, NAMES, "_handler_bookmarks")
        await pool.query("CREATE TABLE handled (processor TEXT, position BIGINT, PRIMARY KEY (processor, position))")
    })

    afterEach(async () => {
        await pool.end()
    })

    const consumerOf = (names: string[]): RunningConsumer =>
        createConsumer({
            pool,
            eventStore: store,
            logger: quiet,
            processors: names.map(
                (processorName): ConsumerProcessorConfig => ({
                    processorName,
                    pollIntervalMs: 50,
                    backoff: { initialMs: 50, maxMs: 200 },
                    handlerFactory: client => ({
                        when: {
                            Evt: async ({ position }) => {
                                await client.query("INSERT INTO handled VALUES ($1, $2)", [
                                    processorName,
                                    position.toString()
                                ])
                            }
                        }
                    })
                })
            )
        })

    const handledCount = async (): Promise<number> =>
        Number((await pool.query("SELECT count(*) AS n FROM handled")).rows[0].n)
    const allRunning = (c: RunningConsumer) => c.status().every(s => s.state === "running")

    test("six processors run on a pool of 6, holding two connections between them", async () => {
        const consumer = consumerOf(NAMES)
        await waitFor("every processor running", () => allRunning(consumer))
        await store.append({ events: event("Evt") })
        await waitFor("every processor to handle the event", async () => (await handledCount()) === NAMES.length)

        expect(await lockHolders(pool)).toHaveLength(1)
        await waitFor("only the listener and the lock holder checked out", () => checkedOut(pool) === 2)
        await consumer.stop()
        await waitFor("every connection back in the pool", () => checkedOut(pool) === 0)
    })

    test("a lost lock connection: every processor stops and starts again, and no event is handled twice", async () => {
        const uncaught = collectUncaught()
        const consumer = consumerOf(NAMES)
        await waitFor("every processor running", () => allRunning(consumer))
        await store.append({ events: event("Evt") })
        await waitFor("the first event handled", async () => (await handledCount()) === NAMES.length)

        const [pid] = await lockHolders(pool)
        await pool.query("SELECT pg_terminate_backend($1)", [pid])
        await waitFor("the processors to restart", () => consumer.status().some(s => s.state === "restarting"))
        await waitFor("every processor running again, on a new lock connection", async () => {
            const holders = await lockHolders(pool)
            return allRunning(consumer) && holders.length === 1 && holders[0] !== pid
        })

        await store.append({ events: event("Evt") })
        await waitFor("the second event handled", async () => (await handledCount()) === NAMES.length * 2)
        await consumer.stop()
        uncaught.stop()
        expect(uncaught.errors).toEqual([])
    })

    test("two instances: the second takes the processors over when the first's lock connection goes", async () => {
        const first = consumerOf(NAMES.slice(0, 3))
        await waitFor("the first instance running", () => allRunning(first))
        const second = consumerOf(NAMES.slice(0, 3))
        await waitFor("the second instance waiting on the locks", () =>
            second.status().every(s => s.state === "restarting")
        )

        const [pid] = await lockHolders(pool)
        await pool.query("SELECT pg_terminate_backend($1)", [pid])
        await waitFor(
            "one instance running all three again",
            async () => (await lockHolders(pool)).length === 1 && (allRunning(first) || allRunning(second))
        )

        await store.append({ events: event("Evt") })
        await waitFor("each processor to handle it once", async () => (await handledCount()) === 3)
        await first.stop()
        await second.stop()
    })
})
