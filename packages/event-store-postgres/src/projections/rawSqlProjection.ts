import { PoolClient } from "pg"
import { Query, SequencedEvent } from "@dcb-es/event-store"
import { Projection, ProjectionContext } from "./projection.js"

export interface RawSqlProjectionOptions {
    name: string
    version?: number
    canHandle: Query
    init?: (client: PoolClient) => Promise<void>
    evolve: (event: SequencedEvent, client: PoolClient) => Promise<void>
    truncate?: (client: PoolClient) => Promise<void>
}

export function rawSqlProjection(options: RawSqlProjectionOptions): Projection {
    return {
        name: options.name,
        version: options.version,
        canHandle: options.canHandle,
        init: options.init,
        handle: async (events: SequencedEvent[], context: ProjectionContext) => {
            for (const event of events) {
                await options.evolve(event, context.client)
            }
        },
        truncate: options.truncate
    }
}
