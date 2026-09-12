import { Tags } from "@dcb-es/event-store"
import { DcbEvent } from "@dcb-es/event-store"

export class CourseWasRegisteredEvent implements DcbEvent {
    public type: "courseWasRegistered" = "courseWasRegistered"
    public tags: Tags
    public data: { courseId: string; title: string; capacity: number }
    public metadata: unknown = {}
    public id?: string

    constructor(
        { courseId, title, capacity }: { courseId: string; title: string; capacity: number },
        options?: { id?: string; metadata?: unknown }
    ) {
        this.tags = Tags.fromObj({ courseId })
        this.data = { title, capacity, courseId }
        this.id = options?.id
        if (options?.metadata !== undefined) this.metadata = options.metadata
    }
}

export class StudentWasRegistered implements DcbEvent {
    public type: "studentWasRegistered" = "studentWasRegistered"
    public tags: Tags
    public data: { studentId: string; name: string; studentNumber: number }
    public metadata: unknown = {}
    public id?: string

    constructor(
        { studentId, name, studentNumber }: { studentId: string; name: string; studentNumber: number },
        options?: { id?: string; metadata?: unknown }
    ) {
        this.tags = Tags.fromObj({ studentId, studentNumberIndex: "global" })
        this.data = { studentId, name, studentNumber }
        this.id = options?.id
        if (options?.metadata !== undefined) this.metadata = options.metadata
    }
}

export class CourseCapacityWasChangedEvent implements DcbEvent {
    type: "courseCapacityWasChanged" = "courseCapacityWasChanged"
    public tags: Tags
    public data: { courseId: string; newCapacity: number }
    public metadata: unknown = {}
    public id?: string

    constructor(
        { courseId, newCapacity }: { courseId: string; newCapacity: number },
        options?: { id?: string; metadata?: unknown }
    ) {
        this.tags = Tags.fromObj({ courseId })
        this.data = { courseId, newCapacity }
        this.id = options?.id
        if (options?.metadata !== undefined) this.metadata = options.metadata
    }
}

export class CourseTitleWasChangedEvent implements DcbEvent {
    type: "courseTitleWasChanged" = "courseTitleWasChanged"
    public tags: Tags
    public data: { courseId: string; newTitle: string }
    public metadata: unknown = {}
    public id?: string

    constructor(
        { courseId, newTitle }: { courseId: string; newTitle: string },
        options?: { id?: string; metadata?: unknown }
    ) {
        this.tags = Tags.fromObj({ courseId })
        this.data = { courseId, newTitle }
        this.id = options?.id
        if (options?.metadata !== undefined) this.metadata = options.metadata
    }
}

export class StudentWasSubscribedEvent implements DcbEvent {
    type: "studentWasSubscribed" = "studentWasSubscribed"
    public tags: Tags
    public data: { courseId: string; studentId: string }
    public metadata: unknown = {}
    public id?: string

    constructor(
        { studentId, courseId }: { studentId: string; courseId: string },
        options?: { id?: string; metadata?: unknown }
    ) {
        this.tags = Tags.fromObj({ studentId, courseId })
        this.data = { studentId, courseId }
        this.id = options?.id
        if (options?.metadata !== undefined) this.metadata = options.metadata
    }
}

export class StudentWasUnsubscribedEvent implements DcbEvent {
    type: "studentWasUnsubscribed" = "studentWasUnsubscribed"
    public tags: Tags
    public data: { courseId: string; studentId: string }
    public metadata: unknown = {}
    public id?: string

    constructor(
        { studentId, courseId }: { studentId: string; courseId: string },
        options?: { id?: string; metadata?: unknown }
    ) {
        this.tags = Tags.fromObj({ studentId, courseId })
        this.data = { studentId, courseId }
        this.id = options?.id
        if (options?.metadata !== undefined) this.metadata = options.metadata
    }
}
