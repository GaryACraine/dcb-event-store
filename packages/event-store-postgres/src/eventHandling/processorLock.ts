import { Pool } from "pg"
import { LockHolder } from "./lockHolder.js"

export interface ProcessorLockHandle {
    acquired: boolean
    release: () => Promise<void>
    /** Aborts when the lock is lost with its connection (never, when it wasn't acquired). */
    lost: AbortSignal
}

/**
 * Acquire a session-scoped advisory lock for processor instance ownership.
 *
 * Uses `pg_try_advisory_lock` (NOT `_xact_`) so the lock spans the processor's
 * entire lifetime, not just one transaction. The lock is held on a `LockHolder`'s
 * session, which can't go back to the pool while it holds a lock. A consumer
 * shares one holder among its processors (phase 20); without one, the lock
 * gets a holder, and so a connection, of its own.
 *
 * Requires session-mode connections (invariant 7).
 */
export async function acquireProcessorLock(
    pool: Pool,
    processorName: string,
    holder: LockHolder = new LockHolder(pool)
): Promise<ProcessorLockHandle> {
    const lock = await holder.acquire(processorName)
    if (!lock) return { acquired: false, release: async () => {}, lost: new AbortController().signal }
    return { acquired: true, release: lock.release, lost: lock.lost }
}
