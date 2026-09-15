import { describe, test, beforeAll, afterAll, afterEach } from "vitest"
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
import { configureRegisterCourseRoute } from "../register-course/route.js"
import { configureRegisterStudentRoute } from "../register-student/route.js"
import { configureSubscribeStudentRoute } from "../subscribe-student/route.js"
import { configureCourseDetailsRoute } from "./route.js"
import { configureCourseListRoute } from "../course-list/route.js"
import { courseDetailsProjection, COURSE_PROJECTION_NAME } from "./projection.js"

describe("Course details — Postgres integration", () => {
    let pool: Pool
    let eventStore: PostgresEventStore
    let consumer: RunningConsumer

    function startConsumer(store: PostgresEventStore): RunningConsumer {
        return createConsumer({
            pool,
            eventStore: store,
            processors: [projectionToProcessor(courseDetailsProjection, { batchSize: 100, startFrom: "BEGINNING" })]
        })
    }

    beforeAll(async () => {
        pool = await getTestPgDatabasePool({ max: 20 })
        eventStore = new PostgresEventStore({ pool })
        await eventStore.ensureInstalled()

        const initClient = await pool.connect()
        try {
            await courseDetailsProjection.init!(initClient)
        } finally {
            initClient.release()
        }

        await ensureHandlersInstalled(pool, [COURSE_PROJECTION_NAME], "_handler_bookmarks")
        consumer = startConsumer(eventStore)
    })

    afterEach(async () => {
        await consumer.stop()
        await pool.query("TRUNCATE TABLE events")
        await pool.query("ALTER SEQUENCE events_sequence_position_seq RESTART WITH 1")
        await pool.query("DELETE FROM courses")
        await pool.query("DELETE FROM _course_projection_students")
        await pool.query("UPDATE _handler_bookmarks SET last_sequence_position = 0, version = 1, instance_id = NULL")
        eventStore = new PostgresEventStore({ pool })
        consumer = startConsumer(eventStore)
    })

    afterAll(async () => {
        await consumer.stop()
        if (pool) await pool.end()
    })

    test("GET /courses/:courseId returns course after Prefer: wait", async () => {
        const courseWaitFn = (position: SequencePosition, timeoutMs: number) =>
            waitUntilProcessed(pool, COURSE_PROJECTION_NAME, position, { timeoutMs })

        const deps = { store: eventStore, pool }
        const app = getApplication({
            apis: [configureRegisterCourseRoute(deps), configureCourseDetailsRoute({ ...deps, waitFn: courseWaitFn })]
        })

        const agent = supertest(app)

        const postRes = await agent.post("/courses").send({ id: "c1", title: "Math", capacity: 30 })
        expect(postRes.status).toBe(201)

        const getRes = await agent.get("/courses/c1").set("Prefer", "wait=5").set("If-None-Match", '"1"')

        expect(getRes.status).toBe(200)
        expect(getRes.body).toMatchObject({
            id: "c1",
            title: "Math",
            capacity: 30,
            subscribedStudents: []
        })
        expect(getRes.headers["etag"]).toBe('"1"')
    })

    test("GET /courses/:courseId shows subscribed students after Prefer: wait", async () => {
        const courseWaitFn = (position: SequencePosition, timeoutMs: number) =>
            waitUntilProcessed(pool, COURSE_PROJECTION_NAME, position, { timeoutMs })

        const deps = { store: eventStore, pool }
        const app = getApplication({
            apis: [
                configureRegisterCourseRoute(deps),
                configureRegisterStudentRoute(deps),
                configureSubscribeStudentRoute(deps),
                configureCourseDetailsRoute({ ...deps, waitFn: courseWaitFn })
            ]
        })

        const agent = supertest(app)

        await agent.post("/courses").send({ id: "c1", title: "Math", capacity: 30 })
        await agent.post("/students").send({ id: "s1", name: "Alice" })

        const subRes = await agent.post("/courses/c1/subscriptions").send({ studentId: "s1" })
        expect(subRes.status).toBe(201)

        const getRes = await agent.get("/courses/c1").set("Prefer", "wait=5").set("If-None-Match", '"3"')

        expect(getRes.status).toBe(200)
        expect(getRes.body.subscribedStudents).toHaveLength(1)
        expect(getRes.body.subscribedStudents[0].studentId).toBe("s1")
        expect(getRes.headers["etag"]).toBe('"3"')
    })

    test("GET /courses returns list of all courses", async () => {
        const courseWaitFn = (position: SequencePosition, timeoutMs: number) =>
            waitUntilProcessed(pool, COURSE_PROJECTION_NAME, position, { timeoutMs })

        const deps = { store: eventStore, pool }
        const app = getApplication({
            apis: [configureRegisterCourseRoute(deps), configureCourseListRoute({ ...deps, waitFn: courseWaitFn })]
        })

        const agent = supertest(app)

        await agent.post("/courses").send({ id: "c1", title: "Math", capacity: 30 })
        await agent.post("/courses").send({ id: "c2", title: "Science", capacity: 20 })

        await waitUntilProcessed(pool, COURSE_PROJECTION_NAME, SequencePosition.fromString("2"), { timeoutMs: 5000 })

        const getRes = await agent.get("/courses")
        expect(getRes.status).toBe(200)
        expect(Array.isArray(getRes.body.data)).toBe(true)
        expect(getRes.body.data).toHaveLength(2)
        expect(getRes.headers["etag"]).toBe('"2"')
    })
})
