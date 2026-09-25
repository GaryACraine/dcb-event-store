import { Pool } from "pg"
import {
    PostgresEventStore,
    createConsumer,
    projectionToProcessor,
    ensureHandlersInstalled,
    waitUntilProcessed
} from "@dcb-es/event-store-postgres"
import { getApplication, onShutdown, startAPI, stopAPI } from "@dcb-es/event-store-express"
import { configureRoutes } from "./api/routes.js"
import { courseSubscriptionsProjection, PROJECTION_NAME } from "./api/PostgresCourseSubscriptionsProjection.js"

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
    await courseSubscriptionsProjection.init!(initClient)
} finally {
    initClient.release()
}

await ensureHandlersInstalled(pool, [PROJECTION_NAME], "_handler_bookmarks")

const consumer = createConsumer({
    pool,
    eventStore,
    processors: [
        projectionToProcessor(courseSubscriptionsProjection, {
            batchSize: 100,
            startFrom: "BEGINNING"
        })
    ]
})

const waitFn = (position: import("@dcb-es/event-store").SequencePosition, timeoutMs: number) =>
    waitUntilProcessed(pool, PROJECTION_NAME, position, { timeoutMs })

const app = getApplication({
    apis: [configureRoutes({ store: eventStore, pool, waitFn })]
})

const server = startAPI(app, { port })

server.on("listening", () => {
    const addr = server.address() as { port: number }
    console.log(`course-manager-postgres-web-api listening on http://localhost:${addr.port}`)
    console.log(`  GET  http://localhost:${addr.port}/health/live`)
    console.log(`  GET  http://localhost:${addr.port}/courses`)
    console.log(`  GET  http://localhost:${addr.port}/events   (SSE)`)
})

// Once, whatever signals arrive: stop taking requests (ending the SSE feeds), stop the consumer, end the pool.
onShutdown(async () => {
    console.log("Shutting down…")
    await stopAPI(server)
    await consumer.stop()
    await pool.end()
})
