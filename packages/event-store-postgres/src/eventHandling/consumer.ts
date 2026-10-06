import { Pool } from "pg"
import { EventStore, Query, SequencedEvent } from "@dcb-es/event-store"
import {
    assertProcessorName,
    createProcessor,
    ErrorAction,
    HandlerFactory,
    ProcessorLogger,
    RunningProcessor
} from "./processor.js"
import { StartPosition } from "./startPositions.js"
import { Backoff, backoffDelay, errorMessage, sleep } from "./backoff.js"
import { ProcessorStatus, RestartStatus } from "./processorStatus.js"
import { LockHolder } from "./lockHolder.js"
import { v4 as uuid } from "uuid"

/** A consumer's processors retry or skip; a stop would only end the run the consumer then starts again. */
export type ConsumerErrorAction = Exclude<ErrorAction, "stop">
export type ConsumerOnHandlerError =
    | ConsumerErrorAction
    | ((error: unknown, event: SequencedEvent) => ConsumerErrorAction)

export interface ConsumerProcessorConfig {
    processorName: string
    handlerFactory: HandlerFactory
    query?: Query
    batchSize?: number
    pollIntervalMs?: number
    startFrom?: StartPosition
    stopAfter?: number
    stopWhenCaughtUp?: boolean
    /** What to do when the handler throws. Default `"retry"` (block and retry the same event). */
    onError?: ConsumerOnHandlerError
    /** The wait between retries, and before a restart. Default 1 s, doubling to 60 s. */
    backoff?: Backoff
}

export interface ConsumerOptions {
    pool: Pool
    eventStore: EventStore
    processors: ConsumerProcessorConfig[]
    bookmarkTableName?: string
    signal?: AbortSignal
    /** Where retries, skips and restarts are reported. Default `console`. */
    logger?: ProcessorLogger
}

export interface RunningConsumer {
    stop: () => Promise<void>
    processors: RunningProcessor[]
    /** Each processor's status, in the order configured. */
    status: () => ProcessorStatus[]
}

/**
 * Create a consumer that wraps one or more processors with shared lifecycle.
 * `stop()` aborts all processors and resolves when all are done.
 *
 * A consumer never loses a processor (phase 19): when one ends with an error
 * (its lock held by another instance, a lost lock or connection), the consumer
 * logs it and starts it again after a backoff, until it's stopped. A
 * processor's promise only settles when it's stopped or done.
 *
 * Its processors hold their locks on one connection between them (phase 20):
 * when that connection is lost, they all stop at once and start again on a
 * new one.
 */
export function createConsumer(options: ConsumerOptions): RunningConsumer {
    if (options.processors.length === 0) {
        throw new Error("Consumer requires at least one processor configuration")
    }
    options.processors.forEach(config => assertProcessorName(config.processorName))

    const internalController = new AbortController()

    // Chain external signal to internal controller
    if (options.signal) {
        if (options.signal.aborted) {
            internalController.abort()
        } else {
            options.signal.addEventListener("abort", () => internalController.abort(), { once: true })
        }
    }

    const lockHolder = new LockHolder(options.pool)
    const processors: RunningProcessor[] = options.processors.map(config =>
        superviseProcessor(options, config, internalController.signal, lockHolder)
    )

    let stopped = false

    const stop = async (): Promise<void> => {
        if (stopped) return
        stopped = true
        internalController.abort()
        await Promise.allSettled(processors.map(p => p.promise))
    }

    return { stop, processors, status: () => processors.map(p => p.status()) }
}

function superviseProcessor(
    options: ConsumerOptions,
    config: ConsumerProcessorConfig,
    signal: AbortSignal,
    lockHolder: LockHolder
): RunningProcessor {
    const instanceId = uuid()
    const logger = options.logger ?? console
    let current: RunningProcessor | undefined
    let restart: RestartStatus | undefined

    const start = () =>
        createProcessor({
            pool: options.pool,
            eventStore: options.eventStore,
            processorName: config.processorName,
            handlerFactory: config.handlerFactory,
            query: config.query,
            bookmarkTableName: options.bookmarkTableName,
            batchSize: config.batchSize,
            pollIntervalMs: config.pollIntervalMs,
            startFrom: config.startFrom,
            stopAfter: config.stopAfter,
            stopWhenCaughtUp: config.stopWhenCaughtUp,
            onError: config.onError,
            backoff: config.backoff,
            logger,
            signal,
            instanceId,
            lockHolder
        })

    const promise = (async () => {
        let failures = 0
        while (!signal.aborted) {
            try {
                current = start()
                await current.promise
                return
            } catch (err) {
                if (signal.aborted) return
                // A run that got its lock and checkpoint was going; count the failures since then.
                failures = current?.status().position !== undefined ? 1 : failures + 1
                const delay = backoffDelay(failures, config.backoff)
                restart = { error: errorMessage(err), attempts: failures, nextAttemptAt: new Date(Date.now() + delay) }
                logger.error(
                    `Processor "${config.processorName}" stopped: ${restart.error}. ` +
                        `Starting it again in ${delay} ms (attempt ${failures}).`,
                    err
                )
                if (!(await sleep(delay, signal))) return
            }
        }
    })()

    const status = (): ProcessorStatus => {
        const now = current?.status() ?? { processorName: config.processorName, state: "starting" as const }
        if (now.state === "running" || now.state === "blocked") restart = undefined
        return restart && !signal.aborted ? { ...now, state: "restarting", restart } : now
    }

    return { promise, instanceId, status }
}
