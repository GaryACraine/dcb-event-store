import { describe, test } from "vitest"
import type { Pool } from "pg"
import { ApiSpecification, expectResponse } from "@dcb-es/event-store-express"
import type { EventStore } from "@dcb-es/event-store"
import { configureUnsubscribeStudentRoute } from "./route.js"
import {
    courseWasRegistered,
    courseWasRegisteredV1,
    studentWasSubscribed,
    studentWasUnsubscribed
} from "../../Events.js"

const spec = ApiSpecification.for({
    configureApi: (store: EventStore) => configureUnsubscribeStudentRoute({ store, pool: {} as Pool })
})

describe("DELETE /courses/:courseId/subscriptions/:studentId — unsubscribe student", () => {
    test("unsubscribes student and returns 204", async () => {
        await spec
            .existingEvents(
                courseWasRegistered({
                    courseId: "c1",
                    name: "Math",
                    description: "desc",
                    capacity: 30,
                    department: "Science"
                }),
                studentWasSubscribed({ courseId: "c1", studentId: "s1" })
            )
            .when(agent => agent.delete("/courses/c1/subscriptions/s1"))
            .then(
                expectResponse(204, { headers: { etag: '"3"' } }),
                studentWasUnsubscribed({ courseId: "c1", studentId: "s1" })
            )
    })

    test("works with V1 course history", async () => {
        await spec
            .existingEvents(
                courseWasRegisteredV1({ courseId: "c1", title: "Math", capacity: 30 }),
                studentWasSubscribed({ courseId: "c1", studentId: "s1" })
            )
            .when(agent => agent.delete("/courses/c1/subscriptions/s1"))
            .then(
                expectResponse(204, { headers: { etag: '"3"' } }),
                studentWasUnsubscribed({ courseId: "c1", studentId: "s1" })
            )
    })
})
