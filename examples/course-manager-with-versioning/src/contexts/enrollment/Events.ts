import { Tags, Event, TaggedEvent } from "@dcb-es/event-store"

// ---------------------------------------------------------------------------
// courseWasRegistered — versioned event types
// V1: original shape (courseId, title, capacity)
// V2: adds department
// V3: renames title → name, adds description (current version)
// ---------------------------------------------------------------------------

export type CourseWasRegisteredV1 = Event<
    "courseWasRegistered",
    { courseId: string; title: string; capacity: number }
>

export type CourseWasRegisteredV2 = Event<
    "courseWasRegistered",
    { courseId: string; title: string; capacity: number; department: string }
>

export type CourseWasRegisteredV3 = Event<
    "courseWasRegistered",
    { courseId: string; name: string; description: string; capacity: number; department: string }
>

/** Union of all historical versions — use in handlers that must handle old events */
export type CourseWasRegisteredEvent = CourseWasRegisteredV1 | CourseWasRegisteredV2 | CourseWasRegisteredV3

/** Factory for the current (V3) shape — what the write side always produces */
export const courseWasRegistered = ({
    courseId,
    name,
    description,
    capacity,
    department
}: {
    courseId: string
    name: string
    description: string
    capacity: number
    department: string
}): TaggedEvent<CourseWasRegisteredV3> => ({
    event: { type: "courseWasRegistered", data: { courseId, name, description, capacity, department } },
    tags: Tags.fromObj({ courseId }),
    schemaVersion: "3"
})

/** Factory for V1 — for seeding test histories with old events */
export const courseWasRegisteredV1 = ({
    courseId,
    title,
    capacity
}: {
    courseId: string
    title: string
    capacity: number
}): TaggedEvent<CourseWasRegisteredV1> => ({
    event: { type: "courseWasRegistered", data: { courseId, title, capacity } },
    tags: Tags.fromObj({ courseId }),
    schemaVersion: "1"
})

/** Factory for V2 — for seeding test histories with old events */
export const courseWasRegisteredV2 = ({
    courseId,
    title,
    capacity,
    department
}: {
    courseId: string
    title: string
    capacity: number
    department: string
}): TaggedEvent<CourseWasRegisteredV2> => ({
    event: { type: "courseWasRegistered", data: { courseId, title, capacity, department } },
    tags: Tags.fromObj({ courseId }),
    schemaVersion: "2"
})

// ---------------------------------------------------------------------------
// All other events — unchanged from base example
// ---------------------------------------------------------------------------

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
