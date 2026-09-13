import { PoolClient } from "pg"
import { Query, SequencedEvent } from "@dcb-es/event-store"
import { Projection, ProjectionContext } from "../projection.js"
import { pongoClient, type PongoClient } from "@event-driven-io/pongo"
import { pongoDriver } from "@event-driven-io/pongo/pg"
import { pgAmbientPoolClientPool } from "@event-driven-io/dumbo/pg"
import { jsonSerializer } from "@event-driven-io/dumbo"
import { registerProjection, serializeCanHandle } from "../registry/projectionRegistry.js"
import { ensureRegistryInstalled } from "../registry/ensureRegistryInstalled.js"

export interface PongoProjectionContext extends ProjectionContext {
    pongo: PongoClient
}

export interface PongoProjectionOptions {
    name: string
    version?: number
    kind?: string
    canHandle: Query
    handle: (events: SequencedEvent[], context: PongoProjectionContext) => Promise<void>
    init?: (pongo: PongoClient) => Promise<void>
    truncate?: (pongo: PongoClient) => Promise<void>
}

function createTransactionPongoClient(client: PoolClient): PongoClient {
    const serializer = jsonSerializer()
    const pool = pgAmbientPoolClientPool({ client, serializer })
    return pongoClient({
        driver: pongoDriver,
        pool,
        schema: { autoMigration: "None" }
    })
}

export function pongoProjection(options: PongoProjectionOptions): Projection {
    const name = options.name
    const version = options.version ?? 1
    const kind = options.kind ?? "pongo"

    return {
        name,
        version: options.version,
        kind,
        canHandle: options.canHandle,

        init: async (client: PoolClient) => {
            await ensureRegistryInstalled(client)
            await registerProjection(client, {
                name,
                version,
                type: "a",
                kind,
                status: "active",
                definition: serializeCanHandle(options.canHandle)
            })
            if (options.init) {
                // For init, create a transaction-scoped Pongo client so DDL
                // participates in the same transaction as ProjectionSpec.
                const pongo = createTransactionPongoClient(client)
                try {
                    await options.init(pongo)
                } finally {
                    await pongo.close()
                }
            }
        },

        handle: async (events: SequencedEvent[], context: ProjectionContext) => {
            const pongo = createTransactionPongoClient(context.client)
            try {
                await options.handle(events, { ...context, pongo })
            } finally {
                await pongo.close()
            }
        },

        truncate: options.truncate
            ? async (client: PoolClient) => {
                  const pongo = createTransactionPongoClient(client)
                  try {
                      await options.truncate!(pongo)
                  } finally {
                      await pongo.close()
                  }
              }
            : undefined
    }
}
