import { Pool } from "pg"
import { SequencePosition } from "@dcb-es/event-store"
import { getTestPgDatabasePool } from "@test/testPgDbPool"
import { ensureHandlersInstalled } from "./ensureHandlersInstalled.js"
import { readCheckpoint, storeCheckpoint } from "./checkpointer.js"

describe("checkpointer", () => {
    let pool: Pool
    const TABLE = "_handler_bookmarks"
    const HANDLER = "CheckpointTestHandler"

    beforeAll(async () => {
        pool = await getTestPgDatabasePool({ max: 10 })
        await ensureHandlersInstalled(pool, [HANDLER], TABLE)
    })

    afterEach(async () => {
        // Reset to initial state
        await pool.query(
            `UPDATE ${TABLE} SET last_sequence_position = 0, version = 1, instance_id = NULL, last_updated = now() WHERE handler_id = $1`,
            [HANDLER]
        )
    })

    afterAll(async () => {
        if (pool) await pool.end()
    })

    test("read returns initial position (0) and version (1) for fresh handler", async () => {
        const checkpoint = await readCheckpoint(pool, HANDLER, TABLE)
        expect(checkpoint.position.equals(SequencePosition.initial())).toBe(true)
        expect(checkpoint.version).toBe(1n)
    })

    test("store succeeds and increments version", async () => {
        const result = await storeCheckpoint(pool, HANDLER, TABLE, SequencePosition.fromString("5"), 1n, "instance-1")
        expect(result).toBe("SUCCESS")

        const checkpoint = await readCheckpoint(pool, HANDLER, TABLE)
        expect(checkpoint.position.equals(SequencePosition.fromString("5"))).toBe(true)
        expect(checkpoint.version).toBe(2n)
    })

    test("store fails on version mismatch (returns VERSION_MISMATCH)", async () => {
        // Store once to advance to version 2
        await storeCheckpoint(pool, HANDLER, TABLE, SequencePosition.fromString("3"), 1n, "instance-1")

        // Try to store with stale version 1
        const result = await storeCheckpoint(pool, HANDLER, TABLE, SequencePosition.fromString("10"), 1n, "instance-2")
        expect(result).toBe("VERSION_MISMATCH")

        // Position should not have changed
        const checkpoint = await readCheckpoint(pool, HANDLER, TABLE)
        expect(checkpoint.position.equals(SequencePosition.fromString("3"))).toBe(true)
    })

    test("store updates instance_id and last_updated", async () => {
        await storeCheckpoint(pool, HANDLER, TABLE, SequencePosition.fromString("1"), 1n, "my-instance")

        const result = await pool.query(`SELECT instance_id, last_updated FROM ${TABLE} WHERE handler_id = $1`, [
            HANDLER
        ])
        expect(result.rows[0].instance_id).toBe("my-instance")
        expect(result.rows[0].last_updated).toBeInstanceOf(Date)
    })

    test("sequential stores increment version correctly (1 → 2 → 3)", async () => {
        let r = await storeCheckpoint(pool, HANDLER, TABLE, SequencePosition.fromString("1"), 1n, "i")
        expect(r).toBe("SUCCESS")

        r = await storeCheckpoint(pool, HANDLER, TABLE, SequencePosition.fromString("2"), 2n, "i")
        expect(r).toBe("SUCCESS")

        const checkpoint = await readCheckpoint(pool, HANDLER, TABLE)
        expect(checkpoint.version).toBe(3n)
        expect(checkpoint.position.equals(SequencePosition.fromString("2"))).toBe(true)
    })

    test("store with PoolClient (inside transaction) works correctly", async () => {
        const client = await pool.connect()
        try {
            await client.query("BEGIN")
            const result = await storeCheckpoint(
                client,
                HANDLER,
                TABLE,
                SequencePosition.fromString("7"),
                1n,
                "txn-instance"
            )
            expect(result).toBe("SUCCESS")
            await client.query("COMMIT")
        } finally {
            client.release()
        }

        const checkpoint = await readCheckpoint(pool, HANDLER, TABLE)
        expect(checkpoint.position.equals(SequencePosition.fromString("7"))).toBe(true)
    })

    test("store fires pg_notify on the bookmark table channel", async () => {
        const notifications: string[] = []
        const listener = await pool.connect()
        await listener.query(`LISTEN ${TABLE}`)
        listener.on("notification", msg => {
            if (msg.payload) notifications.push(msg.payload)
        })

        await storeCheckpoint(pool, HANDLER, TABLE, SequencePosition.fromString("4"), 1n, "notify-instance")

        // Give notification time to arrive
        await new Promise(r => setTimeout(r, 50))

        await listener.query(`UNLISTEN ${TABLE}`)
        listener.release()

        expect(notifications.length).toBe(1)
        expect(notifications[0]).toBe(`${HANDLER}:4`)
    })
})
