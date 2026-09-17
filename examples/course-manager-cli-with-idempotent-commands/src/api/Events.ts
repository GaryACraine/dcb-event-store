import { Tags, Event, TaggedEvent } from "@dcb-es/event-store"

export type CourseWasRegisteredEvent = Event<
    "courseWasRegistered",
    { courseId: string; title: string; capacity: number }
>

export const courseWasRegistered = (
    { courseId, title, capacity }: { courseId: string; title: string; capacity: number },
    options?: { id?: string; metadata?: unknown }
): TaggedEvent<CourseWasRegisteredEvent> => ({
    event: { type: "courseWasRegistered", data: { courseId, title, capacity } } as CourseWasRegisteredEvent,
    tags: Tags.fromObj({ courseId }),
    ...(options?.id ? { id: options.id } : {})
})

export type StudentWasRegistered = Event<
    "studentWasRegistered",
    { studentId: string; name: string; studentNumber: number }
>

export const studentWasRegistered = (
    { studentId, name, studentNumber }: { studentId: string; name: string; studentNumber: number },
    options?: { id?: string; metadata?: unknown }
): TaggedEvent<StudentWasRegistered> => ({
    event: { type: "studentWasRegistered", data: { studentId, name, studentNumber } } as StudentWasRegistered,
    // studentNumberIndex tag enables scoped locking for the NextStudentNumber decision model.
    // Without it, the global student number query has no tag to lock on.
    tags: Tags.fromObj({ studentId, studentNumberIndex: "global" }),
    ...(options?.id ? { id: options.id } : {})
})

export type CourseCapacityWasChangedEvent = Event<"courseCapacityWasChanged", { courseId: string; newCapacity: number }>

export const courseCapacityWasChanged = (
    { courseId, newCapacity }: { courseId: string; newCapacity: number },
    options?: { id?: string; metadata?: unknown }
): TaggedEvent<CourseCapacityWasChangedEvent> => ({
    event: { type: "courseCapacityWasChanged", data: { courseId, newCapacity } } as CourseCapacityWasChangedEvent,
    tags: Tags.fromObj({ courseId }),
    ...(options?.id ? { id: options.id } : {})
})

export type CourseTitleWasChangedEvent = Event<"courseTitleWasChanged", { courseId: string; newTitle: string }>

export const courseTitleWasChanged = (
    { courseId, newTitle }: { courseId: string; newTitle: string },
    options?: { id?: string; metadata?: unknown }
): TaggedEvent<CourseTitleWasChangedEvent> => ({
    event: { type: "courseTitleWasChanged", data: { courseId, newTitle } } as CourseTitleWasChangedEvent,
    tags: Tags.fromObj({ courseId }),
    ...(options?.id ? { id: options.id } : {})
})

export type StudentWasSubscribedEvent = Event<"studentWasSubscribed", { courseId: string; studentId: string }>

export const studentWasSubscribed = (
    { studentId, courseId }: { studentId: string; courseId: string },
    options?: { id?: string; metadata?: unknown }
): TaggedEvent<StudentWasSubscribedEvent> => ({
    event: {
        type: "studentWasSubscribed",
        data: { studentId, courseId },
        ...(options?.metadata !== undefined ? { metadata: options.metadata } : {})
    } as StudentWasSubscribedEvent,
    tags: Tags.fromObj({ studentId, courseId }),
    ...(options?.id ? { id: options.id } : {})
})

export type StudentWasUnsubscribedEvent = Event<"studentWasUnsubscribed", { courseId: string; studentId: string }>

export const studentWasUnsubscribed = (
    { studentId, courseId }: { studentId: string; courseId: string },
    options?: { id?: string; metadata?: unknown }
): TaggedEvent<StudentWasUnsubscribedEvent> => ({
    event: { type: "studentWasUnsubscribed", data: { studentId, courseId } } as StudentWasUnsubscribedEvent,
    tags: Tags.fromObj({ studentId, courseId }),
    ...(options?.id ? { id: options.id } : {})
})
