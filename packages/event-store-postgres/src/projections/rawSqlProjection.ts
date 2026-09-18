import { PoolClient } from "pg"
import { SequencedEvent } from "@dcb-es/event-store"
import { Projection, ProjectionContext } from "./projection.js"
import { registerProjection, serializeCanHandle } from "./registry/projectionRegistry.js"
import { ensureRegistryInstalled } from "./registry/ensureRegistryInstalled.js"

export interface RawSqlProjectionOptions {
    name: string
    version?: number
    canHandle: string[]
    init?: (client: PoolClient) => Promise<void>
    evolve: (event: SequencedEvent, client: PoolClient) => Promise<void>
    truncate?: (client: PoolClient) => Promise<void>
}

export function rawSqlProjection(options: RawSqlProjectionOptions): Projection {
    const name = options.name
    const version = options.version ?? 1

    return {
        name,
        version: options.version,
        kind: "raw-sql",
        canHandle: options.canHandle,
        init: async (client: PoolClient) => {
            await ensureRegistryInstalled(client)
            await registerProjection(client, {
                name,
                version,
                type: "a",
                kind: "raw-sql",
                status: "active",
                definition: serializeCanHandle(options.canHandle)
            })
            if (options.init) await options.init(client)
        },
        handle: async (events: SequencedEvent[], context: ProjectionContext) => {
            for (const event of events) {
                await options.evolve(event, context.client)
            }
        },
        truncate: options.truncate
    }
}
