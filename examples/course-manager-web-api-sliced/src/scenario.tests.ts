import { describe, test, beforeAll, afterAll } from "vitest"
import http from "node:http"
import supertest from "supertest"
import type { Pool } from "pg"
import { getApplication } from "@dcb-es/event-store-express"
import {
    PostgresEventStore,
    createConsumer,
    projectionToProcessor,
    ensureHandlersInstalled,
    waitUntilProcessed,
    type RunningConsumer
} from "@dcb-es/event-store-postgres"
import { SequencePosition } from "@dcb-es/event-store"
import { getTestPgDatabasePool } from "@test/testPgDbPool"

// Projections
import {
    courseDetailsProjection,
    COURSE_PROJECTION_NAME
} from "./contexts/enrollment/slices/course-details/projection.js"
import {
    studentDetailsProjection,
    STUDENT_PROJECTION_NAME
} from "./contexts/enrollment/slices/student-details/projection.js"

// Write slices
import { configureRegisterCourseRoute } from "./contexts/enrollment/slices/register-course/route.js"
import { configureRegisterStudentRoute } from "./contexts/enrollment/slices/register-student/route.js"
import { configureSubscribeStudentRoute } from "./contexts/enrollment/slices/subscribe-student/route.js"
import { configureUnsubscribeStudentRoute } from "./contexts/enrollment/slices/unsubscribe-student/route.js"
import { configureChangeCourseCapacityRoute } from "./contexts/enrollment/slices/change-course-capacity/route.js"

// Read slices
import { configureCourseDetailsRoute } from "./contexts/enrollment/slices/course-details/route.js"
import { configureCourseListRoute } from "./contexts/enrollment/slices/course-list/route.js"
import { configureStudentDetailsRoute } from "./contexts/enrollment/slices/student-details/route.js"

// Infrastructure slices
import { configureEventFeedRoute } from "./contexts/enrollment/slices/event-feed/route.js"
import { configureOpenApiRoute } from "./contexts/enrollment/slices/openapi/route.js"

describe("Scenario: course enrollment lifecycle", () => {
    let pool: Pool
    let eventStore: PostgresEventStore
    let consumer: RunningConsumer
    let app: ReturnType<typeof getApplication>

    function startConsumer(store: PostgresEventStore): RunningConsumer {
        return createConsumer({
            pool,
            eventStore: store,
            processors: [
                projectionToProcessor(courseDetailsProjection, { batchSize: 100, startFrom: "BEGINNING" }),
                projectionToProcessor(studentDetailsProjection, { batchSize: 100, startFrom: "BEGINNING" })
            ]
        })
    }

    beforeAll(async () => {
        pool = await getTestPgDatabasePool({ max: 20 })
        eventStore = new PostgresEventStore({ pool })
        await eventStore.ensureInstalled()

        const initClient = await pool.connect()
        try {
            await courseDetailsProjection.init!(initClient)
            await studentDetailsProjection.init!(initClient)
        } finally {
            initClient.release()
        }

        await ensureHandlersInstalled(pool, [COURSE_PROJECTION_NAME, STUDENT_PROJECTION_NAME], "_handler_bookmarks")
        consumer = startConsumer(eventStore)

        const courseWaitFn = (position: SequencePosition, timeoutMs: number) =>
            waitUntilProcessed(pool, COURSE_PROJECTION_NAME, position, { timeoutMs })
        const studentWaitFn = (position: SequencePosition, timeoutMs: number) =>
            waitUntilProcessed(pool, STUDENT_PROJECTION_NAME, position, { timeoutMs })

        const deps = { store: eventStore, pool }

        app = getApplication({
            apis: [
                configureRegisterCourseRoute(deps),
                configureRegisterStudentRoute(deps),
                configureSubscribeStudentRoute(deps),
                configureUnsubscribeStudentRoute(deps),
                configureChangeCourseCapacityRoute(deps),
                configureCourseDetailsRoute({ ...deps, waitFn: courseWaitFn }),
                configureCourseListRoute({ ...deps, waitFn: courseWaitFn }),
                configureStudentDetailsRoute({ ...deps, waitFn: studentWaitFn }),
                configureEventFeedRoute(eventStore),
                configureOpenApiRoute()
            ]
        })
    })

    afterAll(async () => {
        await consumer.stop()
        if (pool) await pool.end()
    })

    test("full course enrollment lifecycle with read-your-writes", async () => {
        const agent = supertest(app)

        // Step 1: Register the course
        const step1 = await agent
            .post("/courses")
            .send({ id: "ts101", title: "Introduction to TypeScript", capacity: 2 })
        expect(step1.status).toBe(201)
        expect(step1.headers["etag"]).toBeDefined()
        const courseETag = step1.headers["etag"] as string

        // Step 2: Register Alice
        const step2 = await agent.post("/students").send({ id: "alice", name: "Alice" })
        expect(step2.status).toBe(201)

        // Step 3: Register Bob
        const step3 = await agent.post("/students").send({ id: "bob", name: "Bob" })
        expect(step3.status).toBe(201)

        // Step 4: Register Charlie
        const step4 = await agent.post("/students").send({ id: "charlie", name: "Charlie" })
        expect(step4.status).toBe(201)

        // Step 5: Read course — wait until courseETag is projected
        const step5 = await agent.get("/courses/ts101").set("Prefer", "wait=5").set("If-None-Match", courseETag)
        expect(step5.status).toBe(200)
        expect(step5.body.subscribedStudents).toHaveLength(0)

        // Step 6: Subscribe Alice
        const step6 = await agent.post("/courses/ts101/subscriptions").send({ studentId: "alice" })
        expect(step6.status).toBe(201)
        const subETag = step6.headers["etag"] as string

        // Step 7: Read course — wait until Alice's subscription is projected
        const step7 = await agent.get("/courses/ts101").set("Prefer", "wait=5").set("If-None-Match", subETag)
        expect(step7.status).toBe(200)
        expect(step7.body.subscribedStudents).toHaveLength(1)
        expect(step7.body.subscribedStudents[0].studentId).toBe("alice")

        // Step 8: Subscribe Bob (fills the course)
        const step8 = await agent.post("/courses/ts101/subscriptions").send({ studentId: "bob" })
        expect(step8.status).toBe(201)

        // Step 9: Try to subscribe Charlie — course is full
        const step9 = await agent.post("/courses/ts101/subscriptions").send({ studentId: "charlie" })
        expect(step9.status).toBe(422)
        expect(step9.body.detail).toBe("Course ts101 is full.")

        // Step 10: Unsubscribe Alice
        const step10 = await agent.delete("/courses/ts101/subscriptions/alice")
        expect(step10.status).toBe(204)

        // Step 11: Subscribe Charlie — now there is a spot
        const step11 = await agent.post("/courses/ts101/subscriptions").send({ studentId: "charlie" })
        expect(step11.status).toBe(201)
        const charlieSubETag = step11.headers["etag"] as string

        // Step 12: Read student — wait until Charlie's subscription is projected
        const step12 = await agent.get("/students/charlie").set("Prefer", "wait=5").set("If-None-Match", charlieSubETag)
        expect(step12.status).toBe(200)
        const subscribedCourseIds = step12.body.subscribedCourses.map((c: { courseId: string }) => c.courseId)
        expect(subscribedCourseIds).toContain("ts101")

        // Step 13: SSE push notification
        const server = await new Promise<http.Server>(resolve => {
            const srv = http.createServer(app).listen(0, "127.0.0.1", () => resolve(srv))
        })

        try {
            const addr = server.address() as { port: number }

            const messagePromise = new Promise<{ id: string; data: unknown }>((resolve, reject) => {
                let buffer = ""
                const req = http.get({ host: "127.0.0.1", port: addr.port, path: "/events" }, res => {
                    const timer = setTimeout(() => {
                        req.destroy()
                        reject(new Error("SSE timeout — no event received within 8 s"))
                    }, 8000)

                    res.on("data", (chunk: Buffer) => {
                        buffer += chunk.toString()
                        const parts = buffer.split("\n\n")
                        buffer = parts.pop() ?? ""
                        for (const part of parts) {
                            if (!part.trim() || part.startsWith(":")) continue
                            const lines = part.split("\n")
                            let id = ""
                            let dataStr = ""
                            for (const line of lines) {
                                if (line.startsWith("id: ")) id = line.slice(4)
                                else if (line.startsWith("data: ")) dataStr = line.slice(6)
                            }
                            if (dataStr) {
                                clearTimeout(timer)
                                req.destroy()
                                try {
                                    resolve({ id, data: JSON.parse(dataStr) })
                                } catch {
                                    resolve({ id, data: dataStr })
                                }
                            }
                        }
                    })
                    res.on("error", () => resolve({ id: "", data: null }))
                })
                req.on("error", err => {
                    if ((err as NodeJS.ErrnoException).code !== "ECONNRESET") {
                        reject(err)
                    }
                })
            })

            await new Promise<void>(resolve => setTimeout(resolve, 100))

            const postRes = await agent.post("/courses").send({ id: "extra101", title: "Bonus Course", capacity: 5 })
            expect(postRes.status).toBe(201)

            const message = await messagePromise
            const data = message.data as { event: { type: string } }
            expect(data.event.type).toBe("courseWasRegistered")
        } finally {
            await new Promise<void>(resolve => {
                server.closeAllConnections?.()
                server.close(() => resolve())
            })
        }

        // Step 14: Register a third course
        const step14 = await agent.post("/courses").send({ id: "go101", title: "Introduction to Go", capacity: 20 })
        expect(step14.status).toBe(201)
        const goETag = step14.headers["etag"] as string

        // Step 15: First page of courses (limit=2)
        const step15 = await agent.get("/courses?limit=2").set("Prefer", "wait=5").set("If-None-Match", goETag)
        expect(step15.status).toBe(200)
        expect(step15.body.data).toHaveLength(2)
        expect(step15.body.cursor).toBeDefined()
        const pageCursor = step15.body.cursor as string

        // Step 16: Second (last) page of courses
        const step16 = await agent.get(`/courses?cursor=${pageCursor}&limit=2`)
        expect(step16.status).toBe(200)
        expect(step16.body.data).toHaveLength(1)
        expect(step16.body.cursor).toBeUndefined()

        // Step 17: POST /courses with Idempotency-Key
        const idempotencyKey = "f47ac10b-58cc-4372-a567-0e02b2c3d479"
        const step17 = await agent
            .post("/courses")
            .set("Idempotency-Key", idempotencyKey)
            .send({ id: "idempotent101", title: "Idempotent Course", capacity: 10 })
        expect(step17.status).toBe(201)
        const idempotentETag = step17.headers["etag"] as string

        // Step 18: Retry with same Idempotency-Key
        const step18 = await agent
            .post("/courses")
            .set("Idempotency-Key", idempotencyKey)
            .send({ id: "idempotent101", title: "Idempotent Course", capacity: 10 })
        expect(step18.status).toBe(201)
        expect(step18.headers["etag"]).toBe(idempotentETag)
    })
})
