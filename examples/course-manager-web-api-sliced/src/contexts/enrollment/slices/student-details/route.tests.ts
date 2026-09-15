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
import { configureRegisterStudentRoute } from "../register-student/route.js"
import { configureStudentDetailsRoute } from "./route.js"
import { studentDetailsProjection, STUDENT_PROJECTION_NAME } from "./projection.js"

describe("Student details — Postgres integration", () => {
    let pool: Pool
    let eventStore: PostgresEventStore
    let consumer: RunningConsumer

    function startConsumer(store: PostgresEventStore): RunningConsumer {
        return createConsumer({
            pool,
            eventStore: store,
            processors: [projectionToProcessor(studentDetailsProjection, { batchSize: 100, startFrom: "BEGINNING" })]
        })
    }

    beforeAll(async () => {
        pool = await getTestPgDatabasePool({ max: 20 })
        eventStore = new PostgresEventStore({ pool })
        await eventStore.ensureInstalled()

        const initClient = await pool.connect()
        try {
            await studentDetailsProjection.init!(initClient)
        } finally {
            initClient.release()
        }

        await ensureHandlersInstalled(pool, [STUDENT_PROJECTION_NAME], "_handler_bookmarks")
        consumer = startConsumer(eventStore)
    })

    afterEach(async () => {
        await consumer.stop()
        await pool.query("TRUNCATE TABLE events")
        await pool.query("ALTER SEQUENCE events_sequence_position_seq RESTART WITH 1")
        await pool.query("DELETE FROM students")
        await pool.query("DELETE FROM _student_projection_courses")
        await pool.query("UPDATE _handler_bookmarks SET last_sequence_position = 0, version = 1, instance_id = NULL")
        eventStore = new PostgresEventStore({ pool })
        consumer = startConsumer(eventStore)
    })

    afterAll(async () => {
        await consumer.stop()
        if (pool) await pool.end()
    })

    test("GET /students/:studentId returns student after Prefer: wait", async () => {
        const studentWaitFn = (position: SequencePosition, timeoutMs: number) =>
            waitUntilProcessed(pool, STUDENT_PROJECTION_NAME, position, { timeoutMs })

        const deps = { store: eventStore, pool }
        const app = getApplication({
            apis: [
                configureRegisterStudentRoute(deps),
                configureStudentDetailsRoute({ ...deps, waitFn: studentWaitFn })
            ]
        })

        const agent = supertest(app)

        await agent.post("/students").send({ id: "s1", name: "Alice" })

        const getRes = await agent.get("/students/s1").set("Prefer", "wait=5").set("If-None-Match", '"1"')

        expect(getRes.status).toBe(200)
        expect(getRes.body).toMatchObject({
            id: "s1",
            name: "Alice",
            studentNumber: 1,
            subscribedCourses: []
        })
        expect(getRes.headers["etag"]).toBe('"1"')
    })
})
