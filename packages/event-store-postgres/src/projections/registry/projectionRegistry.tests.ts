import { Pool } from "pg"
import { getTestPgDatabasePool } from "@test/testPgDbPool"
import { PostgresEventStore } from "../../eventStore/PostgresEventStore.js"
import {
    registerProjection,
    readProjectionStatus,
    setProjectionStatus,
    serializeCanHandle
} from "./projectionRegistry.js"

describe("projectionRegistry", () => {
    let pool: Pool
    let store: PostgresEventStore

    beforeAll(async () => {
        pool = await getTestPgDatabasePool({ max: 10 })
        store = new PostgresEventStore({ pool })
        await store.ensureInstalled()
    })

    afterEach(async () => {
        await pool.query("DELETE FROM _projections")
    })

    afterAll(async () => {
        if (pool) await pool.end()
    })

    test("register inline and async projections, read back status", async () => {
        const client = await pool.connect()
        try {
            await client.query("BEGIN")
            await registerProjection(client, {
                name: "my-inline-proj",
                version: 1,
                type: "i",
                kind: "raw-sql",
                status: "active",
                definition: { items: [{ types: ["EventA"] }] }
            })
            await registerProjection(client, {
                name: "my-async-proj",
                version: 1,
                type: "a",
                kind: "pongo",
                status: "active",
                definition: { items: [{ types: ["EventB"] }] }
            })
            await client.query("COMMIT")
        } finally {
            client.release()
        }

        const verifyClient = await pool.connect()
        try {
            await verifyClient.query("BEGIN")

            const inlineStatus = await readProjectionStatus(verifyClient, { name: "my-inline-proj", version: 1 })
            expect(inlineStatus).toBe("active")

            const asyncStatus = await readProjectionStatus(verifyClient, { name: "my-async-proj", version: 1 })
            expect(asyncStatus).toBe("active")

            // Verify stored data
            const result = await verifyClient.query(
                "SELECT name, version, type, kind, status FROM _projections ORDER BY name"
            )
            expect(result.rows).toEqual([
                { name: "my-async-proj", version: 1, type: "a", kind: "pongo", status: "active" },
                { name: "my-inline-proj", version: 1, type: "i", kind: "raw-sql", status: "active" }
            ])

            await verifyClient.query("ROLLBACK")
        } finally {
            verifyClient.release()
        }
    })

    test("UPSERT updates definition and type on same (name, version)", async () => {
        const client = await pool.connect()
        try {
            await client.query("BEGIN")
            await registerProjection(client, {
                name: "evolving-proj",
                version: 1,
                type: "a",
                kind: "raw-sql",
                status: "active",
                definition: { items: [{ types: ["OldEvent"] }] }
            })
            await client.query("COMMIT")
        } finally {
            client.release()
        }

        // Re-register with different type and definition
        const client2 = await pool.connect()
        try {
            await client2.query("BEGIN")
            await registerProjection(client2, {
                name: "evolving-proj",
                version: 1,
                type: "i",
                kind: "pongo",
                status: "active",
                definition: { items: [{ types: ["NewEvent"] }] }
            })
            await client2.query("COMMIT")
        } finally {
            client2.release()
        }

        const verifyClient = await pool.connect()
        try {
            await verifyClient.query("BEGIN")
            const result = await verifyClient.query(
                "SELECT type, kind, definition FROM _projections WHERE name = $1 AND version = $2",
                ["evolving-proj", 1]
            )
            expect(result.rows[0].type).toBe("i")
            expect(result.rows[0].kind).toBe("pongo")
            expect(result.rows[0].definition).toEqual({ items: [{ types: ["NewEvent"] }] })
            await verifyClient.query("ROLLBACK")
        } finally {
            verifyClient.release()
        }
    })

    test("new version creates separate row", async () => {
        const client = await pool.connect()
        try {
            await client.query("BEGIN")
            await registerProjection(client, {
                name: "versioned-proj",
                version: 1,
                type: "a",
                kind: "raw-sql",
                status: "active",
                definition: { items: [{ types: ["EventA"] }] }
            })
            await registerProjection(client, {
                name: "versioned-proj",
                version: 2,
                type: "a",
                kind: "raw-sql",
                status: "active",
                definition: { items: [{ types: ["EventA", "EventB"] }] }
            })
            await client.query("COMMIT")
        } finally {
            client.release()
        }

        const verifyClient = await pool.connect()
        try {
            await verifyClient.query("BEGIN")
            const result = await verifyClient.query(
                "SELECT version, definition FROM _projections WHERE name = $1 ORDER BY version",
                ["versioned-proj"]
            )
            expect(result.rows).toHaveLength(2)
            expect(result.rows[0].version).toBe(1)
            expect(result.rows[1].version).toBe(2)
            await verifyClient.query("ROLLBACK")
        } finally {
            verifyClient.release()
        }
    })

    test("read non-existent returns null", async () => {
        const client = await pool.connect()
        try {
            await client.query("BEGIN")
            const status = await readProjectionStatus(client, { name: "no-such-proj", version: 1 })
            expect(status).toBeNull()
            await client.query("ROLLBACK")
        } finally {
            client.release()
        }
    })

    test("set status to inactive and back to active", async () => {
        const client = await pool.connect()
        try {
            await client.query("BEGIN")
            await registerProjection(client, {
                name: "status-proj",
                version: 1,
                type: "a",
                kind: "raw-sql",
                status: "active",
                definition: {}
            })
            await client.query("COMMIT")
        } finally {
            client.release()
        }

        const client2 = await pool.connect()
        try {
            await client2.query("BEGIN")
            const result1 = await setProjectionStatus(client2, {
                name: "status-proj",
                version: 1,
                status: "inactive"
            })
            expect(result1.updated).toBe(true)

            const status1 = await readProjectionStatus(client2, { name: "status-proj", version: 1 })
            expect(status1).toBe("inactive")

            const result2 = await setProjectionStatus(client2, {
                name: "status-proj",
                version: 1,
                status: "active"
            })
            expect(result2.updated).toBe(true)

            const status2 = await readProjectionStatus(client2, { name: "status-proj", version: 1 })
            expect(status2).toBe("active")

            await client2.query("COMMIT")
        } finally {
            client2.release()
        }
    })

    test("setProjectionStatus returns false for non-existent projection", async () => {
        const client = await pool.connect()
        try {
            await client.query("BEGIN")
            const result = await setProjectionStatus(client, {
                name: "no-such-proj",
                version: 1,
                status: "inactive"
            })
            expect(result.updated).toBe(false)
            await client.query("ROLLBACK")
        } finally {
            client.release()
        }
    })
})

describe("serializeCanHandle", () => {
    test("serializes empty array", () => {
        expect(serializeCanHandle([])).toEqual({ types: [] })
    })

    test("serializes array of event types", () => {
        expect(serializeCanHandle(["A", "B"])).toEqual({ types: ["A", "B"] })
    })

    test("serializes single event type", () => {
        expect(serializeCanHandle(["OrderPlaced"])).toEqual({ types: ["OrderPlaced"] })
    })
})
