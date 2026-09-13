import { PoolClient } from "pg"
import { DcbEvent, EventHandler, SequencedEvent, Tags } from "@dcb-es/event-store"
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
    const eventTypes = extractEventTypes(projection)
    const projectionVersion = projection.version ?? 1

    return {
        processorName: projection.name,
        query: projection.canHandle,
        handlerFactory: (client: PoolClient): EventHandler<DcbEvent, Tags> => ({
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
            ) as EventHandler<DcbEvent, Tags>["when"]
        }),
        pollIntervalMs: options?.pollIntervalMs,
        startFrom: options?.startFrom,
        stopAfter: options?.stopAfter,
        batchSize: options?.batchSize
    }
}

function extractEventTypes(projection: Projection): string[] {
    if (projection.canHandle.isAll) {
        return []
    }
    const types = new Set<string>()
    for (const item of projection.canHandle.items) {
        for (const type of item.types) {
            types.add(type)
        }
    }
    return [...types]
}
