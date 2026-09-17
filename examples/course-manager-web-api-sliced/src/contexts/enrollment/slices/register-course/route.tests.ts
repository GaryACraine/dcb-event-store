import { describe, test } from "vitest"
import type { Pool } from "pg"
import { ApiSpecification, ApiE2ESpecification, expectResponse, expectError } from "@dcb-es/event-store-express"
import type { EventStore } from "@dcb-es/event-store"
import { configureRegisterCourseRoute } from "./route.js"
import { courseWasRegistered } from "../../Events.js"

const spec = ApiSpecification.for({
    configureApi: (store: EventStore) => configureRegisterCourseRoute({ store, pool: {} as Pool })
})

const e2eSpec = ApiE2ESpecification.for({
    configureApi: (store: EventStore) => configureRegisterCourseRoute({ store, pool: {} as Pool })
})

describe("POST /courses — register course", () => {
    test("registers a new course and returns 201", async () => {
        await spec
            .when(agent => agent.post("/courses").send({ id: "c1", title: "Math", capacity: 30 }))
            .then(
                expectResponse(201, { body: { id: "c1" }, headers: { etag: '"1"' } }),
                courseWasRegistered({ courseId: "c1", title: "Math", capacity: 30 })
            )
    })

    test("returns 422 when course already exists", async () => {
        await spec
            .existingEvents(courseWasRegistered({ courseId: "c1", title: "Math", capacity: 30 }))
            .when(agent => agent.post("/courses").send({ id: "c1", title: "Math", capacity: 30 }))
            .then(expectError(422))
    })
})

describe("POST /courses — request body validation", () => {
    test("returns 400 when capacity is missing", async () => {
        await spec.when(agent => agent.post("/courses").send({ id: "c1", title: "Math" })).then(expectError(400))
    })

    test("returns 400 when capacity is zero", async () => {
        await spec
            .when(agent => agent.post("/courses").send({ id: "c1", title: "Math", capacity: 0 }))
            .then(expectError(400))
    })

    test("returns 400 when capacity is a string", async () => {
        await spec
            .when(agent => agent.post("/courses").send({ id: "c1", title: "Math", capacity: "thirty" }))
            .then(expectError(400))
    })

    test("returns 400 when title is empty string", async () => {
        await spec
            .when(agent => agent.post("/courses").send({ id: "c1", title: "", capacity: 30 }))
            .then(expectError(400))
    })
})

describe("POST /courses — idempotency key", () => {
    test("sets event.id to the Idempotency-Key value", async () => {
        const key = "550e8400-e29b-41d4-a716-446655440000"
        await spec
            .when(agent =>
                agent.post("/courses").set("Idempotency-Key", key).send({ id: "c1", title: "Math", capacity: 30 })
            )
            .then(
                expectResponse(201, { body: { id: "c1" }, headers: { etag: '"1"' } }),
                courseWasRegistered({ courseId: "c1", title: "Math", capacity: 30 })
            )
    })
})

describe("POST /courses — E2E", () => {
    test("create course via HTTP, then duplicate returns 422", async () => {
        await e2eSpec
            .existingRequests(agent => agent.post("/courses").send({ id: "c1", title: "Math", capacity: 30 }))
            .when(agent => agent.post("/courses").send({ id: "c1", title: "Math", capacity: 30 }))
            .then(expectError(422))
    })
})
