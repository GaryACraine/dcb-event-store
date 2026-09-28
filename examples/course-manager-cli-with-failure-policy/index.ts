import { Pool } from "pg"
import { startCli } from "./src/Cli.js"
import { installPostgresCourseSubscriptionsRepository } from "./src/postgresCourseSubscriptionRepository/PostgresCourseSubscriptionRespository.js"
import { Api, PROJECTION_NAME } from "./src/api/Api.js"
import { PostgresEventStore, createConsumer, ensureHandlersInstalled } from "@dcb-es/event-store-postgres"
import { PostgresCourseSubscriptionsProjection } from "./src/api/PostgresCourseSubscriptionsProjection.js"
import { AUDIT_LOG_NAME, CourseAuditLog, installCourseAuditLog } from "./src/api/CourseAuditLog.js"
;(async () => {
    const postgresConfig = {
        host: "localhost",
        port: 5432,
        user: "postgres",
        password: "postgres",
        database: "dcb_test_1"
    }

    const pool = new Pool(postgresConfig)
    const eventStore = new PostgresEventStore({ pool })
    await eventStore.ensureInstalled()
    await ensureHandlersInstalled(pool, [PROJECTION_NAME, AUDIT_LOG_NAME], "_handler_bookmarks")
    await installPostgresCourseSubscriptionsRepository(pool)
    await installCourseAuditLog(pool)

    const consumer = createConsumer({
        pool,
        eventStore,
        processors: [
            {
                // The read model the commands wait on. A handler error blocks it and retries the same event (the
                // default, onError: "retry"), waiting 1 s, then 2, 4… up to 30 s. Nothing is lost.
                processorName: PROJECTION_NAME,
                handlerFactory: client => PostgresCourseSubscriptionsProjection(client),
                batchSize: 100,
                startFrom: "BEGINNING",
                backoff: { initialMs: 1000, maxMs: 30_000 }
            },
            {
                // An audit log where a lost line is acceptable: an error is logged and the event skipped.
                processorName: AUDIT_LOG_NAME,
                handlerFactory: client => CourseAuditLog(client),
                startFrom: "BEGINNING",
                onError: "skip"
            }
        ]
    })

    // A processor never dies: a blocked one says so. Report it rather than exiting.
    const monitor = setInterval(() => {
        for (const status of consumer.status()) {
            if (status.blocked) {
                console.warn(
                    `${status.processorName} is blocked on event ${status.blocked.position.toString()} ` +
                        `(${status.blocked.eventType}) since ${status.blocked.since.toISOString()}: ${status.blocked.error}`
                )
            }
        }
    }, 10_000)

    const api = new Api(pool, eventStore)
    await startCli(api)

    // Graceful shutdown via consumer.stop()
    clearInterval(monitor)
    await consumer.stop()
    await pool.end()
})()
