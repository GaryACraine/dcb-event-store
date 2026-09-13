import { EventStore, Query, SequencePosition } from "@dcb-es/event-store"

export type StartPosition = "BEGINNING" | "CURRENT"

/**
 * Resolve the effective start position for a processor.
 *
 * - `BEGINNING`: return `storedPosition` as-is. For a fresh handler this is 0;
 *   for a restarted one it is the stored checkpoint.
 * - `CURRENT`: if the handler has never run before (position is initial/0),
 *   snapshot the current high-water mark from the store so all historical events
 *   are skipped. If the handler has run before, return the stored position
 *   (resume from checkpoint — a restarted processor should not skip events).
 */
export async function resolveStartPosition(
    eventStore: EventStore,
    storedPosition: SequencePosition,
    startFrom: StartPosition
): Promise<SequencePosition> {
    if (startFrom === "BEGINNING") return storedPosition

    // CURRENT: only skip history for a brand-new handler
    if (!storedPosition.equals(SequencePosition.initial())) return storedPosition

    // Read the last event to get the high-water mark
    const gen = eventStore.read(Query.all(), { backwards: true, limit: 1 })
    try {
        const result = await gen.next()
        if (result.done || !result.value) return SequencePosition.initial()
        return result.value.position
    } finally {
        await gen.return(undefined).catch(() => {})
    }
}
