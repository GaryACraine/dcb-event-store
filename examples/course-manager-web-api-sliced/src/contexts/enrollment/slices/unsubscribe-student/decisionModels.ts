import { EventHandlerWithState, Tags } from "@dcb-es/event-store"
import { CourseWasRegisteredEvent, StudentWasSubscribedEvent, StudentWasUnsubscribedEvent } from "../../Events.js"

export const CourseExists = (courseId: string): EventHandlerWithState<CourseWasRegisteredEvent, boolean> => ({
    tagFilter: Tags.fromObj({ courseId }),
    init: false,
    when: {
        courseWasRegistered: () => true
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
