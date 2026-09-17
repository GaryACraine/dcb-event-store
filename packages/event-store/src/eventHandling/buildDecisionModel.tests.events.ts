import { TaggedEvent } from "../eventStore/EventStore.js"
import { Event } from "../eventStore/Event.js"
import { Tags } from "../eventStore/Tags.js"

export class CourseWasRegisteredEvent implements TaggedEvent<Event<"courseWasRegistered", { capacity: number }>> {
    public event: Event<"courseWasRegistered", { capacity: number }>
    public tags: Tags
    public id?: string
    public schemaVersion?: string

    constructor({ courseId, capacity }: { courseId: string; capacity: number }) {
        this.tags = Tags.fromObj({ courseId })
        this.event = { type: "courseWasRegistered", data: { capacity }, kind: "Event" }
    }
}

export class CourseCapacityWasChangedEvent implements TaggedEvent<
    Event<"courseCapacityWasChanged", { newCapacity: number }>
> {
    public event: Event<"courseCapacityWasChanged", { newCapacity: number }>
    public tags: Tags
    public id?: string
    public schemaVersion?: string

    constructor({ courseId, newCapacity }: { courseId: string; newCapacity: number }) {
        this.tags = Tags.fromObj({ courseId })
        this.event = { type: "courseCapacityWasChanged", data: { newCapacity }, kind: "Event" }
    }
}

export class StudentWasSubscribedEvent implements TaggedEvent<Event<"studentWasSubscribed", Record<string, never>>> {
    public event: Event<"studentWasSubscribed", Record<string, never>>
    public tags: Tags
    public id?: string
    public schemaVersion?: string

    constructor({ studentId, courseId }: { studentId: string; courseId: string }) {
        this.tags = Tags.fromObj({ studentId, courseId })
        this.event = { type: "studentWasSubscribed", data: {}, kind: "Event" }
    }
}

export class StudentWasUnsubscribedEvent implements TaggedEvent<
    Event<"studentWasUnsubscribed", Record<string, never>>
> {
    public event: Event<"studentWasUnsubscribed", Record<string, never>>
    public tags: Tags
    public id?: string
    public schemaVersion?: string

    constructor({ studentId, courseId }: { studentId: string; courseId: string }) {
        this.tags = Tags.fromObj({ studentId, courseId })
        this.event = { type: "studentWasUnsubscribed", data: {}, kind: "Event" }
    }
}
