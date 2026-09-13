import { Pool, PoolClient } from "pg"
import { processorLockKey } from "../eventStore/advisoryLocks.js"

export interface ProcessorLockHandle {
    acquired: boolean
    release: () => Promise<void>
}

/**
 * Acquire a session-scoped advisory lock for processor instance ownership.
 *
 * Uses `pg_try_advisory_lock` (NOT `_xact_`) so the lock spans the processor's
 * entire lifetime, not just one transaction. A dedicated client is held for the
 * lock's lifetime because advisory locks are session-scoped — returning the
 * client to the pool would release the lock.
 *
 * Requires session-mode connections (invariant 7).
 */
export async function acquireProcessorLock(pool: Pool, processorName: string): Promise<ProcessorLockHandle> {
    const key = processorLockKey(processorName)
    const client: PoolClient = await pool.connect()

    try {
        const result = await client.query<{ pg_try_advisory_lock: boolean }>("SELECT pg_try_advisory_lock($1)", [
            key.toString()
        ])
        const acquired = result.rows[0].pg_try_advisory_lock

        if (!acquired) {
            client.release()
            return { acquired: false, release: async () => {} }
        }

        let released = false
        return {
            acquired: true,
            release: async () => {
                if (released) return
                released = true
                try {
                    await client.query("SELECT pg_advisory_unlock($1)", [key.toString()])
                } finally {
                    client.release()
                }
            }
        }
    } catch (err) {
        client.release()
        throw err
    }
}
