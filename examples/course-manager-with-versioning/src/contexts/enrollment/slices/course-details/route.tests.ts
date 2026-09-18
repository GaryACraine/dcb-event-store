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
import { configureCourseDetailsRoute } from "./route.js"
import { courseDetailsProjection, COURSE_PROJECTION_NAME } from "./projection.js"
import { courseWasRegisteredV1, courseWasRegisteredV2 } from "../../Events.js"

describe("Course details — versioned event projection (Postgres integration)", () => {
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

    test("projects V3 event — all fields populated", async () => {
        const courseWaitFn = (position: SequencePosition, timeoutMs: number) =>
            waitUntilProcessed(pool, COURSE_PROJECTION_NAME, position, { timeoutMs })

        const deps = { store: eventStore, pool }
        const app = getApplication({
            apis: [configureRegisterCourseRoute(deps), configureCourseDetailsRoute({ ...deps, waitFn: courseWaitFn })]
        })

        const agent = supertest(app)

        const postRes = await agent
            .post("/courses")
            .send({ id: "c1", name: "Advanced Math", description: "Deep dive", capacity: 30, department: "Science" })
        expect(postRes.status).toBe(201)

        const getRes = await agent.get("/courses/c1").set("Prefer", "wait=5").set("If-None-Match", '"1"')

        expect(getRes.status).toBe(200)
        expect(getRes.body).toMatchObject({
            id: "c1",
            title: "Advanced Math",
            description: "Deep dive",
            department: "Science",
            capacity: 30
        })
    })

    test("projects V1 event — defaults description to empty string and department to Unknown", async () => {
        const courseWaitFn = (position: SequencePosition, timeoutMs: number) =>
            waitUntilProcessed(pool, COURSE_PROJECTION_NAME, position, { timeoutMs })

        // Seed a V1 event directly into the event store
        await eventStore.append({
            events: courseWasRegisteredV1({ courseId: "c1", title: "Old Math", capacity: 20 })
        })

        await waitUntilProcessed(pool, COURSE_PROJECTION_NAME, SequencePosition.fromString("1"), { timeoutMs: 5000 })

        const deps = { store: eventStore, pool }
        const app = getApplication({
            apis: [configureCourseDetailsRoute({ ...deps, waitFn: courseWaitFn })]
        })

        const getRes = await supertest(app).get("/courses/c1")

        expect(getRes.status).toBe(200)
        expect(getRes.body).toMatchObject({
            id: "c1",
            title: "Old Math",
            description: "",
            department: "Unknown",
            capacity: 20
        })
    })

    test("projects V2 event — defaults description to empty string, uses provided department", async () => {
        const courseWaitFn = (position: SequencePosition, timeoutMs: number) =>
            waitUntilProcessed(pool, COURSE_PROJECTION_NAME, position, { timeoutMs })

        await eventStore.append({
            events: courseWasRegisteredV2({ courseId: "c1", title: "Science 101", capacity: 25, department: "STEM" })
        })

        await waitUntilProcessed(pool, COURSE_PROJECTION_NAME, SequencePosition.fromString("1"), { timeoutMs: 5000 })

        const deps = { store: eventStore, pool }
        const app = getApplication({
            apis: [configureCourseDetailsRoute({ ...deps, waitFn: courseWaitFn })]
        })

        const getRes = await supertest(app).get("/courses/c1")

        expect(getRes.status).toBe(200)
        expect(getRes.body).toMatchObject({
            id: "c1",
            title: "Science 101",
            description: "",
            department: "STEM",
            capacity: 25
        })
    })
})
