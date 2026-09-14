import { describe, test, beforeAll, afterAll, afterEach } from "vitest"
import http from "node:http"
import supertest from "supertest"
import type { Pool } from "pg"
import {
    ApiSpecification,
    ApiE2ESpecification,
    expectResponse,
    expectError,
    getApplication
} from "@dcb-es/event-store-express"
import {
    PostgresEventStore,
    createConsumer,
    projectionToProcessor,
    ensureHandlersInstalled,
    waitUntilProcessed,
    type RunningConsumer
} from "@dcb-es/event-store-postgres"
import { SequencePosition } from "@dcb-es/event-store"
import type { EventStore } from "@dcb-es/event-store"
import { getTestPgDatabasePool } from "@test/testPgDbPool"
import { configureRoutes } from "./routes.js"
import { courseSubscriptionsProjection, PROJECTION_NAME } from "./PostgresCourseSubscriptionsProjection.js"
import {
    CourseWasRegisteredEvent,
    StudentWasRegistered,
    StudentWasSubscribedEvent,
    StudentWasUnsubscribedEvent,
    CourseCapacityWasChangedEvent
} from "./Events.js"

// ---------------------------------------------------------------------------
// Write-side tests — use ApiSpecification (MemoryEventStore, no Postgres)
// ---------------------------------------------------------------------------

const spec = ApiSpecification.for({
    configureApi: (store: EventStore) => configureRoutes({ store, pool: {} as Pool })
})

const e2eSpec = ApiE2ESpecification.for({
    configureApi: (store: EventStore) => configureRoutes({ store, pool: {} as Pool })
})

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
            .then(expectResponse(204), new CourseCapacityWasChangedEvent({ courseId: "c1", newCapacity: 50 }))
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
            .then(expectResponse(201), new StudentWasSubscribedEvent({ courseId: "c1", studentId: "s1" }))
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
            .then(expectResponse(204), new StudentWasUnsubscribedEvent({ courseId: "c1", studentId: "s1" }))
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

// ---------------------------------------------------------------------------
// Read-side integration tests — real Postgres
// ---------------------------------------------------------------------------

describe("Read-side integration — Postgres + Pongo projections", () => {
    let pool: Pool
    let eventStore: PostgresEventStore
    let consumer: RunningConsumer

    function makeWaitFn(pool: Pool): (position: SequencePosition, timeoutMs: number) => Promise<void> {
        return (position, timeoutMs) => waitUntilProcessed(pool, PROJECTION_NAME, position, { timeoutMs })
    }

    function startConsumer(store: PostgresEventStore): RunningConsumer {
        return createConsumer({
            pool,
            eventStore: store,
            processors: [
                projectionToProcessor(courseSubscriptionsProjection, {
                    batchSize: 100,
                    startFrom: "BEGINNING"
                })
            ]
        })
    }

    beforeAll(async () => {
        pool = await getTestPgDatabasePool({ max: 20 })
        eventStore = new PostgresEventStore({ pool })
        await eventStore.ensureInstalled()

        const initClient = await pool.connect()
        try {
            await courseSubscriptionsProjection.init!(initClient)
        } finally {
            initClient.release()
        }

        await ensureHandlersInstalled(pool, [PROJECTION_NAME], "_handler_bookmarks")
        consumer = startConsumer(eventStore)
    })

    afterEach(async () => {
        await consumer.stop()
        await pool.query("TRUNCATE TABLE events")
        await pool.query("ALTER SEQUENCE events_sequence_position_seq RESTART WITH 1")
        await pool.query("DELETE FROM courses")
        await pool.query("DELETE FROM students")
        await pool.query(
            "UPDATE _handler_bookmarks SET last_sequence_position = 0, version = 1, instance_id = NULL"
        )
        eventStore = new PostgresEventStore({ pool })
        consumer = startConsumer(eventStore)
    })

    afterAll(async () => {
        await consumer.stop()
        if (pool) await pool.end()
    })

    test("GET /courses/:courseId returns course after Prefer: wait", async () => {
        const waitFn = makeWaitFn(pool)
        const app = getApplication({
            apis: [configureRoutes({ store: eventStore, pool, waitFn })]
        })

        const agent = supertest(app)

        // Register course via POST — appends position 1
        const postRes = await agent.post("/courses").send({ id: "c1", title: "Math", capacity: 30 })
        expect(postRes.status).toBe(201)

        // GET with Prefer: wait + If-None-Match pointing to position 1
        const getRes = await agent
            .get("/courses/c1")
            .set("Prefer", "wait=5")
            .set("If-None-Match", '"1"')

        expect(getRes.status).toBe(200)
        expect(getRes.body).toMatchObject({
            id: "c1",
            title: "Math",
            capacity: 30,
            subscribedStudents: []
        })
    })

    test("GET /courses/:courseId shows subscribed students after Prefer: wait", async () => {
        const waitFn = makeWaitFn(pool)
        const app = getApplication({
            apis: [configureRoutes({ store: eventStore, pool, waitFn })]
        })

        const agent = supertest(app)

        // POST /courses → position 1
        await agent.post("/courses").send({ id: "c1", title: "Math", capacity: 30 })
        // POST /students → position 2
        await agent.post("/students").send({ id: "s1", name: "Alice" })
        // POST subscription → position 3
        const subRes = await agent.post("/courses/c1/subscriptions").send({ studentId: "s1" })
        expect(subRes.status).toBe(201)

        // Wait for projection to catch up to position 3 before reading
        const getRes = await agent
            .get("/courses/c1")
            .set("Prefer", "wait=5")
            .set("If-None-Match", '"3"')

        expect(getRes.status).toBe(200)
        expect(getRes.body.subscribedStudents).toHaveLength(1)
        expect(getRes.body.subscribedStudents[0].studentId).toBe("s1")
    })

    test("GET /students/:studentId returns student after Prefer: wait", async () => {
        const waitFn = makeWaitFn(pool)
        const app = getApplication({
            apis: [configureRoutes({ store: eventStore, pool, waitFn })]
        })

        const agent = supertest(app)

        // POST /students → position 1
        await agent.post("/students").send({ id: "s1", name: "Alice" })

        const getRes = await agent
            .get("/students/s1")
            .set("Prefer", "wait=5")
            .set("If-None-Match", '"1"')

        expect(getRes.status).toBe(200)
        expect(getRes.body).toMatchObject({
            id: "s1",
            name: "Alice",
            studentNumber: 1,
            subscribedCourses: []
        })
    })

    test("GET /courses returns list of all courses", async () => {
        const waitFn = makeWaitFn(pool)
        const app = getApplication({
            apis: [configureRoutes({ store: eventStore, pool, waitFn })]
        })

        const agent = supertest(app)

        // POST two courses → positions 1 and 2
        await agent.post("/courses").send({ id: "c1", title: "Math", capacity: 30 })
        await agent.post("/courses").send({ id: "c2", title: "Science", capacity: 20 })

        // Wait for both to be projected (up to position 2)
        await waitUntilProcessed(pool, PROJECTION_NAME, SequencePosition.fromString("2"), { timeoutMs: 5000 })

        const getRes = await agent.get("/courses")
        expect(getRes.status).toBe(200)
        expect(Array.isArray(getRes.body)).toBe(true)
        expect(getRes.body).toHaveLength(2)
    })

    test("GET /events streams events via SSE", async () => {
        const app = getApplication({
            apis: [configureRoutes({ store: eventStore, pool })]
        })

        const server = await new Promise<http.Server>(resolve => {
            const srv = http.createServer(app).listen(0, "127.0.0.1", () => resolve(srv))
        })

        try {
            const addr = server.address() as { port: number }

            // Collect one SSE message
            const messagePromise = new Promise<{ id: string; data: unknown }>((resolve, reject) => {
                let buffer = ""
                const req = http.get(
                    { host: "127.0.0.1", port: addr.port, path: "/events" },
                    res => {
                        const timer = setTimeout(() => {
                            req.destroy()
                            reject(new Error("SSE timeout — no event received"))
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
                    }
                )
                req.on("error", err => {
                    if ((err as NodeJS.ErrnoException).code !== "ECONNRESET") {
                        reject(err)
                    }
                })
            })

            // Give SSE connection time to establish before appending
            await new Promise<void>(resolve => setTimeout(resolve, 100))

            // Append a course event — will be at position 1 after sequence reset
            const appendedPosition = await eventStore.append({
                events: new CourseWasRegisteredEvent({ courseId: "c1", title: "Math", capacity: 30 })
            })

            const message = await messagePromise
            // The event position should match what was appended
            expect(message.id).toBe(appendedPosition.toString())
            const data = message.data as { event: { type: string } }
            expect(data.event.type).toBe("courseWasRegistered")
        } finally {
            await new Promise<void>(resolve => {
                server.closeAllConnections?.()
                server.close(() => resolve())
            })
        }
    })
})
