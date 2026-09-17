import { Event } from "../eventStore/Event.js"
import { Tags } from "../eventStore/Tags.js"
import { EventHandlerWithState } from "./EventHandlerWithState.js"

export const CourseExists = (
    courseId: string
): EventHandlerWithState<Event<"courseWasRegistered", { capacity: number }>, boolean> => ({
    tagFilter: Tags.fromObj({ courseId }),
    init: false,
    when: {
        courseWasRegistered: async () => true
    }
})

export const CourseCapacity = (
    courseId: string
): EventHandlerWithState<
    | Event<"courseWasRegistered", { capacity: number }>
    | Event<"courseCapacityWasChanged", { newCapacity: number }>
    | Event<"studentWasSubscribed", Record<string, never>>
    | Event<"studentWasUnsubscribed", Record<string, never>>,
    { isFull: boolean; subscriberCount: number; capacity: number }
> => ({
    tagFilter: Tags.fromObj({ courseId }),
    init: { isFull: true, subscriberCount: 0, capacity: 0 },
    when: {
        courseWasRegistered: ({ event }) => ({
            isFull: event.data.capacity === 0,
            capacity: event.data.capacity,
            subscriberCount: 0
        }),
        courseCapacityWasChanged: ({ event }, { subscriberCount }) => ({
            subscriberCount,
            isFull: event.data.newCapacity <= subscriberCount,
            capacity: event.data.newCapacity
        }),
        studentWasSubscribed: (_eventEnvelope, { capacity, subscriberCount }) => ({
            isFull: capacity <= subscriberCount + 1,
            subscriberCount: subscriberCount + 1,
            capacity
        }),
        studentWasUnsubscribed: (eventEnvelope, { capacity, subscriberCount }) => ({
            isFull: capacity <= subscriberCount - 1,
            subscriberCount: subscriberCount - 1,
            capacity
        })
    }
})
