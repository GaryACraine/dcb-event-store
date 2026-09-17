import { Tags, TaggedEvent, SequencedEvent, SequencePosition } from "@dcb-es/event-store"

export type DbWriteEvent = {
    type: string
    payload: string
    tags: string[]
}

export type DbReadEvent = {
    type: string
    payload: string
    tags: string[]
    sequence_position: string
    message_id: string
    recorded_at: string
    schema_version: string
    metadata: Record<string, unknown>
}

export const dbEventConverter = {
    toDb: (taggedEvent: TaggedEvent): DbWriteEvent => ({
        type: taggedEvent.event.type,
        payload: JSON.stringify({ data: taggedEvent.event.data, metadata: taggedEvent.event.metadata }),
        tags: [...taggedEvent.tags.values]
    }),
    fromDb: (dbEvent: DbReadEvent): SequencedEvent => {
        const { data, metadata } = JSON.parse(dbEvent.payload)
        return {
            event: { type: dbEvent.type, data, ...(metadata ? { metadata } : {}) },
            tags: Tags.from(dbEvent.tags),
            position: SequencePosition.fromString(dbEvent.sequence_position),
            id: dbEvent.message_id,
            recordedAt: new Date(dbEvent.recorded_at),
            schemaVersion: dbEvent.schema_version
        }
    }
}

export class ParamManager {
    public params: (string | string[] | number | boolean)[] = []
    add(paramValue: string | string[] | number | boolean): string {
        this.params.push(paramValue)
        return `$${this.params.length}`
    }
}
