import { Pool } from "pg"
import { AnyEvent, SequencedEvent, TaggedEvent, Tags } from "@dcb-es/event-store"
import { PostgresEventStore } from "../eventStore/PostgresEventStore.js"
import { ensureHandlersInstalled } from "./ensureHandlersInstalled.js"
import { createProcessor, ProcessorLogger } from "./processor.js"
import { createConsumer } from "./consumer.js"
import { readProcessorStatuses } from "./processorStatus.js"
import { getTestPgDatabasePool } from "@test/testPgDbPool"

// Phase 19 (the kit's ADR-031): a handler that throws blocks its processor and retries the same event, after Axon 5's
// default. Skip is opt-in (Emmett's `skip`). A consumer never loses a processor.

const event = (type: string, data: unknown = {}): TaggedEvent<AnyEvent> => ({
    event: { type, data } as AnyEvent,
    tags: Tags.fromObj({ e: "1" })
})

const quietLogger = (): ProcessorLogger & { errors: string[]; warnings: string[] } => {
    const errors: string[] = []
    const warnings: string[] = []
    return {
        errors,
        warnings,
        error: (message: string) => {
            errors.push(message)
        },
        warn: (message: string) => {
            warnings.push(message)
        }
    }
}

const until = async (check: () => boolean | Promise<boolean>, timeoutMs = 3000): Promise<void> => {
    const deadline = Date.now() + timeoutMs
    while (!(await check())) {
        if (Date.now() > deadline) throw new Error("condition not met in time")
        await new Promise(r => setTimeout(r, 10))
    }
}

describe("processor failure policy (phase 19)", () => {
    let pool: Pool
    let store: PostgresEventStore
    const TABLE = "_handler_bookmarks"

    const bookmark = async (handler: string) =>
        Number(
            (await pool.query(`SELECT last_sequence_position FROM ${TABLE} WHERE handler_id = $1`, [handler])).rows[0]
                .last_sequence_position
        )

    beforeAll(async () => {
        pool = await getTestPgDatabasePool({ max: 30 })
        store = new PostgresEventStore({ pool })
        await store.ensureInstalled()
        await pool.query("CREATE TABLE IF NOT EXISTS _failure_policy_rows (name TEXT)")
    })

    afterEach(async () => {
        await pool.query("TRUNCATE table events")
        await pool.query("ALTER SEQUENCE events_sequence_position_seq RESTART WITH 1")
        await pool.query("DELETE FROM _handler_bookmarks")
        await pool.query("DELETE FROM _failure_policy_rows")
    })

    afterAll(async () => {
        if (pool) {
            await pool.query("DROP TABLE IF EXISTS _failure_policy_rows")
            await pool.end()
        }
    })

    describe("retry (the default): fail fast, back off, retry the same event", () => {
        test("the same event is retried until the handler succeeds, then the checkpoint moves", async () => {
            const HANDLER = "fp-retry"
            await ensureHandlersInstalled(pool, [HANDLER], TABLE)
            await store.append({ events: event("A") })
            await store.append({ events: event("B") })

            const attempts: string[] = []
            let failures = 2
            const logger = quietLogger()
            const { promise } = createProcessor({
                pool,
                eventStore: store,
                processorName: HANDLER,
                handlerFactory: () => ({
                    when: {
                        A: async () => {
                            attempts.push("A")
                            if (failures-- > 0) throw new Error("not yet")
                        },
                        B: async () => {
                            attempts.push("B")
                        }
                    }
                }),
                backoff: { initialMs: 10, maxMs: 20 },
                logger,
                stopAfter: 2
            })

            await promise
            expect(attempts).toEqual(["A", "A", "A", "B"])
            expect(await bookmark(HANDLER)).toBe(2)
            expect(logger.errors).toHaveLength(2)
            expect(logger.errors[0]).toContain(HANDLER)
            expect(logger.errors[0]).toContain("not yet")
        })

        test("a blocked processor says so: status() and the bookmark row, both cleared when it recovers", async () => {
            const HANDLER = "fp-blocked-status"
            await ensureHandlersInstalled(pool, [HANDLER], TABLE)
            await store.append({ events: event("A") })

            let fixed = false
            const { promise, status } = createProcessor({
                pool,
                eventStore: store,
                processorName: HANDLER,
                handlerFactory: () => ({
                    when: {
                        A: async () => {
                            if (!fixed) throw new Error("projection bug")
                        }
                    }
                }),
                backoff: { initialMs: 20, maxMs: 20 },
                logger: quietLogger(),
                stopAfter: 1
            })

            await until(() => (status().blocked?.attempts ?? 0) >= 2)
            const blocked = status()
            expect(blocked.processorName).toBe(HANDLER)
            expect(blocked.state).toBe("blocked")
            expect(blocked.blocked!.error).toContain("projection bug")
            expect(blocked.blocked!.position.toString()).toBe("1")
            expect(blocked.blocked!.eventType).toBe("A")
            expect(blocked.blocked!.since).toBeInstanceOf(Date)
            expect(blocked.blocked!.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(blocked.blocked!.since.getTime())

            const [row] = (await readProcessorStatuses(pool)).filter(s => s.processorName === HANDLER)
            expect(row.blocked!.error).toContain("projection bug")
            expect(row.blocked!.position.toString()).toBe("1")
            expect(row.blocked!.attempts).toBeGreaterThanOrEqual(1)
            expect(row.blocked!.since).toBeInstanceOf(Date)

            fixed = true
            await promise
            expect(status().state).toBe("stopped")
            expect(status().blocked).toBeUndefined()
            const [after] = (await readProcessorStatuses(pool)).filter(s => s.processorName === HANDLER)
            expect(after.blocked).toBeUndefined()
            expect(after.position.toString()).toBe("1")
        })

        test("the wait doubles up to its maximum", async () => {
            const HANDLER = "fp-backoff"
            await ensureHandlersInstalled(pool, [HANDLER], TABLE)
            await store.append({ events: event("A") })

            const times: number[] = []
            const { promise } = createProcessor({
                pool,
                eventStore: store,
                processorName: HANDLER,
                handlerFactory: () => ({
                    when: {
                        A: async () => {
                            times.push(Date.now())
                            if (times.length < 5) throw new Error("fails four times")
                        }
                    }
                }),
                backoff: { initialMs: 40, maxMs: 120 },
                logger: quietLogger(),
                stopAfter: 1
            })

            await promise
            const gaps = times.slice(1).map((t, i) => t - times[i])
            // 40, 80, 120 (capped), 120 — each at least its wait, and the capped ones well short of 160.
            expect(gaps[0]).toBeGreaterThanOrEqual(35)
            expect(gaps[1]).toBeGreaterThanOrEqual(75)
            expect(gaps[2]).toBeGreaterThanOrEqual(115)
            expect(gaps[3]).toBeGreaterThanOrEqual(115)
            expect(gaps[3]).toBeLessThan(400)
        })

        test("a stop while blocked ends the wait at once, and the event stays unhandled", async () => {
            const HANDLER = "fp-abort-blocked"
            await ensureHandlersInstalled(pool, [HANDLER], TABLE)
            await store.append({ events: event("A") })

            const controller = new AbortController()
            const { promise, status } = createProcessor({
                pool,
                eventStore: store,
                processorName: HANDLER,
                handlerFactory: () => ({
                    when: {
                        A: async () => {
                            throw new Error("always")
                        }
                    }
                }),
                backoff: { initialMs: 60_000, maxMs: 60_000 },
                logger: quietLogger(),
                signal: controller.signal
            })

            await until(() => status().state === "blocked")
            const start = Date.now()
            controller.abort()
            await promise
            expect(Date.now() - start).toBeLessThan(1000)
            expect(status().state).toBe("stopped")
            expect(await bookmark(HANDLER)).toBe(0)
        })

        test("the handler's writes from a failed attempt are rolled back", async () => {
            const HANDLER = "fp-retry-rollback"
            await ensureHandlersInstalled(pool, [HANDLER], TABLE)
            await store.append({ events: event("A") })

            let failures = 1
            const { promise } = createProcessor({
                pool,
                eventStore: store,
                processorName: HANDLER,
                handlerFactory: client => ({
                    when: {
                        A: async () => {
                            await client.query("INSERT INTO _failure_policy_rows VALUES ('A')")
                            if (failures-- > 0) throw new Error("after the write")
                        }
                    }
                }),
                backoff: { initialMs: 10, maxMs: 10 },
                logger: quietLogger(),
                stopAfter: 1
            })

            await promise
            const rows = await pool.query("SELECT name FROM _failure_policy_rows")
            expect(rows.rows.map(r => r.name)).toEqual(["A"])
        })
    })

    describe("skip (opt-in): log and move past the event", () => {
        test("the failed event's writes are undone, the checkpoint passes it and the next event is handled", async () => {
            const HANDLER = "fp-skip"
            await ensureHandlersInstalled(pool, [HANDLER], TABLE)
            await store.append({ events: event("Bad") })
            await store.append({ events: event("Good") })

            const logger = quietLogger()
            const { promise, status } = createProcessor({
                pool,
                eventStore: store,
                processorName: HANDLER,
                handlerFactory: client => ({
                    when: {
                        Bad: async () => {
                            await client.query("INSERT INTO _failure_policy_rows VALUES ('Bad')")
                            throw new Error("can't handle this one")
                        },
                        Good: async () => {
                            await client.query("INSERT INTO _failure_policy_rows VALUES ('Good')")
                        }
                    }
                }),
                onError: "skip",
                logger,
                stopAfter: 2
            })

            await promise
            const rows = await pool.query("SELECT name FROM _failure_policy_rows")
            expect(rows.rows.map(r => r.name)).toEqual(["Good"])
            expect(await bookmark(HANDLER)).toBe(2)
            expect(logger.warnings).toHaveLength(1)
            expect(logger.warnings[0]).toContain("can't handle this one")
            expect(logger.warnings[0]).toContain("Bad")
            expect(logger.errors).toHaveLength(0)
            expect(status().blocked).toBeUndefined()
        })

        test("a function decides per error: skip one kind, retry the rest", async () => {
            const HANDLER = "fp-decide"
            await ensureHandlersInstalled(pool, [HANDLER], TABLE)
            await store.append({ events: event("Poison") })
            await store.append({ events: event("Flaky") })

            class PoisonError extends Error {}
            const handled: string[] = []
            let flaky = 1
            const decisions: string[] = []
            const { promise } = createProcessor({
                pool,
                eventStore: store,
                processorName: HANDLER,
                handlerFactory: () => ({
                    when: {
                        Poison: async () => {
                            throw new PoisonError("unreadable payload")
                        },
                        Flaky: async () => {
                            if (flaky-- > 0) throw new Error("timeout")
                            handled.push("Flaky")
                        }
                    }
                }),
                onError: (error: unknown, failed: SequencedEvent) => {
                    decisions.push(failed.event.type)
                    return error instanceof PoisonError ? "skip" : "retry"
                },
                backoff: { initialMs: 10, maxMs: 10 },
                logger: quietLogger(),
                stopAfter: 2
            })

            await promise
            expect(decisions).toEqual(["Poison", "Flaky"])
            expect(handled).toEqual(["Flaky"])
            expect(await bookmark(HANDLER)).toBe(2)
        })
    })

    describe("stop: the processor ends with the error (as before phase 19)", () => {
        test("the promise rejects and the checkpoint stays", async () => {
            const HANDLER = "fp-stop"
            await ensureHandlersInstalled(pool, [HANDLER], TABLE)
            await store.append({ events: event("Boom") })

            const { promise, status } = createProcessor({
                pool,
                eventStore: store,
                processorName: HANDLER,
                handlerFactory: () => ({
                    when: {
                        Boom: async () => {
                            throw new Error("handler exploded")
                        }
                    }
                }),
                onError: "stop"
            })

            await expect(promise).rejects.toThrow("handler exploded")
            expect(status().state).toBe("stopped")
            expect(await bookmark(HANDLER)).toBe(0)
        })
    })

    describe("the handler is told whether its processor is rebuilding", () => {
        test("rebuilding is false by default and true when the processor is started for a rebuild", async () => {
            const NORMAL = "fp-context-normal"
            const REBUILD = "fp-context-rebuild"
            await ensureHandlersInstalled(pool, [NORMAL, REBUILD], TABLE)
            await store.append({ events: event("A") })

            const seen: Record<string, boolean[]> = { [NORMAL]: [], [REBUILD]: [] }
            const run = (processorName: string, rebuilding?: boolean) =>
                createProcessor({
                    pool,
                    eventStore: store,
                    processorName,
                    handlerFactory: (_client, context) => ({
                        when: {
                            A: async () => {
                                seen[processorName].push(context.rebuilding)
                            }
                        }
                    }),
                    rebuilding,
                    stopAfter: 1
                }).promise

            await Promise.all([run(NORMAL), run(REBUILD, true)])
            expect(seen[NORMAL]).toEqual([false])
            expect(seen[REBUILD]).toEqual([true])
        })
    })

    describe("a consumer never loses a processor", () => {
        test("a failing processor blocks alone: the others carry on", async () => {
            const GOOD = "fp-consumer-good"
            const BAD = "fp-consumer-bad"
            await ensureHandlersInstalled(pool, [GOOD, BAD], TABLE)
            await store.append({ events: event("Evt") })

            const processed: string[] = []
            const consumer = createConsumer({
                pool,
                eventStore: store,
                logger: quietLogger(),
                processors: [
                    {
                        processorName: BAD,
                        handlerFactory: () => ({
                            when: {
                                Evt: async () => {
                                    throw new Error("bad processor")
                                }
                            }
                        }),
                        backoff: { initialMs: 20, maxMs: 20 },
                        pollIntervalMs: 20
                    },
                    {
                        processorName: GOOD,
                        handlerFactory: () => ({
                            when: {
                                Evt: async () => {
                                    processed.push("good")
                                }
                            }
                        }),
                        pollIntervalMs: 20
                    }
                ]
            })

            try {
                await until(() => processed.length === 1 && consumer.status()[0].state === "blocked")
                const statuses = consumer.status()
                expect(statuses.map(s => [s.processorName, s.state])).toEqual([
                    [BAD, "blocked"],
                    [GOOD, "running"]
                ])
                expect(statuses[0].blocked!.error).toContain("bad processor")
            } finally {
                await consumer.stop()
            }
            expect(await bookmark(BAD)).toBe(0)
            expect(await bookmark(GOOD)).toBe(1)
        })

        test("a processor that ends with an error is started again (here: its lock was held elsewhere)", async () => {
            const HANDLER = "fp-consumer-restart"
            await ensureHandlersInstalled(pool, [HANDLER], TABLE)

            // Another instance holds the processor's lock.
            const otherInstance = new AbortController()
            const other = createProcessor({
                pool,
                eventStore: store,
                processorName: HANDLER,
                handlerFactory: () => ({ when: { Evt: async () => {} } }),
                pollIntervalMs: 20,
                signal: otherInstance.signal
            })
            await until(() => other.status().state === "running")

            const logger = quietLogger()
            const processed: string[] = []
            const consumer = createConsumer({
                pool,
                eventStore: store,
                logger,
                processors: [
                    {
                        processorName: HANDLER,
                        handlerFactory: () => ({
                            when: {
                                Evt: async () => {
                                    processed.push("Evt")
                                }
                            }
                        }),
                        backoff: { initialMs: 20, maxMs: 40 },
                        pollIntervalMs: 20
                    }
                ]
            })

            try {
                await until(() => consumer.status()[0].state === "restarting")
                expect(consumer.status()[0].restart!.error).toContain("lock not acquired")
                expect(processed).toEqual([])

                otherInstance.abort()
                await other.promise
                await store.append({ events: event("Evt") })
                await until(() => processed.length === 1)
                await until(() => consumer.status()[0].state === "running")
                expect(consumer.status()[0].restart).toBeUndefined()
            } finally {
                await consumer.stop()
            }
            expect(logger.errors.some(e => e.includes(HANDLER) && e.includes("lock not acquired"))).toBe(true)
            const settled = await Promise.allSettled(consumer.processors.map(p => p.promise))
            expect(settled.every(r => r.status === "fulfilled")).toBe(true)
        })
    })
})
