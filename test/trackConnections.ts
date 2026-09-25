import { Pool, PoolClient } from "pg"

type Callback = (err: Error | undefined, client: PoolClient | undefined, done: () => void) => void

/**
 * Records every connection a pool hands out, so a test can count the listeners left on them. `pool.query` connects
 * with a callback and `pool.connect()` with a promise; both are recorded.
 */
export function trackConnections(pool: Pool): Set<PoolClient> {
    const clients = new Set<PoolClient>()
    const connect = pool.connect.bind(pool) as unknown as (cb?: Callback) => Promise<PoolClient> | void
    ;(pool as unknown as { connect: unknown }).connect = (cb?: Callback) => {
        if (cb)
            return connect((err, client, done) => {
                if (client) clients.add(client)
                cb(err, client, done)
            })
        return (connect() as Promise<PoolClient>).then(client => {
            clients.add(client)
            return client
        })
    }
    return clients
}

/** The most listeners of `event` on any of the connections. */
export const mostListeners = (clients: Set<PoolClient>, event: string): number =>
    Math.max(0, ...[...clients].map(c => c.listenerCount(event)))
