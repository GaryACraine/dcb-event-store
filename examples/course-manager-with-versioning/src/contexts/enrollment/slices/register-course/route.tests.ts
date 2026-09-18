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

describe("POST /courses — register course (V3 shape)", () => {
    test("registers a new course and returns 201", async () => {
        await spec
            .when(agent =>
                agent
                    .post("/courses")
                    .send({ id: "c1", name: "Math", description: "Introduction to Mathematics", capacity: 30, department: "Science" })
            )
            .then(
                expectResponse(201, { body: { id: "c1" }, headers: { etag: '"1"' } }),
                courseWasRegistered({ courseId: "c1", name: "Math", description: "Introduction to Mathematics", capacity: 30, department: "Science" })
            )
    })

    test("returns 422 when course already exists", async () => {
        await spec
            .existingEvents(
                courseWasRegistered({ courseId: "c1", name: "Math", description: "Introduction to Mathematics", capacity: 30, department: "Science" })
            )
            .when(agent =>
                agent
                    .post("/courses")
                    .send({ id: "c1", name: "Math", description: "Introduction to Mathematics", capacity: 30, department: "Science" })
            )
            .then(expectError(422))
    })
})

describe("POST /courses — request body validation", () => {
    test("returns 400 when name is missing", async () => {
        await spec
            .when(agent =>
                agent
                    .post("/courses")
                    .send({ id: "c1", description: "desc", capacity: 30, department: "Science" })
            )
            .then(expectError(400))
    })

    test("returns 400 when department is missing", async () => {
        await spec
            .when(agent =>
                agent
                    .post("/courses")
                    .send({ id: "c1", name: "Math", description: "desc", capacity: 30 })
            )
            .then(expectError(400))
    })
})

describe("POST /courses — E2E", () => {
    test("create course via HTTP, then duplicate returns 422", async () => {
        await e2eSpec
            .existingRequests(agent =>
                agent
                    .post("/courses")
                    .send({ id: "c1", name: "Math", description: "Introduction to Mathematics", capacity: 30, department: "Science" })
            )
            .when(agent =>
                agent
                    .post("/courses")
                    .send({ id: "c1", name: "Math", description: "Introduction to Mathematics", capacity: 30, department: "Science" })
            )
            .then(expectError(422))
    })
})
