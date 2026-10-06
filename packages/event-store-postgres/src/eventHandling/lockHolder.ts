import { Pool, PoolClient } from "pg"
import { processorLockKey } from "../eventStore/advisoryLocks.js"

/** A processor's lock, taken through a `LockHolder`. */
export interface HeldLock {
    /** Unlock it. Idempotent; a no-op once the lock was lost. */
    release: () => Promise<void>
    /** Aborts when the holder's connection ends, and the lock with it. */
    lost: AbortSignal
}

/**
 * One session that holds many processors' advisory locks (phase 20, kit ADR-047).
 *
 * A processor's lock is session-scoped (`pg_try_advisory_lock`), so the connection that holds it can't go back to
 * the pool. With one connection per processor, an app's connections grew with its processors; a consumer now holds
 * all of its processors' locks on one.
 *
 * - Advisory locks are re-entrant within a session, so the holder refuses a second `acquire` of a name it already
 *   holds itself: one session can't tell two owners apart.
 * - When the connection errors or ends, every lock on it is gone: each `lost` signal aborts, so its processor stops
 *   rather than run unowned. The next `acquire` opens a new connection.
 * - The connection goes back to the pool once its last lock is released.
 *
 * Calls run one at a time: a session runs one query at a time anyway, and each takes microseconds.
 */
export class LockHolder {
    private client: PoolClient | undefined
    private detach: (() => void) | undefined
    private lostController = new AbortController()
    private held = new Set<string>()
    private queue: Promise<unknown> = Promise.resolve()

    constructor(private readonly pool: Pool) {}

    /** Take `processorName`'s lock. Null when another session holds it, or this holder already does. */
    acquire(processorName: string): Promise<HeldLock | null> {
        return this.serially(async () => {
            if (this.held.has(processorName)) return null
            const client = await this.connect()
            const lost = this.lostController.signal
            const key = processorLockKey(processorName).toString()
            let acquired: boolean
            try {
                const result = await client.query<{ acquired: boolean }>(
                    "SELECT pg_try_advisory_lock($1) AS acquired",
                    [key]
                )
                acquired = result.rows[0].acquired
            } catch (err) {
                this.lose(client, err)
                throw err
            }
            if (!acquired) {
                this.closeIfIdle()
                return null
            }
            this.held.add(processorName)

            let released = false
            const release = async (): Promise<void> => {
                if (released) return
                released = true
                await this.serially(async () => {
                    // The session is gone, and the lock with it; a new session may hold the name now.
                    if (lost.aborted) return
                    this.held.delete(processorName)
                    try {
                        await client.query("SELECT pg_advisory_unlock($1)", [key])
                    } catch (err) {
                        this.lose(client, err)
                        return
                    }
                    this.closeIfIdle()
                })
            }
            return { release, lost }
        })
    }

    private async connect(): Promise<PoolClient> {
        if (this.client) return this.client
        const client = await this.pool.connect()
        // Without an `error` listener, a connection terminated while checked out is an uncaught exception.
        const onError = (err: Error) => this.lose(client, err)
        const onEnd = () => this.lose(client, new Error("the lock connection ended"))
        client.on("error", onError)
        client.on("end", onEnd)
        this.detach = () => {
            client.removeListener("error", onError)
            client.removeListener("end", onEnd)
        }
        this.client = client
        return client
    }

    private lose(client: PoolClient, err: unknown): void {
        if (this.client !== client) return
        this.detach?.()
        this.client = undefined
        this.detach = undefined
        this.held.clear()
        // A late error from the dying connection mustn't be an uncaught exception.
        client.on("error", () => {})
        // A broken connection goes back with its error, so the pool discards it.
        client.release(err instanceof Error ? err : new Error(String(err)))
        const lost = this.lostController
        this.lostController = new AbortController()
        lost.abort(err)
    }

    private closeIfIdle(): void {
        if (this.held.size > 0 || !this.client) return
        this.detach?.()
        this.client.release()
        this.client = undefined
        this.detach = undefined
    }

    private serially<T>(work: () => Promise<T>): Promise<T> {
        const run = this.queue.then(work, work)
        this.queue = run.catch(() => {})
        return run
    }
}
