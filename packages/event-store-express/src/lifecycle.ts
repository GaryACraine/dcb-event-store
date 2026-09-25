/**
 * Graceful shutdown, adapted from Emmett's `onShutdown` (`emmett/src/utils/lifecycle/gracefulShutdown.ts`) with its
 * PR #406 fix: one process listener per signal, however many handlers, removed when the last handler is.
 *
 * Two things ours adds, which a server with an SSE feed needs:
 * - A handler runs once per shutdown. `server.close()` waits for open connections and an event feed never ends, so
 *   the first Ctrl-C used to leave the process running and the second ran the shutdown again (ending the pool twice).
 * - A second signal during a shutdown exits at once (130 for SIGINT, 143 for SIGTERM). With a listener registered,
 *   Node no longer exits on Ctrl-C by itself, so a hung shutdown would otherwise need `kill -9`.
 */

export type ShutdownHandler = () => void | Promise<void>

const SIGNALS = ["SIGTERM", "SIGINT"] as const
const EXIT_CODES: Record<(typeof SIGNALS)[number], number> = { SIGINT: 130, SIGTERM: 143 }

const handlers = new Set<ShutdownHandler>()
let shuttingDown = false

const onSignal = (signal: (typeof SIGNALS)[number]) => {
    if (shuttingDown) {
        process.exit(EXIT_CODES[signal])
        return
    }
    shuttingDown = true
    for (const handler of [...handlers]) {
        Promise.resolve()
            .then(handler)
            .catch((err: unknown) => console.error("Shutdown handler failed:", err))
    }
}
const listeners = Object.fromEntries(SIGNALS.map(signal => [signal, () => onSignal(signal)])) as Record<
    (typeof SIGNALS)[number],
    () => void
>

/**
 * Registers `handler` to run when the process receives SIGTERM or SIGINT. Returns a function that unregisters it.
 * Register the whole shutdown once: stop taking requests (`stopAPI`), stop consumers, then end the pool.
 */
export function onShutdown(handler: ShutdownHandler): () => void {
    if (handlers.size === 0) for (const signal of SIGNALS) process.on(signal, listeners[signal])
    handlers.add(handler)

    return () => {
        if (!handlers.delete(handler)) return
        if (handlers.size > 0) return
        for (const signal of SIGNALS) process.off(signal, listeners[signal])
        shuttingDown = false
    }
}
