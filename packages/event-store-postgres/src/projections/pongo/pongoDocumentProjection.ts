import { Query, SequencedEvent } from "@dcb-es/event-store"
import { Projection } from "../projection.js"
import { pongoProjection, PongoProjectionContext } from "./pongoProjection.js"

export interface PongoDocumentProjectionOptions<TDocument extends Record<string, unknown>> {
    name: string
    version?: number
    canHandle: Query
    collectionName: string
    getDocumentId: (event: SequencedEvent) => string | null
    evolve: (document: TDocument | null, event: SequencedEvent) => TDocument | null
    initialState?: () => TDocument
}

export function pongoDocumentProjection<TDocument extends Record<string, unknown>>(
    options: PongoDocumentProjectionOptions<TDocument>
): Projection {
    return pongoProjection({
        name: options.name,
        version: options.version,
        canHandle: options.canHandle,

        init: async pongo => {
            const collection = pongo.db().collection<TDocument>(options.collectionName)
            await collection.createCollection()
        },

        handle: async (events: SequencedEvent[], context: PongoProjectionContext) => {
            const collection = context.pongo.db().collection<TDocument>(options.collectionName)

            // Group events by document ID, preserving order
            const groupedEvents = new Map<string, SequencedEvent[]>()
            for (const event of events) {
                const id = options.getDocumentId(event)
                if (id === null) continue
                const group = groupedEvents.get(id)
                if (group) {
                    group.push(event)
                } else {
                    groupedEvents.set(id, [event])
                }
            }

            for (const [id, docEvents] of groupedEvents) {
                // Load existing document
                const existing = await collection.findOne({ _id: id } as any)
                let document: TDocument | null = existing
                    ? (stripPongoMetadata(existing) as TDocument)
                    : options.initialState
                      ? options.initialState()
                      : null

                // Fold through events
                for (const event of docEvents) {
                    document = options.evolve(document, event)
                }

                if (document === null) {
                    // evolve returned null — delete the document
                    if (existing) {
                        await collection.deleteOne({ _id: id } as any)
                    }
                } else if (existing) {
                    // Update existing document
                    await collection.replaceOne({ _id: id } as any, document as any)
                } else {
                    // Insert new document
                    await collection.insertOne({ _id: id, ...document } as any)
                }
            }
        },

        truncate: async pongo => {
            const collection = pongo.db().collection<TDocument>(options.collectionName)
            await collection.deleteMany()
        }
    })
}

function stripPongoMetadata(doc: Record<string, unknown>): Record<string, unknown> {
    const { _id, _version, _partition, _archived, _created, _updated, _etag, ...rest } = doc
    return rest
}
