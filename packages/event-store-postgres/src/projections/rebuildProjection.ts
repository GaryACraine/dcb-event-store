import { Pool, PoolClient } from "pg"
import { Event, EventHandler, EventStore, Query, SequencedEvent, Tags } from "@dcb-es/event-store"
import { Projection } from "./projection.js"
import { setProjectionStatus } from "./registry/projectionRegistry.js"
import { acquireExclusiveProjectionLock } from "./projectionLock.js"
import { createConsumer } from "../eventHandling/consumer.js"
import { ensureHandlersInstalled } from "../eventHandling/ensureHandlersInstalled.js"

export interface RebuildProjectionOptions {
    pool: Pool
    eventStore: EventStore
    projection: Projection
    bookmarkTableName?: string
    batchSize?: number
    pollIntervalMs?: number
}

/**
 * Rebuild a projection by truncating its read model and replaying all events
 * from the beginning.
 *
 * Flow:
 * 1. Deactivate — acquire exclusive lock, set status to 'inactive',
 *    truncate read model, reset bookmark to position 0, commit.
 * 2. Replay — create a consumer with stopWhenCaughtUp: true that processes
 *    all events from the beginning, then stops.
 * 3. Reactivate — acquire exclusive lock, set status to 'active', commit.
 */
export async function rebuildProjection(options: RebuildProjectionOptions): Promise<void> {
    const { pool, eventStore, projection } = options
    const bookmarkTableName = options.bookmarkTableName ?? "_handler_bookmarks"
    const name = projection.name
    const version = projection.version ?? 1

    // 1. Deactivate
    const client = await pool.connect()
    try {
        await client.query("BEGIN")
        await acquireExclusiveProjectionLock(client, name, version)
        await setProjectionStatus(client, { name, version, status: "inactive" })
        if (projection.truncate) {
            await projection.truncate(client)
        }
        // Reset bookmark to position 0
        await client.query(
            `UPDATE ${bookmarkTableName} SET last_sequence_position = 0, version = 1, instance_id = NULL WHERE handler_id = $1`,
            [name]
        )
        await client.query("COMMIT")
    } catch (err) {
        await client.query("ROLLBACK").catch(() => {})
        throw err
    } finally {
        client.release()
    }

    // 2. Replay — ensure handler row exists, then run consumer with stopWhenCaughtUp
    await ensureHandlersInstalled(pool, [name], bookmarkTableName)

    // Re-run init to recreate tables if truncate dropped them
    const initClient = await pool.connect()
    try {
        await initClient.query("BEGIN")
        if (projection.init) await projection.init(initClient)
        await initClient.query("COMMIT")
    } catch (err) {
        await initClient.query("ROLLBACK").catch(() => {})
        throw err
    } finally {
        initClient.release()
    }

    const eventTypes = projection.canHandle

    const consumer = createConsumer({
        pool,
        eventStore,
        bookmarkTableName,
        processors: [
            {
                processorName: name,
                query: Query.fromItems([{ types: eventTypes }]),
                handlerFactory: (txClient: PoolClient): EventHandler<Event, Tags> => ({
                    when: Object.fromEntries(
                        eventTypes.map(type => [
                            type,
                            async (event: SequencedEvent) => {
                                await projection.handle([event], { client: txClient })
                            }
                        ])
                    ) as EventHandler<Event, Tags>["when"]
                }),
                startFrom: "BEGINNING" as const,
                batchSize: options.batchSize,
                pollIntervalMs: options.pollIntervalMs,
                stopWhenCaughtUp: true
            }
        ]
    })

    // Wait for replay to complete
    await Promise.all(consumer.processors.map(p => p.promise))

    // 3. Reactivate
    const reactivateClient = await pool.connect()
    try {
        await reactivateClient.query("BEGIN")
        await acquireExclusiveProjectionLock(reactivateClient, name, version)
        await setProjectionStatus(reactivateClient, { name, version, status: "active" })
        await reactivateClient.query("COMMIT")
    } catch (err) {
        await reactivateClient.query("ROLLBACK").catch(() => {})
        throw err
    } finally {
        reactivateClient.release()
    }
}
