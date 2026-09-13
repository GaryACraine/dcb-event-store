import { Pool, PoolClient } from "pg"
import { DcbEvent, SequencedEvent, SequencePosition } from "@dcb-es/event-store"
import { v4 as uuid } from "uuid"
import { Projection } from "./projection.js"

export interface ProjectionSpecGiven {
    given(events: DcbEvent[]): ProjectionSpecWhen
}

export interface ProjectionSpecWhen {
    when(events: DcbEvent[]): ProjectionSpecThen
}

export interface ProjectionSpecThen {
    then(assert: (client: PoolClient) => Promise<void>): Promise<void>
}

function toSequencedEvents(events: DcbEvent[], startPosition: number): SequencedEvent[] {
    return events.map((event, index) => ({
        event,
        position: SequencePosition.fromString(String(startPosition + index + 1)),
        id: uuid(),
        recordedAt: new Date()
    }))
}

function filterByQuery(events: SequencedEvent[], projection: Projection): SequencedEvent[] {
    if (projection.canHandle.isAll) return events
    const handledTypes = new Set<string>()
    for (const item of projection.canHandle.items) {
        for (const type of item.types) {
            handledTypes.add(type)
        }
    }
    return events.filter(e => handledTypes.has(e.event.type))
}

export const ProjectionSpec = {
    for(options: { projection: Projection; pool: Pool }): ProjectionSpecGiven {
        const { projection, pool } = options

        return {
            given(givenEvents: DcbEvent[]): ProjectionSpecWhen {
                return {
                    when(whenEvents: DcbEvent[]): ProjectionSpecThen {
                        return {
                            async then(assert: (client: PoolClient) => Promise<void>): Promise<void> {
                                const client = await pool.connect()
                                try {
                                    await client.query("BEGIN")

                                    if (projection.init) {
                                        await projection.init(client)
                                    }

                                    const sequencedGiven = toSequencedEvents(givenEvents, 0)
                                    const filteredGiven = filterByQuery(sequencedGiven, projection)
                                    if (filteredGiven.length > 0) {
                                        await projection.handle(filteredGiven, { client })
                                    }

                                    const sequencedWhen = toSequencedEvents(whenEvents, givenEvents.length)
                                    const filteredWhen = filterByQuery(sequencedWhen, projection)
                                    if (filteredWhen.length > 0) {
                                        await projection.handle(filteredWhen, { client })
                                    }

                                    await assert(client)
                                } finally {
                                    await client.query("ROLLBACK").catch(() => {})
                                    client.release()
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}
