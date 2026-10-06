import { Pool, PoolClient } from "pg"
import { EventHandler, EventStore, Query, SequencedEvent, SequencePosition, Tags } from "@dcb-es/event-store"
import { acquireProcessorLock, ProcessorLockHandle } from "./processorLock.js"
import { LockHolder } from "./lockHolder.js"
import { Semaphore } from "../eventStore/semaphore.js"
import { readCheckpoint, storeCheckpoint, Checkpoint } from "./checkpointer.js"
import { resolveStartPosition, StartPosition } from "./startPositions.js"
import { Backoff, backoffDelay, errorMessage, sleep } from "./backoff.js"
import { BlockedStatus, ProcessorState, ProcessorStatus, recordBlocked } from "./processorStatus.js"
import { v4 as uuid } from "uuid"

/**
 * What a processor does when its handler throws (phase 19):
 * - `retry` (the default): roll back, log, wait (`backoff`) and handle the same event again. The processor is blocked
 *   until it succeeds; other processors carry on. Axon 5's default.
 * - `skip`: roll back, log a warning and move the checkpoint past the event. Only where losing it is acceptable
 *   (Emmett's `skip`).
 * - `stop`: roll back and reject the processor's promise.
 */
export type ErrorAction = "retry" | "skip" | "stop"
export type OnHandlerError = ErrorAction | ((error: unknown, event: SequencedEvent) => ErrorAction)

export interface ProcessorLogger {
    error: (message: string, error?: unknown) => void
    warn: (message: string, error?: unknown) => void
}

/** Passed to `handlerFactory` with the transaction client. */
export interface HandlerContext {
    /** True while the processor replays for a rebuild: an automation step skips its work (the kit's ADR-031). */
    rebuilding: boolean
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type HandlerFactory = (client: PoolClient, context: HandlerContext) => EventHandler<any, any>

export interface ProcessorOptions {
    pool: Pool
    eventStore: EventStore
    processorName: string
    handlerFactory: HandlerFactory
    query?: Query
    bookmarkTableName?: string
    batchSize?: number
    pollIntervalMs?: number
    startFrom?: StartPosition
    stopAfter?: number
    /**
     * When true, the processor reads all available events in a loop (using
     * `eventStore.read()`) instead of `subscribe()`. After a read cycle that
     * yields zero events, the processor exits cleanly. Used by rebuild to
     * process everything then stop.
     */
    stopWhenCaughtUp?: boolean
    signal?: AbortSignal
    instanceId?: string
    /** What to do when the handler throws. Default `"retry"`. */
    onError?: OnHandlerError
    /** The wait between retries. Default 1 s, doubling to 60 s. */
    backoff?: Backoff
    /** Where retries and skips are reported. Default `console`. */
    logger?: ProcessorLogger
    /** Tell the handler it's replaying for a rebuild (`HandlerContext.rebuilding`). */
    rebuilding?: boolean
    /**
     * The session that holds the processor's lock (phase 20). `createConsumer` shares one among its processors, so
     * they hold one connection between them. Default: a holder, and so a connection, of its own.
     */
    lockHolder?: LockHolder
    /**
     * Turns at handling an event, shared by a consumer's processors (phase 21): an event's transaction, or a checkpoint
     * move, waits for one. Default: no cap.
     */
    handlingSlots?: Semaphore
}

export interface RunningProcessor {
    promise: Promise<void>
    instanceId: string
    status: () => ProcessorStatus
}

/** The error a handler threw, kept apart from the processor's own (lock, checkpoint), which always end it. */
class HandlerFailure extends Error {
    constructor(readonly error: unknown) {
        super(errorMessage(error))
    }
}

export function assertProcessorName(processorName: string): void {
    if (processorName.includes(":")) {
        throw new Error(`Processor name "${processorName}" must not contain ":" (used as notification delimiter)`)
    }
}

/**
 * Create a hardened event processor with session-scoped instance lock,
 * CAS-versioned checkpoints, and start-position policies.
 *
 * Each event is processed in its own transaction: the handlerFactory receives
 * the transaction client so projection writes are atomic with the bookmark
 * advance.
 *
 * Internally uses `eventStore.subscribe()` for efficient event streaming
 * (persistent cursor + LISTEN wakeup). The processor lock, CAS checkpoint,
 * and lifecycle management are layered on top.
 *
 * A handler that throws is handled by `onError` (retry by default, so the
 * processor blocks on that event and says so in `status()` and its bookmark
 * row). The returned promise resolves when the signal is aborted or stopAfter
 * is reached, and rejects on an unrecoverable error (lock not acquired, lock
 * lost with its connection, lock stolen, or a handler error with
 * `onError: "stop"`).
 */
export function createProcessor(options: ProcessorOptions): RunningProcessor {
    const { processorName } = options
    const instanceId = options.instanceId ?? uuid()
    assertProcessorName(processorName)

    const status: ProcessorStatus = { processorName, state: "starting" }
    const promise = runProcessor({
        ...options,
        tableName: options.bookmarkTableName ?? "_handler_bookmarks",
        pollIntervalMs: options.pollIntervalMs ?? 100,
        startFrom: options.startFrom ?? "BEGINNING",
        onError: options.onError ?? "retry",
        logger: options.logger ?? console,
        rebuilding: options.rebuilding ?? false,
        instanceId,
        status
    }).finally(() => {
        status.state = "stopped"
    })

    return { promise, instanceId, status: () => ({ ...status }) }
}

interface InternalProcessorOptions extends ProcessorOptions {
    tableName: string
    pollIntervalMs: number
    startFrom: StartPosition
    onError: OnHandlerError
    logger: ProcessorLogger
    rebuilding: boolean
    instanceId: string
    status: ProcessorStatus
}

async function runProcessor(opts: InternalProcessorOptions): Promise<void> {
    const {
        pool,
        eventStore,
        processorName,
        handlerFactory,
        tableName,
        pollIntervalMs,
        startFrom,
        stopAfter,
        signal: stopSignal,
        instanceId,
        onError,
        logger,
        status
    } = opts
    const context: HandlerContext = { rebuilding: opts.rebuilding }
    const setState = (state: ProcessorState, blocked?: BlockedStatus) => {
        status.state = state
        status.blocked = blocked
    }

    // 1. Acquire session-scoped processor lock
    const lock: ProcessorLockHandle = await acquireProcessorLock(pool, processorName, opts.lockHolder)
    if (!lock.acquired) {
        throw new Error(`Processor lock not acquired for "${processorName}" — another instance is running`)
    }

    // The run stops when it's stopped, or when its lock is lost with the connection that held it (phase 20): it
    // must not handle events it no longer owns.
    const runController = new AbortController()
    const stopRun = () => runController.abort()
    stopSignal?.addEventListener("abort", stopRun, { once: true })
    lock.lost.addEventListener("abort", stopRun, { once: true })
    if (stopSignal?.aborted || lock.lost.aborted) runController.abort()
    const signal = runController.signal

    try {
        // 2. Read checkpoint
        const checkpoint: Checkpoint = await readCheckpoint(pool, processorName, tableName)

        // 3. Resolve start position
        let position = await resolveStartPosition(eventStore, checkpoint.position, startFrom)
        let currentVersion = checkpoint.version

        // If start position was advanced (CURRENT policy), persist it
        if (!position.equals(checkpoint.position)) {
            const storeResult = await storeCheckpoint(
                pool,
                processorName,
                tableName,
                position,
                currentVersion,
                instanceId
            )
            if (storeResult === "VERSION_MISMATCH") {
                throw new Error(`Checkpoint version mismatch for "${processorName}" during start position resolution`)
            }
            currentVersion++
        }
        status.position = position

        // 4. Build query from handler (or use pre-built query from options)
        let query: Query
        if (opts.query) {
            query = opts.query
        } else {
            let sampleHandler
            try {
                sampleHandler = handlerFactory(null as unknown as PoolClient, context)
            } catch {
                throw new Error(`handlerFactory for "${processorName}" must not access the client during construction.`)
            }
            const types = Object.keys(sampleHandler.when) as string[]
            query =
                types.length === 0
                    ? Query.all()
                    : Query.fromItems([
                          sampleHandler.tagFilter ? { types, tags: sampleHandler.tagFilter as Tags } : { types }
                      ])
        }
        setState("running")

        // 5. Process events
        let processedCount = 0

        // A consumer's processors take turns at handling (phase 21), so their transactions don't each hold a
        // connection at once. A blocked processor's wait for its retry holds no turn: its transaction rolled back.
        const inTurn = <T>(work: () => Promise<T>): Promise<T> =>
            opts.handlingSlots ? opts.handlingSlots.run(work) : work()

        const processEventNow = async (event: SequencedEvent): Promise<void> => {
            const client = await pool.connect()
            try {
                await client.query("BEGIN")

                const handler = handlerFactory(client, context)
                const fn = handler.when[event.event.type]
                if (fn) {
                    try {
                        await fn(event)
                    } catch (err) {
                        throw new HandlerFailure(err)
                    }
                }

                const storeResult = await storeCheckpoint(
                    client,
                    processorName,
                    tableName,
                    event.position,
                    currentVersion,
                    instanceId
                )
                if (storeResult === "VERSION_MISMATCH") {
                    throw new Error(`Checkpoint version mismatch for "${processorName}" — lock may have been stolen`)
                }

                await client.query("COMMIT")
                position = event.position
                status.position = position
                currentVersion++
            } catch (err) {
                await client.query("ROLLBACK").catch(() => {})
                throw err
            } finally {
                client.release()
            }
        }

        // Move the checkpoint without handling anything: past events the query didn't match, or a skipped one.
        const advanceToNow = async (seen: SequencePosition): Promise<void> => {
            const storeResult = await storeCheckpoint(pool, processorName, tableName, seen, currentVersion, instanceId)
            if (storeResult === "VERSION_MISMATCH") {
                throw new Error(`Checkpoint version mismatch for "${processorName}" — lock may have been stolen`)
            }
            position = seen
            status.position = position
            currentVersion++
        }

        const processEvent = (event: SequencedEvent) => inTurn(() => processEventNow(event))
        const advanceTo = (seen: SequencePosition) => inTurn(() => advanceToNow(seen))

        // Handle one event under `onError`. False when the processor was stopped while blocked on it.
        const handle = async (event: SequencedEvent): Promise<boolean> => {
            let blocked: BlockedStatus | undefined
            for (let attempt = 1; ; attempt++) {
                try {
                    await processEvent(event)
                    break
                } catch (err) {
                    if (!(err instanceof HandlerFailure)) throw err
                    const action = typeof onError === "function" ? onError(err.error, event) : onError
                    const where = `event ${event.position.toString()} (${event.event.type})`
                    if (action === "stop") throw err.error
                    if (action === "skip") {
                        logger.warn(`Processor "${processorName}" skipped ${where}: ${err.message}`, err.error)
                        await advanceTo(event.position)
                        break
                    }
                    const delay = backoffDelay(attempt, opts.backoff)
                    const now = new Date()
                    blocked = {
                        error: err.message,
                        position: event.position,
                        eventType: event.event.type,
                        attempts: attempt,
                        since: blocked?.since ?? now,
                        nextAttemptAt: new Date(now.getTime() + delay)
                    }
                    setState("blocked", blocked)
                    logger.error(
                        `Processor "${processorName}" is blocked on ${where}: ${err.message}. ` +
                            `Retrying in ${delay} ms (attempt ${attempt}).`,
                        err.error
                    )
                    await recordBlocked(pool, processorName, tableName, blocked, currentVersion).catch(recordErr =>
                        logger.error(`Processor "${processorName}" couldn't record that it is blocked`, recordErr)
                    )
                    if (!(await sleep(delay, signal))) return false
                }
            }
            setState("running")
            processedCount++
            return true
        }

        if (opts.stopWhenCaughtUp) {
            // Read-loop mode: process all available events then exit. A page at a time, read in full before any of it
            // is handled, so no read holds a connection while a handler runs (phase 20).
            const batchSize = opts.batchSize ?? 100
            while (!signal.aborted) {
                const page: SequencedEvent[] = []
                for await (const event of eventStore.read(query, { after: position, limit: batchSize }))
                    page.push(event)
                let stop = false
                for (const event of page) {
                    if (signal.aborted || !(await handle(event))) stop = true
                    else if (stopAfter !== undefined && processedCount >= stopAfter) stop = true
                    if (stop) break
                }
                if (stop || page.length === 0) break
            }
        } else {
            // The checkpoint means "has seen everything up to X", as Emmett's does: when the events after the last
            // one handled didn't match the query, it moves past them. Without it, a wait for a position the
            // processor has no events at would time out (PLAN phase 18).
            const onCaughtUp = advanceTo

            // Subscribe mode: pages of events, and the store's shared LISTEN to wake it
            for await (const event of eventStore.subscribe(query, {
                after: position,
                pollIntervalMs,
                batchSize: opts.batchSize,
                signal,
                onCaughtUp
            })) {
                if (signal?.aborted) break
                if (!(await handle(event))) break
                if (stopAfter !== undefined && processedCount >= stopAfter) break
            }
        }

        // Stopped by a lost lock, not by its owner: end with an error, so a consumer starts it again.
        if (lock.lost.aborted && !stopSignal?.aborted) {
            throw new Error(`Processor "${processorName}" lost its lock: ${errorMessage(lock.lost.reason)}`)
        }
    } finally {
        stopSignal?.removeEventListener("abort", stopRun)
        lock.lost.removeEventListener("abort", stopRun)
        await lock.release()
    }
}
