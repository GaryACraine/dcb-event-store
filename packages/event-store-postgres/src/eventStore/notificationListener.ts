import { Notification, Pool, PoolClient } from "pg"
import { Backoff, backoffDelay, errorMessage, sleep } from "../eventHandling/backoff.js"

/**
 * Called with a notification's payload. Called with `undefined` when notifications may have been missed (the
 * connection was lost, or is back): check again rather than wait.
 */
export type NotificationHandler = (payload: string | undefined) => void

export interface NotificationListenerOptions {
    /** The wait before reconnecting after the connection is lost. Default 500 ms, doubling to 30 s. */
    backoff?: Backoff
    /** Where a lost connection and a failed reconnect are reported. Default `console`. */
    logger?: { warn: (message: string, error?: unknown) => void }
}

/**
 * One `LISTEN` connection shared by everything in this process that waits for a notification (phase 20, kit
 * ADR-047): a store's subscriptions on its events channel, and `waitUntilProcessed` on a bookmark table's.
 *
 * A `LISTEN` needs a connection of its own for as long as it listens. With one per subscriber, an app's connections
 * grew with its processors; now it holds one, whatever their number.
 *
 * - The connection opens with the first `listen` and goes back to the pool when the last one stops.
 * - When `listen` resolves, its channel is listened on, so a check made after it can't miss a notification.
 * - If the connection is lost, every handler is called with `undefined` (they poll meanwhile), and the listener
 *   reconnects after a backoff. Once back, every handler is called with `undefined` again, since notifications were
 *   missed while it was down.
 */
export class NotificationListener {
    private client: PoolClient | undefined
    private detach: (() => void) | undefined
    private handlers = new Map<string, Set<NotificationHandler>>()
    private reconnecting = false
    private queue: Promise<unknown> = Promise.resolve()

    constructor(
        private readonly pool: Pool,
        private readonly options: NotificationListenerOptions = {}
    ) {}

    /**
     * Listen on `channel` until the returned `stop` is called. `channel` is an identifier the caller trusts (a
     * table name). Rejects only when there is no connection and none can be opened.
     */
    listen(channel: string, handler: NotificationHandler): Promise<() => Promise<void>> {
        return this.serially(async () => {
            let channelHandlers = this.handlers.get(channel)
            const newChannel = !channelHandlers
            if (!channelHandlers) {
                channelHandlers = new Set()
                this.handlers.set(channel, channelHandlers)
            }
            channelHandlers.add(handler)

            if (this.client) {
                if (newChannel) {
                    const client = this.client
                    await client.query(`LISTEN ${channel}`).catch(err => this.lose(client, err))
                }
            } else if (!this.reconnecting) {
                try {
                    await this.connect()
                } catch (err) {
                    this.remove(channel, handler)
                    throw err
                }
            }

            let stopped = false
            return async () => {
                if (stopped) return
                stopped = true
                await this.serially(async () => {
                    const emptied = this.remove(channel, handler)
                    const client = this.client
                    if (!client) return
                    if (this.handlers.size === 0) return this.close()
                    if (emptied) await client.query(`UNLISTEN ${channel}`).catch(err => this.lose(client, err))
                })
            }
        })
    }

    /** Remove a handler. True when it was its channel's last. */
    private remove(channel: string, handler: NotificationHandler): boolean {
        const channelHandlers = this.handlers.get(channel)
        if (!channelHandlers) return false
        channelHandlers.delete(handler)
        if (channelHandlers.size > 0) return false
        this.handlers.delete(channel)
        return true
    }

    private async connect(): Promise<void> {
        const client = await this.pool.connect()
        const onNotification = (msg: Notification) => {
            for (const handler of this.handlers.get(msg.channel) ?? []) handler(msg.payload)
        }
        // Without an `error` listener, a connection terminated while checked out is an uncaught exception.
        const onError = (err: Error) => this.lose(client, err)
        const onEnd = () => this.lose(client, new Error("the listener's connection ended"))
        client.on("notification", onNotification)
        client.on("error", onError)
        client.on("end", onEnd)
        const detach = () => {
            client.removeListener("notification", onNotification)
            client.removeListener("error", onError)
            client.removeListener("end", onEnd)
        }
        try {
            for (const channel of this.handlers.keys()) await client.query(`LISTEN ${channel}`)
        } catch (err) {
            detach()
            client.on("error", () => {})
            client.release(err instanceof Error ? err : new Error(String(err)))
            throw err
        }
        this.client = client
        this.detach = detach
    }

    private lose(client: PoolClient, err: unknown): void {
        if (this.client !== client) return
        this.detach?.()
        this.client = undefined
        this.detach = undefined
        // A late error from the dying connection mustn't be an uncaught exception.
        client.on("error", () => {})
        // A broken connection goes back with its error, so the pool discards it.
        client.release(err instanceof Error ? err : new Error(String(err)))
        this.warn(`The notification listener's connection was lost (${errorMessage(err)}); reconnecting.`, err)
        this.wakeAll()
        void this.reconnect()
    }

    private async reconnect(): Promise<void> {
        if (this.reconnecting) return
        this.reconnecting = true
        try {
            for (let attempt = 1; this.handlers.size > 0 && !this.client; attempt++) {
                await sleep(backoffDelay(attempt, { initialMs: 500, maxMs: 30_000, ...this.options.backoff }))
                if (this.handlers.size === 0) return
                try {
                    await this.serially(async () => {
                        if (!this.client && this.handlers.size > 0) await this.connect()
                    })
                    this.wakeAll()
                } catch (err) {
                    this.warn(
                        `The notification listener couldn't reconnect (attempt ${attempt}): ${errorMessage(err)}`,
                        err
                    )
                }
            }
        } finally {
            this.reconnecting = false
        }
    }

    private wakeAll(): void {
        for (const channelHandlers of this.handlers.values()) for (const handler of channelHandlers) handler(undefined)
    }

    private async close(): Promise<void> {
        const client = this.client
        if (!client) return
        // No longer ours, so an error from here on is swallowed by `lose`, not thrown.
        this.client = undefined
        try {
            await client.query("UNLISTEN *")
            this.detach?.()
            client.release()
        } catch (err) {
            this.detach?.()
            client.on("error", () => {})
            client.release(err instanceof Error ? err : new Error(String(err)))
        } finally {
            this.detach = undefined
        }
    }

    private warn(message: string, err?: unknown): void {
        ;(this.options.logger ?? console).warn(message, err)
    }

    private serially<T>(work: () => Promise<T>): Promise<T> {
        const run = this.queue.then(work, work)
        this.queue = run.catch(() => {})
        return run
    }
}
