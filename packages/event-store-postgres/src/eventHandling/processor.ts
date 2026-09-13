import { Pool, PoolClient } from "pg"
import { EventHandler, EventStore, Query, Tags } from "@dcb-es/event-store"
import { acquireProcessorLock, ProcessorLockHandle } from "./processorLock.js"
import { readCheckpoint, storeCheckpoint, Checkpoint } from "./checkpointer.js"
import { resolveStartPosition, StartPosition } from "./startPositions.js"
import { v4 as uuid } from "uuid"

export interface ProcessorOptions {
    pool: Pool
    eventStore: EventStore
    processorName: string
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handlerFactory: (client: PoolClient) => EventHandler<any, any>
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
}

export interface RunningProcessor {
    promise: Promise<void>
    instanceId: string
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
 * The returned promise resolves when the signal is aborted or stopAfter is
 * reached, and rejects on unrecoverable error (handler throw, lock stolen).
 */
export function createProcessor(options: ProcessorOptions): RunningProcessor {
    const { pool, eventStore, processorName, handlerFactory, signal, stopAfter } = options
    const tableName = options.bookmarkTableName ?? "_handler_bookmarks"
    const pollIntervalMs = options.pollIntervalMs ?? 100
    const startFrom = options.startFrom ?? "BEGINNING"
    const instanceId = options.instanceId ?? uuid()

    if (processorName.includes(":")) {
        throw new Error(`Processor name "${processorName}" must not contain ":" (used as notification delimiter)`)
    }

    const promise = runProcessor({
        pool,
        eventStore,
        processorName,
        handlerFactory,
        query: options.query,
        tableName,
        pollIntervalMs,
        startFrom,
        stopAfter,
        stopWhenCaughtUp: options.stopWhenCaughtUp,
        signal,
        instanceId
    })

    return { promise, instanceId }
}

interface InternalProcessorOptions {
    pool: Pool
    eventStore: EventStore
    processorName: string
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handlerFactory: (client: PoolClient) => EventHandler<any, any>
    query?: Query
    tableName: string
    pollIntervalMs: number
    startFrom: StartPosition
    stopAfter?: number
    stopWhenCaughtUp?: boolean
    signal?: AbortSignal
    instanceId: string
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
        signal,
        instanceId
    } = opts

    // 1. Acquire session-scoped processor lock
    const lock: ProcessorLockHandle = await acquireProcessorLock(pool, processorName)
    if (!lock.acquired) {
        throw new Error(`Processor lock not acquired for "${processorName}" — another instance is running`)
    }

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

        // 4. Build query from handler (or use pre-built query from options)
        let query: Query
        if (opts.query) {
            query = opts.query
        } else {
            let sampleHandler
            try {
                sampleHandler = handlerFactory(null as unknown as PoolClient)
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

        // 5. Process events
        let processedCount = 0

        const processEvent = async (event: import("@dcb-es/event-store").SequencedEvent): Promise<void> => {
            const client = await pool.connect()
            try {
                await client.query("BEGIN")

                const handler = handlerFactory(client)
                if (handler.when[event.event.type]) {
                    await handler.when[event.event.type](event)
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
                    await client.query("ROLLBACK").catch(() => {})
                    client.release()
                    throw new Error(`Checkpoint version mismatch for "${processorName}" — lock may have been stolen`)
                }

                await client.query("COMMIT")
                position = event.position
                currentVersion++
                processedCount++
            } catch (err) {
                await client.query("ROLLBACK").catch(() => {})
                throw err
            } finally {
                client.release()
            }
        }

        if (opts.stopWhenCaughtUp) {
            // Read-loop mode: process all available events then exit
            while (!signal?.aborted) {
                let hadEvents = false
                for await (const event of eventStore.read(query, { after: position })) {
                    if (signal?.aborted) break
                    await processEvent(event)
                    hadEvents = true
                    if (stopAfter !== undefined && processedCount >= stopAfter) break
                }
                if (!hadEvents || (stopAfter !== undefined && processedCount >= stopAfter)) break
            }
        } else {
            // Subscribe mode: persistent cursor + LISTEN wakeup
            for await (const event of eventStore.subscribe(query, { after: position, pollIntervalMs, signal })) {
                if (signal?.aborted) break
                await processEvent(event)
                if (stopAfter !== undefined && processedCount >= stopAfter) break
            }
        }
    } finally {
        await lock.release()
    }
}
