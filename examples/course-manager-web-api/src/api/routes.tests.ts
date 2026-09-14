import { describe, test } from "vitest"
import { ApiSpecification, ApiE2ESpecification, expectResponse, expectError } from "@dcb-es/event-store-express"
import { configureRoutes } from "./routes.js"
import {
    CourseWasRegisteredEvent,
    StudentWasRegistered,
    StudentWasSubscribedEvent,
    StudentWasUnsubscribedEvent,
    CourseCapacityWasChangedEvent
} from "./Events.js"

const spec = ApiSpecification.for({ configureApi: configureRoutes })
const e2eSpec = ApiE2ESpecification.for({ configureApi: configureRoutes })

describe("POST /courses — register course", () => {
    test("registers a new course and returns 201", async () => {
        await spec
            .when(agent => agent.post("/courses").send({ id: "c1", title: "Math", capacity: 30 }))
            .then(
                expectResponse(201, { body: { id: "c1" } }),
                new CourseWasRegisteredEvent({ courseId: "c1", title: "Math", capacity: 30 })
            )
    })

    test("returns 422 when course already exists", async () => {
        await spec
            .existingEvents(new CourseWasRegisteredEvent({ courseId: "c1", title: "Math", capacity: 30 }))
            .when(agent => agent.post("/courses").send({ id: "c1", title: "Math", capacity: 30 }))
            .then(expectError(422))
    })
})

describe("POST /students — register student", () => {
    test("registers a new student and returns 201", async () => {
        await spec
            .when(agent => agent.post("/students").send({ id: "s1", name: "Alice" }))
            .then(
                expectResponse(201, { body: { id: "s1" } }),
                new StudentWasRegistered({ studentId: "s1", name: "Alice", studentNumber: 1 })
            )
    })

    test("returns 422 when student already exists", async () => {
        await spec
            .existingEvents(new StudentWasRegistered({ studentId: "s1", name: "Alice", studentNumber: 1 }))
            .when(agent => agent.post("/students").send({ id: "s1", name: "Alice" }))
            .then(expectError(422))
    })
})

describe("PUT /courses/:courseId/capacity — update capacity", () => {
    test("updates capacity and returns 204", async () => {
        await spec
            .existingEvents(new CourseWasRegisteredEvent({ courseId: "c1", title: "Math", capacity: 30 }))
            .when(agent => agent.put("/courses/c1/capacity").send({ newCapacity: 50 }))
            .then(
                expectResponse(204),
                new CourseCapacityWasChangedEvent({ courseId: "c1", newCapacity: 50 })
            )
    })

    test("returns 404 when course does not exist", async () => {
        await spec
            .when(agent => agent.put("/courses/nonexistent/capacity").send({ newCapacity: 50 }))
            .then(expectError(404))
    })
})

describe("POST /courses/:courseId/subscriptions — subscribe student", () => {
    test("subscribes student and returns 201", async () => {
        await spec
            .existingEvents(new CourseWasRegisteredEvent({ courseId: "c1", title: "Math", capacity: 30 }))
            .when(agent => agent.post("/courses/c1/subscriptions").send({ studentId: "s1" }))
            .then(
                expectResponse(201),
                new StudentWasSubscribedEvent({ courseId: "c1", studentId: "s1" })
            )
    })

    test("returns 422 when course is full", async () => {
        await spec
            .existingEvents(
                new CourseWasRegisteredEvent({ courseId: "c1", title: "Math", capacity: 1 }),
                new StudentWasSubscribedEvent({ courseId: "c1", studentId: "s1" })
            )
            .when(agent => agent.post("/courses/c1/subscriptions").send({ studentId: "s2" }))
            .then(expectError(422, { detail: "Course c1 is full." }))
    })

    test("returns 404 when course does not exist", async () => {
        await spec
            .when(agent => agent.post("/courses/nonexistent/subscriptions").send({ studentId: "s1" }))
            .then(expectError(404))
    })
})

describe("DELETE /courses/:courseId/subscriptions/:studentId — unsubscribe student", () => {
    test("unsubscribes student and returns 204", async () => {
        await spec
            .existingEvents(
                new CourseWasRegisteredEvent({ courseId: "c1", title: "Math", capacity: 30 }),
                new StudentWasSubscribedEvent({ courseId: "c1", studentId: "s1" })
            )
            .when(agent => agent.delete("/courses/c1/subscriptions/s1"))
            .then(
                expectResponse(204),
                new StudentWasUnsubscribedEvent({ courseId: "c1", studentId: "s1" })
            )
    })
})

describe("E2E — request-seeded flows", () => {
    test("create course via HTTP, then duplicate returns 422", async () => {
        await e2eSpec
            .existingRequests(agent => agent.post("/courses").send({ id: "c1", title: "Math", capacity: 30 }))
            .when(agent => agent.post("/courses").send({ id: "c1", title: "Math", capacity: 30 }))
            .then(expectError(422))
    })

    test("create course and student via HTTP, then subscribe returns 201", async () => {
        await e2eSpec
            .existingRequests(
                agent => agent.post("/courses").send({ id: "c1", title: "Math", capacity: 30 }),
                agent => agent.post("/students").send({ id: "s1", name: "Alice" })
            )
            .when(agent => agent.post("/courses/c1/subscriptions").send({ studentId: "s1" }))
            .then(expectResponse(201))
    })

    test("create, subscribe, then unsubscribe returns 204", async () => {
        await e2eSpec
            .existingRequests(
                agent => agent.post("/courses").send({ id: "c1", title: "Math", capacity: 30 }),
                agent => agent.post("/courses/c1/subscriptions").send({ studentId: "s1" })
            )
            .when(agent => agent.delete("/courses/c1/subscriptions/s1"))
            .then(expectResponse(204))
    })
})
