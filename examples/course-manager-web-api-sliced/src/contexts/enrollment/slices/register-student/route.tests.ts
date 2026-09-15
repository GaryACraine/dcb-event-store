import { describe, test } from "vitest"
import type { Pool } from "pg"
import { ApiSpecification, expectResponse, expectError } from "@dcb-es/event-store-express"
import type { EventStore } from "@dcb-es/event-store"
import { configureRegisterStudentRoute } from "./route.js"
import { StudentWasRegistered } from "../../Events.js"

const spec = ApiSpecification.for({
    configureApi: (store: EventStore) => configureRegisterStudentRoute({ store, pool: {} as Pool })
})

describe("POST /students — register student", () => {
    test("registers a new student and returns 201", async () => {
        await spec
            .when(agent => agent.post("/students").send({ id: "s1", name: "Alice" }))
            .then(
                expectResponse(201, { body: { id: "s1" }, headers: { etag: '"1"' } }),
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

describe("POST /students — request body validation", () => {
    test("returns 400 when name is missing", async () => {
        await spec.when(agent => agent.post("/students").send({ id: "s1" })).then(expectError(400))
    })

    test("returns 400 when name is empty string", async () => {
        await spec.when(agent => agent.post("/students").send({ id: "s1", name: "" })).then(expectError(400))
    })
})
