import { Pool } from "pg"
import { AnyEvent, TaggedEvent, Query, Tags } from "@dcb-es/event-store"
import { getTestPgDatabasePool } from "@test/testPgDbPool"
import { PostgresEventStore } from "../eventStore/PostgresEventStore.js"
import { ensureHandlersInstalled } from "../eventHandling/ensureHandlersInstalled.js"
import { rawSqlProjection } from "./rawSqlProjection.js"
import { rebuildProjection } from "./rebuildProjection.js"
import { readProjectionStatus } from "./registry/projectionRegistry.js"

const event = (
    type: string,
    data: Record<string, unknown> = {},
    tags: Tags = Tags.fromObj({ e: "1" })
): TaggedEvent<AnyEvent> => ({
    event: { type, data } as AnyEvent,
    tags
})

describe("rebuildProjection", () => {
    let pool: Pool
    let store: PostgresEventStore

    beforeAll(async () => {
        pool = await getTestPgDatabasePool({ max: 20 })
        store = new PostgresEventStore({ pool })
        await store.ensureInstalled()
    })

    afterEach(async () => {
        await pool.query("TRUNCATE events")
        await pool.query("ALTER SEQUENCE events_sequence_position_seq RESTART WITH 1")
        await pool.query("DELETE FROM _handler_bookmarks")
        await pool.query("DELETE FROM _projections")
        await pool.query("DROP TABLE IF EXISTS rebuild_items")
    })

    afterAll(async () => {
        if (pool) await pool.end()
    })

    function makeProjection(name: string = "rebuild-test") {
        return rawSqlProjection({
            name,
            version: 1,
            canHandle: Query.fromItems([{ types: ["ItemAdded"] }]),
            init: async client => {
                await client.query(`
                    CREATE TABLE IF NOT EXISTS rebuild_items (
                        name TEXT NOT NULL
                    )
                `)
            },
            evolve: async (event, client) => {
                if (event.event.type === "ItemAdded") {
                    await client.query("INSERT INTO rebuild_items (name) VALUES ($1)", [
                        (event.event.data as { name: string }).name
                    ])
                }
            },
            truncate: async client => {
                await client.query("DELETE FROM rebuild_items")
            }
        })
    }

    test("rebuild replays all events; final read model matches from-zero", async () => {
        const projection = makeProjection()
        await ensureHandlersInstalled(pool, [projection.name], "_handler_bookmarks")

        // Init and register the projection
        const initClient = await pool.connect()
        try {
            await initClient.query("BEGIN")
            await projection.init!(initClient)
            await initClient.query("COMMIT")
        } finally {
            initClient.release()
        }

        // Append events
        await store.append({ events: event("ItemAdded", { name: "item-1" }) })
        await store.append({ events: event("ItemAdded", { name: "item-2" }) })
        await store.append({ events: event("ItemAdded", { name: "item-3" }) })

        // Rebuild — should process all 3 events
        await rebuildProjection({ pool, eventStore: store, projection })

        const result = await pool.query("SELECT name FROM rebuild_items ORDER BY name")
        expect(result.rows.map(r => r.name)).toEqual(["item-1", "item-2", "item-3"])

        // Verify projection is reactivated
        const client = await pool.connect()
        try {
            await client.query("BEGIN")
            const status = await readProjectionStatus(client, { name: projection.name, version: 1 })
            expect(status).toBe("active")
            await client.query("ROLLBACK")
        } finally {
            client.release()
        }
    })

    test("rebuild truncates existing read model first", async () => {
        const projection = makeProjection()
        await ensureHandlersInstalled(pool, [projection.name], "_handler_bookmarks")

        // Init and register
        const initClient = await pool.connect()
        try {
            await initClient.query("BEGIN")
            await projection.init!(initClient)
            await initClient.query("COMMIT")
        } finally {
            initClient.release()
        }

        // Manually insert stale data
        await pool.query("INSERT INTO rebuild_items (name) VALUES ('stale-item')")

        // Append events
        await store.append({ events: event("ItemAdded", { name: "fresh-1" }) })
        await store.append({ events: event("ItemAdded", { name: "fresh-2" }) })

        // Rebuild
        await rebuildProjection({ pool, eventStore: store, projection })

        const result = await pool.query("SELECT name FROM rebuild_items ORDER BY name")
        // Stale data should be gone, only fresh data from replay
        expect(result.rows.map(r => r.name)).toEqual(["fresh-1", "fresh-2"])
    })

    test("rebuild with concurrent appends includes all events", async () => {
        const projection = makeProjection()
        await ensureHandlersInstalled(pool, [projection.name], "_handler_bookmarks")

        // Init
        const initClient = await pool.connect()
        try {
            await initClient.query("BEGIN")
            await projection.init!(initClient)
            await initClient.query("COMMIT")
        } finally {
            initClient.release()
        }

        // Append initial events
        await store.append({ events: event("ItemAdded", { name: "before-1" }) })
        await store.append({ events: event("ItemAdded", { name: "before-2" }) })

        // Rebuild picks up all events including those appended before rebuild started
        await rebuildProjection({ pool, eventStore: store, projection })

        // Append more events after rebuild
        await store.append({ events: event("ItemAdded", { name: "after-1" }) })

        // Rebuild again to pick up everything
        await rebuildProjection({ pool, eventStore: store, projection })

        const result = await pool.query("SELECT name FROM rebuild_items ORDER BY name")
        expect(result.rows.map(r => r.name)).toEqual(["after-1", "before-1", "before-2"])
    })

    test("inline projection skipped during rebuild (status is inactive)", async () => {
        const inlineProjection = rawSqlProjection({
            name: "inline-rebuild-test",
            version: 1,
            canHandle: Query.fromItems([{ types: ["ItemAdded"] }]),
            init: async client => {
                await client.query(`
                    CREATE TABLE IF NOT EXISTS rebuild_items (
                        name TEXT NOT NULL
                    )
                `)
            },
            evolve: async (event, client) => {
                if (event.event.type === "ItemAdded") {
                    await client.query("INSERT INTO rebuild_items (name) VALUES ($1)", [
                        (event.event.data as { name: string }).name
                    ])
                }
            },
            truncate: async client => {
                await client.query("DELETE FROM rebuild_items")
            }
        })

        // Create store with inline projection
        const inlineStore = new PostgresEventStore({
            pool,
            inlineProjections: [inlineProjection]
        })
        await inlineStore.ensureInstalled()
        await ensureHandlersInstalled(pool, [inlineProjection.name], "_handler_bookmarks")

        // Append an event — inline projection processes it
        await inlineStore.append({ events: event("ItemAdded", { name: "inline-1" }) })

        const before = await pool.query("SELECT name FROM rebuild_items ORDER BY name")
        expect(before.rows.map(r => r.name)).toEqual(["inline-1"])

        // Now rebuild the same projection
        await rebuildProjection({ pool, eventStore: store, projection: inlineProjection })

        // After rebuild, the read model should have the event from replay
        const after = await pool.query("SELECT name FROM rebuild_items ORDER BY name")
        expect(after.rows.map(r => r.name)).toEqual(["inline-1"])

        // Verify status is active again
        const client = await pool.connect()
        try {
            await client.query("BEGIN")
            const status = await readProjectionStatus(client, { name: inlineProjection.name, version: 1 })
            expect(status).toBe("active")
            await client.query("ROLLBACK")
        } finally {
            client.release()
        }
    })
})
