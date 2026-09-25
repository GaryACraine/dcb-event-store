import { Notification, Pool } from "pg"
import { SequencePosition, WaitTimeoutError } from "@dcb-es/event-store"

/**
 * Wait until a handler's bookmark has reached (or passed) the given position.
 *
 * A processor's bookmark means "has seen everything up to X" (phase 18): it moves past events the handler doesn't
 * handle, so waiting on any position works, not only the positions of events the handler handles.
 *
 * Strategy: poll with short backoff first (avoids holding a LISTEN connection
 * for the common fast case), then fall back to LISTEN+poll for the slow case.
 * LISTEN is established before the first slow-path check to prevent the
 * TOCTOU race where a notification fires between check and LISTEN.
 *
 * @throws WaitTimeoutError (a 504) when the bookmark doesn't get there within `timeoutMs`.
 */
export async function waitUntilProcessed(
    pool: Pool,
    handlerName: string,
    position: SequencePosition,
    options?: { timeoutMs?: number; bookmarkTableName?: string }
): Promise<void> {
    const timeoutMs = options?.timeoutMs ?? 5000
    const tableName = options?.bookmarkTableName ?? "_handler_bookmarks"
    const deadline = Date.now() + timeoutMs

    // Fast poll phase — most events process in <50ms, so avoid holding a LISTEN
    // connection for the common case. Three quick checks with backoff.
    const pollDelays = [5, 15, 30]
    for (const delay of pollDelays) {
        if (await hasReachedPosition(pool, tableName, handlerName, position)) return
        if (Date.now() + delay > deadline) break
        await new Promise(r => setTimeout(r, delay))
    }
    if (await hasReachedPosition(pool, tableName, handlerName, position)) return

    // Slow path. One notification listener for the whole wait, removed at the end: one registered per 100 ms wait
    // outlives it when the timer wins, and piles up (Emmett PR #405's lesson). Only this handler's bookmark
    // notifications wake it; every processor notifies on the same channel.
    let notified = false
    let wake: (() => void) | null = null
    const onNotification = (msg: Notification) => {
        if (!msg.payload?.startsWith(`${handlerName}:`)) return
        notified = true
        wake?.()
    }

    const client = await pool.connect()
    client.on("notification", onNotification)
    try {
        // LISTEN first, then check — prevents lost notifications
        await client.query(`LISTEN ${tableName}`)

        while (Date.now() < deadline) {
            notified = false
            if (await hasReachedPosition(pool, tableName, handlerName, position)) return

            const remaining = deadline - Date.now()
            if (remaining <= 0) break
            if (notified) continue

            await new Promise<void>(resolve => {
                const timeout = setTimeout(() => done(), Math.min(100, remaining))
                const done = () => {
                    clearTimeout(timeout)
                    wake = null
                    resolve()
                }
                wake = done
            })
        }

        throw new WaitTimeoutError(handlerName, position.toString(), timeoutMs)
    } finally {
        client.removeListener("notification", onNotification)
        await client.query(`UNLISTEN ${tableName}`).catch(() => {})
        client.release()
    }
}

// pool.query() internally acquires and releases its own connection
async function hasReachedPosition(
    pool: Pool,
    tableName: string,
    handlerName: string,
    position: SequencePosition
): Promise<boolean> {
    const result = await pool.query(`SELECT last_sequence_position FROM ${tableName} WHERE handler_id = $1`, [
        handlerName
    ])
    if (result.rows.length === 0) return false
    const current = SequencePosition.fromString(String(result.rows[0].last_sequence_position))
    return current.isAfter(position) || current.equals(position)
}
