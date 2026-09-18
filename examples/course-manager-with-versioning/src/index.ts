import { Pool } from "pg"
import {
    PostgresEventStore,
    createConsumer,
    projectionToProcessor,
    ensureHandlersInstalled,
    waitUntilProcessed
} from "@dcb-es/event-store-postgres"
import { getApplication, startAPI } from "@dcb-es/event-store-express"
import type { SequencePosition } from "@dcb-es/event-store"

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

const connectionString = process.env["PG_CONNECTION_STRING"]
if (!connectionString) {
    console.error("PG_CONNECTION_STRING environment variable is required")
    process.exit(1)
}

const port = parseInt(process.env["PORT"] ?? "3000", 10)

const pool = new Pool({ connectionString, max: 20 })
const eventStore = new PostgresEventStore({ pool })

await eventStore.ensureInstalled()

const initClient = await pool.connect()
try {
    await courseDetailsProjection.init!(initClient)
    await studentDetailsProjection.init!(initClient)
} finally {
    initClient.release()
}

await ensureHandlersInstalled(pool, [COURSE_PROJECTION_NAME, STUDENT_PROJECTION_NAME], "_handler_bookmarks")

const consumer = createConsumer({
    pool,
    eventStore,
    processors: [
        projectionToProcessor(courseDetailsProjection, {
            batchSize: 100,
            startFrom: "BEGINNING"
        }),
        projectionToProcessor(studentDetailsProjection, {
            batchSize: 100,
            startFrom: "BEGINNING"
        })
    ]
})

// Per-projection waitFn instances
const courseWaitFn = (position: SequencePosition, timeoutMs: number) =>
    waitUntilProcessed(pool, COURSE_PROJECTION_NAME, position, { timeoutMs })

const studentWaitFn = (position: SequencePosition, timeoutMs: number) =>
    waitUntilProcessed(pool, STUDENT_PROJECTION_NAME, position, { timeoutMs })

const deps = { store: eventStore, pool }

const app = getApplication({
    apis: [
        // Write slices
        configureRegisterCourseRoute(deps),
        configureRegisterStudentRoute(deps),
        configureSubscribeStudentRoute(deps),
        configureUnsubscribeStudentRoute(deps),
        configureChangeCourseCapacityRoute(deps),
        // Read slices — each with its own waitFn
        configureCourseDetailsRoute({ ...deps, waitFn: courseWaitFn }),
        configureCourseListRoute({ ...deps, waitFn: courseWaitFn }),
        configureStudentDetailsRoute({ ...deps, waitFn: studentWaitFn }),
        // Infrastructure slices
        configureEventFeedRoute(eventStore),
        configureOpenApiRoute()
    ]
})

const server = startAPI(app, { port })

server.on("listening", () => {
    const addr = server.address() as { port: number }
    console.log(`course-manager-with-versioning listening on http://localhost:${addr.port}`)
    console.log(`  GET  http://localhost:${addr.port}/health/live`)
    console.log(`  GET  http://localhost:${addr.port}/courses`)
    console.log(`  GET  http://localhost:${addr.port}/events   (SSE)`)
})

const shutdown = async () => {
    console.log("Shutting down…")
    await consumer.stop()
    await pool.end()
}

process.on("SIGTERM", shutdown)
process.on("SIGINT", shutdown)
