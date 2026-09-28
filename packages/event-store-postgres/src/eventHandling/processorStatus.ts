import { Pool, PoolClient } from "pg"
import { SequencePosition } from "@dcb-es/event-store"

export type ProcessorState = "starting" | "running" | "blocked" | "restarting" | "stopped"

/** Why a processor is blocked: its handler keeps failing on one event, which it retries (phase 19). */
export interface BlockedStatus {
    error: string
    /** The event it's blocked on. */
    position: SequencePosition
    eventType: string
    attempts: number
    since: Date
    nextAttemptAt: Date
}

/** Why a consumer is starting a processor again: its last run ended with an error. */
export interface RestartStatus {
    error: string
    attempts: number
    nextAttemptAt: Date
}

/** A running processor's own view of itself (`RunningProcessor.status()`). */
export interface ProcessorStatus {
    processorName: string
    state: ProcessorState
    /** Its checkpoint, once it has read it. */
    position?: SequencePosition
    blocked?: BlockedStatus
    restart?: RestartStatus
}

/** What the bookmark table records of a processor, for any instance or `psql` to see. */
export interface StoredProcessorStatus {
    processorName: string
    position: SequencePosition
    instanceId: string | null
    lastUpdated: Date
    blocked?: { error: string; position: SequencePosition; attempts: number; since: Date }
}

/** Every processor in the bookmark table, with the event it's blocked on, if any. */
export async function readProcessorStatuses(
    pool: Pool | PoolClient,
    tableName = "_handler_bookmarks"
): Promise<StoredProcessorStatus[]> {
    const result = await pool.query(
        `SELECT handler_id, last_sequence_position, instance_id, last_updated,
                blocked_error, blocked_position, blocked_attempts, blocked_since
         FROM ${tableName} ORDER BY handler_id`
    )
    return result.rows.map(row => ({
        processorName: row.handler_id,
        position: SequencePosition.fromString(String(row.last_sequence_position)),
        instanceId: row.instance_id,
        lastUpdated: row.last_updated,
        ...(row.blocked_since
            ? {
                  blocked: {
                      error: row.blocked_error,
                      position: SequencePosition.fromString(String(row.blocked_position)),
                      attempts: Number(row.blocked_attempts),
                      since: row.blocked_since
                  }
              }
            : {})
    }))
}

/**
 * Record in the bookmark row that a processor is blocked. It doesn't move the checkpoint or its version; the next
 * checkpoint clears it (`storeCheckpoint`). Only the instance holding that version writes it.
 */
export async function recordBlocked(
    pool: Pool,
    processorName: string,
    tableName: string,
    blocked: BlockedStatus,
    expectedVersion: bigint
): Promise<void> {
    await pool.query(
        `UPDATE ${tableName}
         SET blocked_error = $1, blocked_position = $2, blocked_attempts = $3, blocked_since = $4
         WHERE handler_id = $5 AND version = $6`,
        [
            blocked.error,
            blocked.position.toString(),
            blocked.attempts,
            blocked.since,
            processorName,
            expectedVersion.toString()
        ]
    )
}
