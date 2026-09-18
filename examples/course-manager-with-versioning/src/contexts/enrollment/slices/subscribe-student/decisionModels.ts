import { EventHandlerWithState, Tags, versionedHandler } from "@dcb-es/event-store"
import {
    CourseWasRegisteredEvent,
    CourseWasRegisteredV1,
    CourseWasRegisteredV2,
    CourseWasRegisteredV3,
    CourseCapacityWasChangedEvent,
    CourseTitleWasChangedEvent,
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

export const CourseCapacity = (
    courseId: string
): EventHandlerWithState<
    CourseWasRegisteredEvent | CourseCapacityWasChangedEvent | StudentWasSubscribedEvent | StudentWasUnsubscribedEvent,
    { subscriberCount: number; capacity: number }
> => ({
    tagFilter: Tags.fromObj({ courseId }),
    init: { subscriberCount: 0, capacity: 0 },
    when: {
        courseWasRegistered: ({ event }) => ({
            capacity: (event.data as { capacity: number }).capacity,
            subscriberCount: 0
        }),
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

/**
 * CourseTitle — versionedHandler() pattern.
 *
 * This decision model needs the course name/title for context messages and
 * demonstrates the versionedHandler() utility. Each version of
 * courseWasRegistered stored the name under a different field:
 *
 *   V1/V2: data.title
 *   V3:    data.name
 *
 * versionedHandler() routes to the correct extractor without a manual
 * switch, keeping the per-version logic in isolated, named functions.
 * Compare with CourseCapacity in change-course-capacity, which uses a
 * plain switch to show the equivalent without the utility.
 */
export const CourseTitle = (
    courseId: string
): EventHandlerWithState<CourseWasRegisteredEvent | CourseTitleWasChangedEvent, string> => ({
    tagFilter: Tags.fromObj({ courseId }),
    init: "",
    when: {
        courseWasRegistered: versionedHandler<CourseWasRegisteredEvent, string>({
            "1": ({ event }) => (event as CourseWasRegisteredV1).data.title,
            "2": ({ event }) => (event as CourseWasRegisteredV2).data.title,
            "3": ({ event }) => (event as CourseWasRegisteredV3).data.name
        }),
        courseTitleWasChanged: ({ event }) => event.data.newTitle
    }
})

export const StudentAlreadySubscribed = ({
    courseId,
    studentId
}: {
    courseId: string
    studentId: string
}): EventHandlerWithState<StudentWasSubscribedEvent | StudentWasUnsubscribedEvent, boolean> => ({
    tagFilter: Tags.fromObj({ courseId, studentId }),
    init: false,
    when: {
        studentWasSubscribed: () => true,
        studentWasUnsubscribed: () => false
    }
})

export const StudentSubscriptions = (
    studentId: string
): EventHandlerWithState<StudentWasSubscribedEvent | StudentWasUnsubscribedEvent, { subscriptionCount: number }> => ({
    tagFilter: Tags.fromObj({ studentId }),
    init: { subscriptionCount: 0 },
    when: {
        studentWasSubscribed: (_eventEnvelope, { subscriptionCount }) => ({
            subscriptionCount: subscriptionCount + 1
        }),
        studentWasUnsubscribed: (_eventEnvelope, { subscriptionCount }) => ({
            subscriptionCount: subscriptionCount - 1
        })
    }
})
