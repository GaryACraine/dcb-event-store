import { PoolClient } from "pg"
import { SequencedEvent } from "@dcb-es/event-store"

export interface ProjectionContext {
    client: PoolClient
}

export interface Projection {
    name: string
    version?: number
    kind?: string
    canHandle: string[]
    init?: (client: PoolClient) => Promise<void>
    handle: (events: SequencedEvent[], context: ProjectionContext) => Promise<void>
    truncate?: (client: PoolClient) => Promise<void>
}
