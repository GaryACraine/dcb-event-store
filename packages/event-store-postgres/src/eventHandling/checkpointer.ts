import { Pool, PoolClient } from "pg"
import { SequencePosition } from "@dcb-es/event-store"

export interface Checkpoint {
    position: SequencePosition
    version: bigint
}

export type StoreResult = "SUCCESS" | "VERSION_MISMATCH"

/**
 * Read the current checkpoint for a processor from the bookmark table.
 */
export async function readCheckpoint(
    pool: Pool | PoolClient,
    processorName: string,
    tableName: string
): Promise<Checkpoint> {
    const result = await pool.query(`SELECT last_sequence_position, version FROM ${tableName} WHERE handler_id = $1`, [
        processorName
    ])
    const row = result.rows[0]
    if (!row) {
        throw new Error(`Handler "${processorName}" not found in ${tableName}. Call ensureHandlersInstalled first.`)
    }
    return {
        position: SequencePosition.fromString(String(row.last_sequence_position)),
        version: BigInt(row.version)
    }
}

/**
 * CAS-based checkpoint store. Updates the bookmark only if the version matches,
 * preventing double-processing when a lock is lost (defense-in-depth).
 *
 * When called inside a per-event transaction (with a PoolClient), also fires
 * pg_notify for waitUntilProcessed compatibility.
 */
export async function storeCheckpoint(
    client: Pool | PoolClient,
    processorName: string,
    tableName: string,
    newPosition: SequencePosition,
    expectedVersion: bigint,
    instanceId: string
): Promise<StoreResult> {
    const result = await client.query(
        `UPDATE ${tableName}
         SET last_sequence_position = $1,
             version = version + 1,
             instance_id = $2,
             last_updated = now()
         WHERE handler_id = $3
           AND version = $4`,
        [newPosition.toString(), instanceId, processorName, expectedVersion.toString()]
    )

    if (result.rowCount === 0) return "VERSION_MISMATCH"

    // Fire NOTIFY for waitUntilProcessed compatibility
    await client.query("SELECT pg_notify($1, $2)", [tableName, `${processorName}:${newPosition.toString()}`])

    return "SUCCESS"
}
