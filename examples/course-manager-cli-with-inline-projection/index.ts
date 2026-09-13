import { Pool } from "pg"
import "source-map-support/register"
import { startCli } from "./src/Cli.js"
import { Api } from "./src/api/Api.js"
import { PostgresEventStore } from "@dcb-es/event-store-postgres"
import { courseSubscriptionsProjection } from "./src/api/PostgresCourseSubscriptionsProjection.js"
;(async () => {
    const postgresConfig = {
        host: "localhost",
        port: 5432,
        user: "postgres",
        password: "postgres",
        database: "dcb_test_1"
    }

    const pool = new Pool(postgresConfig)

    // The projection runs inline — inside each append transaction.
    // No consumer, no waitUntilProcessed, no bookmark table needed.
    const eventStore = new PostgresEventStore({
        pool,
        inlineProjections: [courseSubscriptionsProjection]
    })
    await eventStore.ensureInstalled()

    // Init Pongo collection tables eagerly (projection.init creates them)
    const initClient = await pool.connect()
    try {
        await courseSubscriptionsProjection.init!(initClient)
    } finally {
        initClient.release()
    }

    const api = new Api(pool, eventStore)
    await startCli(api)

    await pool.end()
})()
