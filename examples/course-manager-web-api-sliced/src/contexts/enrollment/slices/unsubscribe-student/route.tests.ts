import { describe, test } from "vitest"
import type { Pool } from "pg"
import { ApiSpecification, expectResponse } from "@dcb-es/event-store-express"
import type { EventStore } from "@dcb-es/event-store"
import { configureUnsubscribeStudentRoute } from "./route.js"
import { CourseWasRegisteredEvent, StudentWasSubscribedEvent, StudentWasUnsubscribedEvent } from "../../Events.js"

const spec = ApiSpecification.for({
    configureApi: (store: EventStore) => configureUnsubscribeStudentRoute({ store, pool: {} as Pool })
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
                expectResponse(204, { headers: { etag: '"3"' } }),
                new StudentWasUnsubscribedEvent({ courseId: "c1", studentId: "s1" })
            )
    })
})
