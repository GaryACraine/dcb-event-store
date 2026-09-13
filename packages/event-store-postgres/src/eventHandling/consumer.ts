import { Pool, PoolClient } from "pg"
import { EventHandler, EventStore, Query } from "@dcb-es/event-store"
import { createProcessor, RunningProcessor } from "./processor.js"
import { StartPosition } from "./startPositions.js"

export interface ConsumerProcessorConfig {
    processorName: string
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handlerFactory: (client: PoolClient) => EventHandler<any, any>
    query?: Query
    batchSize?: number
    pollIntervalMs?: number
    startFrom?: StartPosition
    stopAfter?: number
    stopWhenCaughtUp?: boolean
}

export interface ConsumerOptions {
    pool: Pool
    eventStore: EventStore
    processors: ConsumerProcessorConfig[]
    bookmarkTableName?: string
    signal?: AbortSignal
}

export interface RunningConsumer {
    stop: () => Promise<void>
    processors: RunningProcessor[]
}

/**
 * Create a consumer that wraps one or more processors with shared lifecycle.
 * `stop()` aborts all processors and resolves when all are done.
 */
export function createConsumer(options: ConsumerOptions): RunningConsumer {
    if (options.processors.length === 0) {
        throw new Error("Consumer requires at least one processor configuration")
    }

    const internalController = new AbortController()

    // Chain external signal to internal controller
    if (options.signal) {
        if (options.signal.aborted) {
            internalController.abort()
        } else {
            options.signal.addEventListener("abort", () => internalController.abort(), { once: true })
        }
    }

    const processors: RunningProcessor[] = options.processors.map(config =>
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
            signal: internalController.signal
        })
    )

    let stopped = false

    const stop = async (): Promise<void> => {
        if (stopped) return
        stopped = true
        internalController.abort()
        await Promise.allSettled(processors.map(p => p.promise))
    }

    return { stop, processors }
}
