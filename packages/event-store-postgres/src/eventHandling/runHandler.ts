import { Pool, PoolClient } from "pg"
import { EventHandler, EventStore } from "@dcb-es/event-store"
import { createProcessor } from "./processor.js"

export interface HandlerRunnerOptions {
    pool: Pool
    eventStore: EventStore
    handlerName: string
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handlerFactory: (client: PoolClient) => EventHandler<any, any>
    bookmarkTableName?: string
    signal?: AbortSignal
}

export interface RunningHandler {
    promise: Promise<void>
}

/**
 * Start a subscribe-based handler that processes events and atomically
 * updates a bookmark + fires NOTIFY on bookmark advance.
 *
 * This is a thin backward-compatible wrapper around `createProcessor`.
 * Prefer `createProcessor` for new code — it supports batching,
 * start-position policies, and stop conditions.
 */
export function runHandler(options: HandlerRunnerOptions): RunningHandler {
    const processor = createProcessor({
        pool: options.pool,
        eventStore: options.eventStore,
        processorName: options.handlerName,
        handlerFactory: options.handlerFactory,
        bookmarkTableName: options.bookmarkTableName,
        signal: options.signal,
        batchSize: 1,
        startFrom: "BEGINNING"
    })

    return { promise: processor.promise }
}
