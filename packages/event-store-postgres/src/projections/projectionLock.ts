import { PoolClient } from "pg"
import { projectionLockKey } from "../eventStore/advisoryLocks.js"

export interface SharedProjectionLockResult {
    acquired: boolean
    isActive: boolean
}

/**
 * Try to acquire a shared xact-scoped lock for a projection.
 * Handlers call this before processing events. If the lock cannot be acquired
 * (a rebuilder holds the exclusive lock) or the projection is inactive, the
 * handler should skip.
 */
export async function tryAcquireSharedProjectionLock(
    client: PoolClient,
    name: string,
    version: number
): Promise<SharedProjectionLockResult> {
    const key = projectionLockKey(name, version)
    const lockResult = await client.query<{ pg_try_advisory_xact_lock_shared: boolean }>(
        "SELECT pg_try_advisory_xact_lock_shared($1)",
        [key.toString()]
    )
    const acquired = lockResult.rows[0].pg_try_advisory_xact_lock_shared

    const statusResult = await client.query<{ status: string }>(
        "SELECT status FROM _projections WHERE name = $1 AND version = $2",
        [name, version]
    )
    // No row found → treat as active (backward compat for unregistered projections)
    const isActive = statusResult.rows.length === 0 || statusResult.rows[0].status === "active"

    return { acquired, isActive }
}

/**
 * Acquire an exclusive xact-scoped lock for a projection.
 * Rebuilders call this to block all handlers while truncating and replaying.
 * This is blocking — it waits until all shared locks are released.
 */
export async function acquireExclusiveProjectionLock(client: PoolClient, name: string, version: number): Promise<void> {
    const key = projectionLockKey(name, version)
    await client.query("SELECT pg_advisory_xact_lock($1)", [key.toString()])
}
