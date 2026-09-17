import { Tags, Event, TaggedEvent } from "@dcb-es/event-store"

export type CourseWasRegisteredEvent = Event<
    "courseWasRegistered",
    { courseId: string; title: string; capacity: number }
>

export const courseWasRegistered = ({
    courseId,
    title,
    capacity
}: {
    courseId: string
    title: string
    capacity: number
}): TaggedEvent<CourseWasRegisteredEvent> => ({
    event: { type: "courseWasRegistered", data: { courseId, title, capacity } },
    tags: Tags.fromObj({ courseId })
})

export type StudentWasRegistered = Event<
    "studentWasRegistered",
    { studentId: string; name: string; studentNumber: number }
>

export const studentWasRegistered = ({
    studentId,
    name,
    studentNumber
}: {
    studentId: string
    name: string
    studentNumber: number
}): TaggedEvent<StudentWasRegistered> => ({
    event: { type: "studentWasRegistered", data: { studentId, name, studentNumber } },
    // studentNumberIndex tag enables scoped locking for the NextStudentNumber decision model.
    // Without it, the global student number query has no tag to lock on.
    tags: Tags.fromObj({ studentId, studentNumberIndex: "global" })
})

export type CourseCapacityWasChangedEvent = Event<"courseCapacityWasChanged", { courseId: string; newCapacity: number }>

export const courseCapacityWasChanged = ({
    courseId,
    newCapacity
}: {
    courseId: string
    newCapacity: number
}): TaggedEvent<CourseCapacityWasChangedEvent> => ({
    event: { type: "courseCapacityWasChanged", data: { courseId, newCapacity } },
    tags: Tags.fromObj({ courseId })
})

export type CourseTitleWasChangedEvent = Event<"courseTitleWasChanged", { courseId: string; newTitle: string }>

export const courseTitleWasChanged = ({
    courseId,
    newTitle
}: {
    courseId: string
    newTitle: string
}): TaggedEvent<CourseTitleWasChangedEvent> => ({
    event: { type: "courseTitleWasChanged", data: { courseId, newTitle } },
    tags: Tags.fromObj({ courseId })
})

export type StudentWasSubscribedEvent = Event<"studentWasSubscribed", { courseId: string; studentId: string }>

export const studentWasSubscribed = ({
    studentId,
    courseId
}: {
    studentId: string
    courseId: string
}): TaggedEvent<StudentWasSubscribedEvent> => ({
    event: { type: "studentWasSubscribed", data: { studentId, courseId } },
    tags: Tags.fromObj({ studentId, courseId })
})

export type StudentWasUnsubscribedEvent = Event<"studentWasUnsubscribed", { courseId: string; studentId: string }>

export const studentWasUnsubscribed = ({
    studentId,
    courseId
}: {
    studentId: string
    courseId: string
}): TaggedEvent<StudentWasUnsubscribedEvent> => ({
    event: { type: "studentWasUnsubscribed", data: { studentId, courseId } },
    tags: Tags.fromObj({ studentId, courseId })
})
