import { EventHandlerWithState, Tags } from "@dcb-es/event-store"
import {
    CourseWasRegisteredEvent,
    CourseCapacityWasChangedEvent,
    StudentWasSubscribedEvent,
    StudentWasUnsubscribedEvent
} from "../../Events.js"

export const CourseExists = (courseId: string): EventHandlerWithState<CourseWasRegisteredEvent, boolean> => ({
    tagFilter: Tags.fromObj({ courseId }),
    init: false,
    when: {
        courseWasRegistered: () => true
    }
})

/**
 * CourseCapacity — plain switch pattern.
 *
 * This shows the baseline approach for handling schema evolution without a
 * utility: inspect `schemaVersion` directly and branch on it. All three
 * versions of courseWasRegistered store `capacity` so the extraction logic
 * is identical here, but the switch makes the version awareness explicit.
 *
 * Compare with CourseTitle in the subscribe-student slice, which uses
 * versionedHandler() for the same purpose.
 */
export const CourseCapacity = (
    courseId: string
): EventHandlerWithState<
    CourseWasRegisteredEvent | CourseCapacityWasChangedEvent | StudentWasSubscribedEvent | StudentWasUnsubscribedEvent,
    { subscriberCount: number; capacity: number }
> => ({
    tagFilter: Tags.fromObj({ courseId }),
    init: { subscriberCount: 0, capacity: 0 },
    when: {
        courseWasRegistered: (sequencedEvent, state) => {
            // Plain switch pattern — explicit version branching without a utility
            switch (sequencedEvent.schemaVersion ?? "1") {
                case "1":
                case "2": {
                    // V1 and V2 both have data.capacity directly
                    const data = sequencedEvent.event.data as { capacity: number }
                    return { capacity: data.capacity, subscriberCount: state.subscriberCount }
                }
                case "3":
                default: {
                    // V3 also has data.capacity — but we're explicit about knowing each version
                    const data = sequencedEvent.event.data as { capacity: number }
                    return { capacity: data.capacity, subscriberCount: state.subscriberCount }
                }
            }
        },
        courseCapacityWasChanged: ({ event }, { subscriberCount }) => ({
            subscriberCount,
            capacity: event.data.newCapacity
        }),
        studentWasSubscribed: (_eventEnvelope, { capacity, subscriberCount }) => ({
            subscriberCount: subscriberCount + 1,
            capacity
        }),
        studentWasUnsubscribed: (_eventEnvelope, { capacity, subscriberCount }) => ({
            subscriberCount: subscriberCount - 1,
            capacity
        })
    }
})
