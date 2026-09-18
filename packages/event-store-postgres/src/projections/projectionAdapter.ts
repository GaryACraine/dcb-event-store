import { PoolClient } from "pg"
import { Event, EventHandler, Query, SequencedEvent, Tags } from "@dcb-es/event-store"
import { ConsumerProcessorConfig } from "../eventHandling/consumer.js"
import { StartPosition } from "../eventHandling/startPositions.js"
import { Projection } from "./projection.js"
import { tryAcquireSharedProjectionLock } from "./projectionLock.js"

export interface ProjectionProcessorOptions {
    pollIntervalMs?: number
    startFrom?: StartPosition
    stopAfter?: number
    batchSize?: number
}

export function projectionToProcessor(
    projection: Projection,
    options?: ProjectionProcessorOptions
): ConsumerProcessorConfig {
    const eventTypes = projection.canHandle
    const projectionVersion = projection.version ?? 1

    return {
        processorName: projection.name,
        query: Query.fromItems([{ types: eventTypes }]),
        handlerFactory: (client: PoolClient): EventHandler<Event, Tags> => ({
            when: Object.fromEntries(
                eventTypes.map(type => [
                    type,
                    async (event: SequencedEvent) => {
                        const { acquired, isActive } = await tryAcquireSharedProjectionLock(
                            client,
                            projection.name,
                            projectionVersion
                        )
                        if (!acquired || !isActive) return
                        await projection.handle([event], { client })
                    }
                ])
            ) as EventHandler<Event, Tags>["when"]
        }),
        pollIntervalMs: options?.pollIntervalMs,
        startFrom: options?.startFrom,
        stopAfter: options?.stopAfter,
        batchSize: options?.batchSize
    }
}
