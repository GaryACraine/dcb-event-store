/**
 * How long a blocked processor waits before it tries again (phase 19): `initialMs`, doubling on each attempt, capped
 * at `maxMs`. Axon 5 claims a failed segment again after a backoff that grows in the same way.
 */
export interface Backoff {
    /** The first wait, in ms (default 1000). */
    initialMs?: number
    /** The longest wait, in ms (default 60000). */
    maxMs?: number
}

export function backoffDelay(attempt: number, backoff: Backoff = {}): number {
    const initialMs = backoff.initialMs ?? 1000
    const maxMs = backoff.maxMs ?? 60_000
    return Math.min(maxMs, initialMs * 2 ** Math.max(0, attempt - 1))
}

/** Wait `ms`, or less if `signal` aborts. True when the wait ran its course, false when it was aborted. */
export function sleep(ms: number, signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) return Promise.resolve(false)
    return new Promise(resolve => {
        const onAbort = () => {
            clearTimeout(timer)
            resolve(false)
        }
        const timer = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort)
            resolve(true)
        }, ms)
        signal?.addEventListener("abort", onAbort, { once: true })
    })
}

export const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error))
