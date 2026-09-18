import type { Event } from "../eventStore/Event.js"
import type { SequencedEvent } from "../eventStore/EventStore.js"

export type VersionHandlers<E extends Event, TState> = {
    [version: string]: (sequencedEvent: SequencedEvent<E>, state: TState) => TState | Promise<TState>
}

/**
 * Builds a single handler function that dispatches to version-specific handlers
 * based on the `schemaVersion` of a `SequencedEvent`. When `schemaVersion` is
 * absent, it defaults to `"1"`.
 *
 * Use this inside `EventHandlerWithState.when` to handle multiple schema
 * versions of the same event type in one place:
 *
 * ```typescript
 * const CourseTitle = (courseId: string): EventHandlerWithState<
 *     CourseWasRegisteredV1 | CourseWasRegisteredV2,
 *     string
 * > => ({
 *     tagFilter: Tags.fromObj({ courseId }),
 *     init: "",
 *     when: {
 *         courseWasRegistered: versionedHandler<CourseWasRegisteredV1 | CourseWasRegisteredV2, string>({
 *             "1": ({ event }) => event.data.title,
 *             "2": ({ event }) => event.data.title
 *         })
 *     }
 * })
 * ```
 */
export function versionedHandler<E extends Event, TState>(
    handlers: VersionHandlers<E, TState>,
    options?: {
        fallback?: (se: SequencedEvent<E>, state: TState) => TState | Promise<TState>
    }
): (se: SequencedEvent<E>, state: TState) => TState | Promise<TState> {
    return (se, state) => {
        const version = se.schemaVersion ?? "1"
        const handler = handlers[version] ?? options?.fallback
        if (!handler) {
            throw new Error(
                `No handler for ${se.event.type} schemaVersion "${version}". ` +
                    `Known versions: ${Object.keys(handlers).join(", ")}`
            )
        }
        return handler(se, state)
    }
}
