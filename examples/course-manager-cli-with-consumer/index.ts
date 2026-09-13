import { Pool } from "pg"
import "source-map-support/register"
import { startCli } from "./src/Cli.js"
import { installPostgresCourseSubscriptionsRepository } from "./src/postgresCourseSubscriptionRepository/PostgresCourseSubscriptionRespository.js"
import { Api, PROJECTION_NAME } from "./src/api/Api.js"
import { PostgresEventStore, createConsumer, ensureHandlersInstalled } from "@dcb-es/event-store-postgres"
import { PostgresCourseSubscriptionsProjection } from "./src/api/PostgresCourseSubscriptionsProjection.js"
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
    await ensureHandlersInstalled(pool, [PROJECTION_NAME], "_handler_bookmarks")
    await installPostgresCourseSubscriptionsRepository(pool)

    // Start consumer with named processor, configurable batchSize
    const consumer = createConsumer({
        pool,
        eventStore,
        processors: [
            {
                processorName: PROJECTION_NAME,
                handlerFactory: client => PostgresCourseSubscriptionsProjection(client),
                batchSize: 100,
                startFrom: "BEGINNING"
            }
        ]
    })

    // Monitor for errors
    consumer.processors[0].promise.catch(err => {
        console.error("Projection processor error:", err)
        process.exit(1)
    })

    const api = new Api(pool, eventStore)
    await startCli(api)

    // Graceful shutdown via consumer.stop()
    await consumer.stop()
    await pool.end()
})()
