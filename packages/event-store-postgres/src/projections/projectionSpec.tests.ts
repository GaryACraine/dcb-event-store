import { Pool } from "pg"
import { DcbEvent, Query, Tags } from "@dcb-es/event-store"
import { getTestPgDatabasePool } from "@test/testPgDbPool"
import { rawSqlProjection } from "./rawSqlProjection.js"
import { ProjectionSpec } from "./projectionSpec.js"

const event = (type: string, data: Record<string, unknown> = {}, tags: Tags = Tags.fromObj({ e: "1" })): DcbEvent => ({
    type,
    tags,
    data,
    metadata: {}
})

const counterProjection = rawSqlProjection({
    name: "spec-test-counter",
    canHandle: Query.fromItems([{ types: ["Incremented", "Decremented"] }]),
    init: async client => {
        await client.query(`
            CREATE TABLE IF NOT EXISTS spec_counter (
                id TEXT PRIMARY KEY DEFAULT 'global',
                value INTEGER NOT NULL DEFAULT 0
            )
        `)
        await client.query(`
            INSERT INTO spec_counter (id, value) VALUES ('global', 0)
            ON CONFLICT DO NOTHING
        `)
    },
    evolve: async (event, client) => {
        if (event.event.type === "Incremented") {
            await client.query("UPDATE spec_counter SET value = value + 1 WHERE id = 'global'")
        } else if (event.event.type === "Decremented") {
            await client.query("UPDATE spec_counter SET value = value - 1 WHERE id = 'global'")
        }
    },
    truncate: async client => {
        await client.query("DROP TABLE IF EXISTS spec_counter")
    }
})

describe("ProjectionSpec", () => {
    let pool: Pool

    beforeAll(async () => {
        pool = await getTestPgDatabasePool({ max: 10 })
    })

    afterAll(async () => {
        if (pool) await pool.end()
    })

    test("given/when/then flow works and assertions pass", async () => {
        await ProjectionSpec.for({ projection: counterProjection, pool })
            .given([event("Incremented"), event("Incremented"), event("Incremented")])
            .when([event("Decremented")])
            .then(async client => {
                const result = await client.query("SELECT value FROM spec_counter WHERE id = 'global'")
                expect(result.rows[0].value).toBe(2)
            })
    })

    test("DB changes are rolled back after assertion", async () => {
        // Run a spec that creates a table and inserts data
        await ProjectionSpec.for({ projection: counterProjection, pool })
            .given([event("Incremented")])
            .when([event("Incremented")])
            .then(async client => {
                const result = await client.query("SELECT value FROM spec_counter WHERE id = 'global'")
                expect(result.rows[0].value).toBe(2)
            })

        // After the spec, the table should not exist (rolled back)
        const tableCheck = await pool.query(`
            SELECT EXISTS (
                SELECT FROM information_schema.tables
                WHERE table_name = 'spec_counter'
            ) as exists
        `)
        expect(tableCheck.rows[0].exists).toBe(false)
    })

    test("multiple spec runs do not interfere", async () => {
        const spec = ProjectionSpec.for({ projection: counterProjection, pool })

        await spec
            .given([event("Incremented")])
            .when([event("Incremented")])
            .then(async client => {
                const result = await client.query("SELECT value FROM spec_counter WHERE id = 'global'")
                expect(result.rows[0].value).toBe(2)
            })

        // Second run starts fresh
        await spec
            .given([])
            .when([event("Incremented")])
            .then(async client => {
                const result = await client.query("SELECT value FROM spec_counter WHERE id = 'global'")
                expect(result.rows[0].value).toBe(1)
            })
    })

    test("assertion failures propagate as test failures", async () => {
        await expect(
            ProjectionSpec.for({ projection: counterProjection, pool })
                .given([])
                .when([event("Incremented")])
                .then(async client => {
                    const result = await client.query("SELECT value FROM spec_counter WHERE id = 'global'")
                    expect(result.rows[0].value).toBe(999)
                })
        ).rejects.toThrow()
    })

    test("init is called before given events", async () => {
        await ProjectionSpec.for({ projection: counterProjection, pool })
            .given([event("Incremented")])
            .when([])
            .then(async client => {
                // init created the table and inserted the default row
                // given event incremented it to 1
                const result = await client.query("SELECT value FROM spec_counter WHERE id = 'global'")
                expect(result.rows[0].value).toBe(1)
            })
    })

    test("events not matching canHandle are filtered out", async () => {
        await ProjectionSpec.for({ projection: counterProjection, pool })
            .given([event("Incremented"), event("UnrelatedEvent"), event("Incremented")])
            .when([event("AnotherUnrelated")])
            .then(async client => {
                // Only the two Incremented events should have been processed
                const result = await client.query("SELECT value FROM spec_counter WHERE id = 'global'")
                expect(result.rows[0].value).toBe(2)
            })
    })

    test("works with empty given and empty when", async () => {
        await ProjectionSpec.for({ projection: counterProjection, pool })
            .given([])
            .when([])
            .then(async client => {
                const result = await client.query("SELECT value FROM spec_counter WHERE id = 'global'")
                expect(result.rows[0].value).toBe(0)
            })
    })
})
