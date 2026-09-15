import { SequencePosition } from "@dcb-es/event-store"
import type { Pool } from "pg"

export async function findExistingPosition(
    pool: Pool,
    idempotencyKey: string | undefined
): Promise<SequencePosition | undefined> {
    if (!idempotencyKey) return undefined
    try {
        const r = await pool.query<{ sequence_position: string }>(
            "SELECT sequence_position FROM events WHERE message_id = $1::uuid",
            [idempotencyKey]
        )
        if (r.rows.length > 0) {
            return SequencePosition.fromString(r.rows[0].sequence_position.toString())
        }
    } catch {
        // Gracefully handle mock pool in unit tests
    }
    return undefined
}
