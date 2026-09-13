import { describe, test } from "vitest"
import { DeciderSpecification, IllegalStateError, NotFoundError, ValidationError } from "@dcb-es/event-store"
import {
    registerCourse,
    registerStudent,
    updateCourseCapacity,
    updateCourseTitle,
    subscribeStudentToCourse,
    unsubscribeStudentFromCourse
} from "./Deciders.js"
import {
    CourseWasRegisteredEvent,
    StudentWasRegistered,
    StudentWasSubscribedEvent,
    StudentWasUnsubscribedEvent,
    CourseCapacityWasChangedEvent,
    CourseTitleWasChangedEvent
} from "./Events.js"

describe("registerCourse", () => {
    test("given empty store, registers a new course", async () => {
        await DeciderSpecification.for(registerCourse)
            .given()
            .when({ type: "registerCourse", data: { id: "c1", title: "Math", capacity: 30 } })
            .then(new CourseWasRegisteredEvent({ courseId: "c1", title: "Math", capacity: 30 }))
    })

    test("given course already exists, throws IllegalStateError", async () => {
        await DeciderSpecification.for(registerCourse)
            .given(new CourseWasRegisteredEvent({ courseId: "c1", title: "Math", capacity: 30 }))
            .when({ type: "registerCourse", data: { id: "c1", title: "Math", capacity: 30 } })
            .thenThrows(IllegalStateError, e => e.message.includes("already exists"))
    })
})

describe("registerStudent", () => {
    test("given empty store, registers a new student with student number 1", async () => {
        await DeciderSpecification.for(registerStudent)
            .given()
            .when({ type: "registerStudent", data: { id: "s1", name: "Alice" } })
            .then(new StudentWasRegistered({ studentId: "s1", name: "Alice", studentNumber: 1 }))
    })

    test("given one student registered, assigns next student number", async () => {
        await DeciderSpecification.for(registerStudent)
            .given(new StudentWasRegistered({ studentId: "s1", name: "Alice", studentNumber: 1 }))
            .when({ type: "registerStudent", data: { id: "s2", name: "Bob" } })
            .then(new StudentWasRegistered({ studentId: "s2", name: "Bob", studentNumber: 2 }))
    })

    test("given student already registered, throws IllegalStateError", async () => {
        await DeciderSpecification.for(registerStudent)
            .given(new StudentWasRegistered({ studentId: "s1", name: "Alice", studentNumber: 1 }))
            .when({ type: "registerStudent", data: { id: "s1", name: "Alice" } })
            .thenThrows(IllegalStateError, e => e.message.includes("already registered"))
    })
})

describe("updateCourseCapacity", () => {
    test("given course exists, updates capacity", async () => {
        await DeciderSpecification.for(updateCourseCapacity)
            .given(new CourseWasRegisteredEvent({ courseId: "c1", title: "Math", capacity: 30 }))
            .when({ type: "updateCourseCapacity", data: { courseId: "c1", newCapacity: 50 } })
            .then(new CourseCapacityWasChangedEvent({ courseId: "c1", newCapacity: 50 }))
    })

    test("given course does not exist, throws NotFoundError", async () => {
        await DeciderSpecification.for(updateCourseCapacity)
            .given()
            .when({ type: "updateCourseCapacity", data: { courseId: "c1", newCapacity: 50 } })
            .thenThrows(NotFoundError, e => e.message.includes("doesn't exist"))
    })

    test("given same capacity, throws ValidationError", async () => {
        await DeciderSpecification.for(updateCourseCapacity)
            .given(new CourseWasRegisteredEvent({ courseId: "c1", title: "Math", capacity: 30 }))
            .when({ type: "updateCourseCapacity", data: { courseId: "c1", newCapacity: 30 } })
            .thenThrows(ValidationError, e => e.message.includes("same as the current capacity"))
    })
})

describe("updateCourseTitle", () => {
    test("given course exists, updates title", async () => {
        await DeciderSpecification.for(updateCourseTitle)
            .given(new CourseWasRegisteredEvent({ courseId: "c1", title: "Math", capacity: 30 }))
            .when({ type: "updateCourseTitle", data: { courseId: "c1", newTitle: "Advanced Math" } })
            .then(new CourseTitleWasChangedEvent({ courseId: "c1", newTitle: "Advanced Math" }))
    })

    test("given course does not exist, throws NotFoundError", async () => {
        await DeciderSpecification.for(updateCourseTitle)
            .given()
            .when({ type: "updateCourseTitle", data: { courseId: "c1", newTitle: "Advanced Math" } })
            .thenThrows(NotFoundError, e => e.message.includes("doesn't exist"))
    })

    test("given same title, throws ValidationError", async () => {
        await DeciderSpecification.for(updateCourseTitle)
            .given(new CourseWasRegisteredEvent({ courseId: "c1", title: "Math", capacity: 30 }))
            .when({ type: "updateCourseTitle", data: { courseId: "c1", newTitle: "Math" } })
            .thenThrows(ValidationError, e => e.message.includes("same as the current title"))
    })
})

describe("subscribeStudentToCourse", () => {
    test("given course with capacity, subscribes student", async () => {
        await DeciderSpecification.for(subscribeStudentToCourse)
            .given(new CourseWasRegisteredEvent({ courseId: "c1", title: "Math", capacity: 30 }))
            .when({ type: "subscribeStudentToCourse", data: { courseId: "c1", studentId: "s1" } })
            .then(new StudentWasSubscribedEvent({ courseId: "c1", studentId: "s1" }))
    })

    test("given course does not exist, throws NotFoundError", async () => {
        await DeciderSpecification.for(subscribeStudentToCourse)
            .given()
            .when({ type: "subscribeStudentToCourse", data: { courseId: "c1", studentId: "s1" } })
            .thenThrows(NotFoundError, e => e.message.includes("doesn't exist"))
    })

    test("given full course, throws IllegalStateError", async () => {
        await DeciderSpecification.for(subscribeStudentToCourse)
            .given(
                new CourseWasRegisteredEvent({ courseId: "c1", title: "Math", capacity: 1 }),
                new StudentWasSubscribedEvent({ courseId: "c1", studentId: "s1" })
            )
            .when({ type: "subscribeStudentToCourse", data: { courseId: "c1", studentId: "s2" } })
            .thenThrows(IllegalStateError, e => e.message.includes("is full"))
    })

    test("given student already subscribed, throws IllegalStateError", async () => {
        await DeciderSpecification.for(subscribeStudentToCourse)
            .given(
                new CourseWasRegisteredEvent({ courseId: "c1", title: "Math", capacity: 30 }),
                new StudentWasSubscribedEvent({ courseId: "c1", studentId: "s1" })
            )
            .when({ type: "subscribeStudentToCourse", data: { courseId: "c1", studentId: "s1" } })
            .thenThrows(IllegalStateError, e => e.message.includes("already subscribed"))
    })

    test("thenCondition verifies boundary covers courseId and studentId tags", async () => {
        await DeciderSpecification.for(subscribeStudentToCourse)
            .given(new CourseWasRegisteredEvent({ courseId: "c1", title: "Math", capacity: 30 }))
            .when({ type: "subscribeStudentToCourse", data: { courseId: "c1", studentId: "s1" } })
            .thenCondition(condition => {
                const query = condition.failIfEventsMatch
                expect(query.isAll).toBe(false)

                // Collect all tags across query items
                const allTagValues = query.items.flatMap(item => item.tags?.values ?? [])
                expect(allTagValues).toContain("courseId=c1")
                expect(allTagValues).toContain("studentId=s1")
            })
    })
})

describe("unsubscribeStudentFromCourse", () => {
    test("given student is subscribed, unsubscribes", async () => {
        await DeciderSpecification.for(unsubscribeStudentFromCourse)
            .given(
                new CourseWasRegisteredEvent({ courseId: "c1", title: "Math", capacity: 30 }),
                new StudentWasSubscribedEvent({ courseId: "c1", studentId: "s1" })
            )
            .when({ type: "unsubscribeStudentFromCourse", data: { courseId: "c1", studentId: "s1" } })
            .then(new StudentWasUnsubscribedEvent({ courseId: "c1", studentId: "s1" }))
    })

    test("given course does not exist, throws NotFoundError", async () => {
        await DeciderSpecification.for(unsubscribeStudentFromCourse)
            .given()
            .when({ type: "unsubscribeStudentFromCourse", data: { courseId: "c1", studentId: "s1" } })
            .thenThrows(NotFoundError, e => e.message.includes("doesn't exist"))
    })

    test("given student is not subscribed, throws NotFoundError", async () => {
        await DeciderSpecification.for(unsubscribeStudentFromCourse)
            .given(new CourseWasRegisteredEvent({ courseId: "c1", title: "Math", capacity: 30 }))
            .when({ type: "unsubscribeStudentFromCourse", data: { courseId: "c1", studentId: "s1" } })
            .thenThrows(NotFoundError, e => e.message.includes("is not subscribed"))
    })
})
