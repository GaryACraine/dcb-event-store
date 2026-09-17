import { describe, test, expect } from "vitest"
import { DeciderSpecification } from "./deciderSpecification.js"
import { decider } from "../eventHandling/Decider.js"
import { Command } from "../eventStore/Command.js"
import { SequencePosition } from "../eventStore/SequencePosition.js"
import { IllegalStateError, NotFoundError, ValidationError } from "../eventStore/errors.js"
import { CourseExists, CourseCapacity } from "../eventHandling/buildDecisionModel.tests.handlers.js"
import {
    CourseWasRegisteredEvent,
    CourseCapacityWasChangedEvent,
    StudentWasSubscribedEvent
} from "../eventHandling/buildDecisionModel.tests.events.js"

// -- Typed commands for testing --

type RegisterCourse = Command<"registerCourse", { id: string; capacity: number }>
type ChangeCourseCapacity = Command<"changeCourseCapacity", { courseId: string; newCapacity: number }>
type SubscribeStudent = Command<"subscribeStudent", { courseId: string; studentId: string }>

// -- Deciders under test --

const registerCourse = decider<RegisterCourse, { courseExists: ReturnType<typeof CourseExists> }>({
    handlers: cmd => ({
        courseExists: CourseExists(cmd.data.id)
    }),
    decide: (cmd, state) => {
        if (state.courseExists) throw new IllegalStateError(`Course ${cmd.data.id} already exists`)
        return new CourseWasRegisteredEvent({ courseId: cmd.data.id, capacity: cmd.data.capacity })
    }
})

const changeCourseCapacity = decider<
    ChangeCourseCapacity,
    { courseExists: ReturnType<typeof CourseExists>; courseCapacity: ReturnType<typeof CourseCapacity> }
>({
    handlers: cmd => ({
        courseExists: CourseExists(cmd.data.courseId),
        courseCapacity: CourseCapacity(cmd.data.courseId)
    }),
    decide: (cmd, state) => {
        if (!state.courseExists) throw new NotFoundError(`Course ${cmd.data.courseId} not found`)
        if (state.courseCapacity.capacity === cmd.data.newCapacity)
            throw new ValidationError("New capacity is the same as the current capacity")
        return new CourseCapacityWasChangedEvent({ courseId: cmd.data.courseId, newCapacity: cmd.data.newCapacity })
    }
})

const subscribeStudent = decider<
    SubscribeStudent,
    { courseExists: ReturnType<typeof CourseExists>; courseCapacity: ReturnType<typeof CourseCapacity> }
>({
    handlers: cmd => ({
        courseExists: CourseExists(cmd.data.courseId),
        courseCapacity: CourseCapacity(cmd.data.courseId)
    }),
    decide: (cmd, state) => {
        if (!state.courseExists) throw new NotFoundError(`Course ${cmd.data.courseId} not found`)
        if (state.courseCapacity.subscriberCount >= state.courseCapacity.capacity)
            throw new IllegalStateError(`Course ${cmd.data.courseId} is full`)
        return new StudentWasSubscribedEvent({ studentId: cmd.data.studentId, courseId: cmd.data.courseId })
    }
})

// -- A decider that returns no events --
const noOpDecider = decider<RegisterCourse, { courseExists: ReturnType<typeof CourseExists> }>({
    handlers: cmd => ({
        courseExists: CourseExists(cmd.data.id)
    }),
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    decide: (_cmd, _state) => []
})

describe("DeciderSpecification", () => {
    describe("event assertion cases", () => {
        test("given no events, when command, then matches produced event", async () => {
            await DeciderSpecification.for(registerCourse)
                .given()
                .when({ type: "registerCourse", data: { id: "c1", capacity: 30 } })
                .then(new CourseWasRegisteredEvent({ courseId: "c1", capacity: 30 }))
        })

        test("given prior events, when command, then matches (state folded correctly)", async () => {
            await DeciderSpecification.for(changeCourseCapacity)
                .given(new CourseWasRegisteredEvent({ courseId: "c1", capacity: 10 }))
                .when({ type: "changeCourseCapacity", data: { courseId: "c1", newCapacity: 50 } })
                .then(new CourseCapacityWasChangedEvent({ courseId: "c1", newCapacity: 50 }))
        })

        test("given events, decide returns empty, thenNothingHappened passes", async () => {
            await DeciderSpecification.for(noOpDecider)
                .given()
                .when({ type: "registerCourse", data: { id: "c1", capacity: 30 } })
                .thenNothingHappened()
        })

        test("then with wrong events fails", async () => {
            await expect(
                DeciderSpecification.for(registerCourse)
                    .given()
                    .when({ type: "registerCourse", data: { id: "c1", capacity: 30 } })
                    .then(new CourseWasRegisteredEvent({ courseId: "c1", capacity: 99 }))
            ).rejects.toThrow()
        })

        test("then ignores id/recordedAt/schemaVersion in comparison", async () => {
            const eventWithId = new CourseWasRegisteredEvent({ courseId: "c1", capacity: 30 })
            eventWithId.id = "explicit-id"
            eventWithId.schemaVersion = "2"

            // The comparison should still pass because id/schemaVersion are stripped
            await DeciderSpecification.for(registerCourse)
                .given()
                .when({ type: "registerCourse", data: { id: "c1", capacity: 30 } })
                .then(eventWithId)
        })
    })

    describe("error assertion cases", () => {
        test("decide throws, thenThrows passes", async () => {
            await DeciderSpecification.for(registerCourse)
                .given(new CourseWasRegisteredEvent({ courseId: "c1", capacity: 30 }))
                .when({ type: "registerCourse", data: { id: "c1", capacity: 30 } })
                .thenThrows()
        })

        test("decide throws specific type, thenThrows(ErrorType) passes", async () => {
            await DeciderSpecification.for(registerCourse)
                .given(new CourseWasRegisteredEvent({ courseId: "c1", capacity: 30 }))
                .when({ type: "registerCourse", data: { id: "c1", capacity: 30 } })
                .thenThrows(IllegalStateError)
        })

        test("decide throws, thenThrows with predicate", async () => {
            await DeciderSpecification.for(registerCourse)
                .given(new CourseWasRegisteredEvent({ courseId: "c1", capacity: 30 }))
                .when({ type: "registerCourse", data: { id: "c1", capacity: 30 } })
                .thenThrows(IllegalStateError, e => e.message.includes("already exists"))
        })

        test("decide does not throw, thenThrows fails", async () => {
            await expect(
                DeciderSpecification.for(registerCourse)
                    .given()
                    .when({ type: "registerCourse", data: { id: "c1", capacity: 30 } })
                    .thenThrows()
            ).rejects.toThrow("Expected decide to throw but it did not")
        })

        test("thenThrows with wrong error type fails", async () => {
            await expect(
                DeciderSpecification.for(registerCourse)
                    .given(new CourseWasRegisteredEvent({ courseId: "c1", capacity: 30 }))
                    .when({ type: "registerCourse", data: { id: "c1", capacity: 30 } })
                    .thenThrows(NotFoundError)
            ).rejects.toThrow("Expected error of type NotFoundError but got IllegalStateError")
        })

        test("thenThrows with failing predicate fails", async () => {
            await expect(
                DeciderSpecification.for(registerCourse)
                    .given(new CourseWasRegisteredEvent({ courseId: "c1", capacity: 30 }))
                    .when({ type: "registerCourse", data: { id: "c1", capacity: 30 } })
                    .thenThrows(IllegalStateError, e => e.message.includes("nonexistent text"))
            ).rejects.toThrow("Error predicate failed")
        })

        test("decide throws NotFoundError, thenThrows(NotFoundError) passes", async () => {
            await DeciderSpecification.for(changeCourseCapacity)
                .given()
                .when({ type: "changeCourseCapacity", data: { courseId: "c1", newCapacity: 50 } })
                .thenThrows(NotFoundError)
        })

        test("decide throws ValidationError, thenThrows(ValidationError) passes", async () => {
            await DeciderSpecification.for(changeCourseCapacity)
                .given(new CourseWasRegisteredEvent({ courseId: "c1", capacity: 50 }))
                .when({ type: "changeCourseCapacity", data: { courseId: "c1", newCapacity: 50 } })
                .thenThrows(ValidationError)
        })

        test("decide throws IllegalStateError for full course", async () => {
            await DeciderSpecification.for(subscribeStudent)
                .given(
                    new CourseWasRegisteredEvent({ courseId: "c1", capacity: 1 }),
                    new StudentWasSubscribedEvent({ studentId: "s1", courseId: "c1" })
                )
                .when({ type: "subscribeStudent", data: { courseId: "c1", studentId: "s2" } })
                .thenThrows(IllegalStateError, e => e.message.includes("is full"))
        })

        test("then fails when decide actually threw", async () => {
            await expect(
                DeciderSpecification.for(registerCourse)
                    .given(new CourseWasRegisteredEvent({ courseId: "c1", capacity: 30 }))
                    .when({ type: "registerCourse", data: { id: "c1", capacity: 30 } })
                    .then(new CourseWasRegisteredEvent({ courseId: "c1", capacity: 30 }))
            ).rejects.toThrow("Expected events but decide threw")
        })

        test("thenNothingHappened fails when decide threw", async () => {
            await expect(
                DeciderSpecification.for(registerCourse)
                    .given(new CourseWasRegisteredEvent({ courseId: "c1", capacity: 30 }))
                    .when({ type: "registerCourse", data: { id: "c1", capacity: 30 } })
                    .thenNothingHappened()
            ).rejects.toThrow("Expected no events but decide threw")
        })

        test("thenNothingHappened fails when events were produced", async () => {
            await expect(
                DeciderSpecification.for(registerCourse)
                    .given()
                    .when({ type: "registerCourse", data: { id: "c1", capacity: 30 } })
                    .thenNothingHappened()
            ).rejects.toThrow("Expected no events but got 1")
        })
    })

    describe("boundary assertion cases (DCB-specific)", () => {
        test("thenCondition: after is SequencePosition.initial() when no given events", async () => {
            await DeciderSpecification.for(registerCourse)
                .given()
                .when({ type: "registerCourse", data: { id: "c1", capacity: 30 } })
                .thenCondition(condition => {
                    expect(condition.after).toEqual(SequencePosition.initial())
                })
        })

        test("thenCondition: after equals position of last matching given event", async () => {
            await DeciderSpecification.for(changeCourseCapacity)
                .given(new CourseWasRegisteredEvent({ courseId: "c1", capacity: 10 }))
                .when({ type: "changeCourseCapacity", data: { courseId: "c1", newCapacity: 50 } })
                .thenCondition(condition => {
                    expect(condition.after!.isAfter(SequencePosition.initial())).toBe(true)
                })
        })

        test("thenCondition: failIfEventsMatch contains expected query items (types + tags)", async () => {
            await DeciderSpecification.for(subscribeStudent)
                .given(
                    new CourseWasRegisteredEvent({ courseId: "c1", capacity: 30 }),
                    new StudentWasSubscribedEvent({ studentId: "s1", courseId: "c1" })
                )
                .when({ type: "subscribeStudent", data: { courseId: "c1", studentId: "s2" } })
                .thenCondition(condition => {
                    const query = condition.failIfEventsMatch
                    expect(query.isAll).toBe(false)

                    // The subscribeStudent decider uses CourseExists and CourseCapacity handlers,
                    // both scoped to courseId. We expect query items covering their event types.
                    const allTypes = query.items.flatMap(item => item.types)
                    expect(allTypes).toContain("courseWasRegistered")
                    expect(allTypes).toContain("studentWasSubscribed")
                })
        })

        test("thenCondition works even when decide threw", async () => {
            await DeciderSpecification.for(subscribeStudent)
                .given(
                    new CourseWasRegisteredEvent({ courseId: "c1", capacity: 1 }),
                    new StudentWasSubscribedEvent({ studentId: "s1", courseId: "c1" })
                )
                .when({ type: "subscribeStudent", data: { courseId: "c1", studentId: "s2" } })
                .thenCondition(condition => {
                    // Even though decide throws (course is full), we can still assert the boundary
                    expect(condition.after!.isAfter(SequencePosition.initial())).toBe(true)
                })
        })
    })
})
