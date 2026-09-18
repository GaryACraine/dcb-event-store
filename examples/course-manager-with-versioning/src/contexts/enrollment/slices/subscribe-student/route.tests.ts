import { describe, test } from "vitest"
import type { Pool } from "pg"
import { ApiSpecification, expectResponse, expectError } from "@dcb-es/event-store-express"
import type { EventStore } from "@dcb-es/event-store"
import { configureSubscribeStudentRoute } from "./route.js"
import {
    courseWasRegistered,
    courseWasRegisteredV1,
    courseWasRegisteredV2,
    studentWasSubscribed
} from "../../Events.js"

const spec = ApiSpecification.for({
    configureApi: (store: EventStore) => configureSubscribeStudentRoute({ store, pool: {} as Pool })
})

describe("POST /courses/:courseId/subscriptions — subscribe student", () => {
    test("subscribes student to course registered with V3 event", async () => {
        await spec
            .existingEvents(
                courseWasRegistered({ courseId: "c1", name: "Math", description: "desc", capacity: 30, department: "Science" })
            )
            .when(agent => agent.post("/courses/c1/subscriptions").send({ studentId: "s1" }))
            .then(
                expectResponse(201, { headers: { etag: '"2"' } }),
                studentWasSubscribed({ courseId: "c1", studentId: "s1" })
            )
    })

    test("subscribes student to course registered with V1 event (versionedHandler pattern)", async () => {
        await spec
            .existingEvents(courseWasRegisteredV1({ courseId: "c1", title: "Math", capacity: 30 }))
            .when(agent => agent.post("/courses/c1/subscriptions").send({ studentId: "s1" }))
            .then(
                expectResponse(201, { headers: { etag: '"2"' } }),
                studentWasSubscribed({ courseId: "c1", studentId: "s1" })
            )
    })

    test("subscribes student to course registered with V2 event (versionedHandler pattern)", async () => {
        await spec
            .existingEvents(
                courseWasRegisteredV2({ courseId: "c1", title: "Math", capacity: 30, department: "Science" })
            )
            .when(agent => agent.post("/courses/c1/subscriptions").send({ studentId: "s1" }))
            .then(
                expectResponse(201, { headers: { etag: '"2"' } }),
                studentWasSubscribed({ courseId: "c1", studentId: "s1" })
            )
    })

    test("mixed V1 + V3 history: subscribes to latest V3 registration", async () => {
        await spec
            .existingEvents(
                courseWasRegisteredV1({ courseId: "c1", title: "Old Math", capacity: 10 }),
                // Later re-registered with V3 (simulates migration scenario)
                courseWasRegistered({ courseId: "c2", name: "New Math", description: "desc", capacity: 30, department: "Science" })
            )
            .when(agent => agent.post("/courses/c2/subscriptions").send({ studentId: "s1" }))
            .then(
                expectResponse(201, { headers: { etag: '"3"' } }),
                studentWasSubscribed({ courseId: "c2", studentId: "s1" })
            )
    })

    test("returns 422 when course is full", async () => {
        await spec
            .existingEvents(
                courseWasRegistered({ courseId: "c1", name: "Math", description: "desc", capacity: 1, department: "Science" }),
                studentWasSubscribed({ courseId: "c1", studentId: "s1" })
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
