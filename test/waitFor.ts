/** Wait until `check` is true, polling every 20 ms, or fail after `timeoutMs`. For tests: waits on state, not time. */
export async function waitFor(
    description: string,
    check: () => boolean | Promise<boolean>,
    timeoutMs = 5000
): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        if (await check()) return
        await new Promise(r => setTimeout(r, 20))
    }
    throw new Error(`Timed out after ${timeoutMs} ms waiting for: ${description}`)
}

/** Collects uncaught exceptions while a test runs (a terminated connection with no `error` listener is one). */
export function collectUncaught(): { errors: unknown[]; stop: () => void } {
    const errors: unknown[] = []
    const onError = (err: unknown) => errors.push(err)
    process.on("uncaughtException", onError)
    return { errors, stop: () => process.off("uncaughtException", onError) }
}
