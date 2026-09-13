import { Pool } from "pg"
import { getTestPgDatabasePool } from "@test/testPgDbPool"
import { PostgresEventStore } from "../eventStore/PostgresEventStore.js"
import { tryAcquireSharedProjectionLock, acquireExclusiveProjectionLock } from "./projectionLock.js"
import { registerProjection, setProjectionStatus } from "./registry/projectionRegistry.js"

describe("projectionLock", () => {
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

    test("shared lock acquired when no exclusive, isActive = true", async () => {
        // Register projection first
        const setupClient = await pool.connect()
        try {
            await setupClient.query("BEGIN")
            await registerProjection(setupClient, {
                name: "lock-test",
                version: 1,
                type: "a",
                kind: "raw-sql",
                status: "active",
                definition: {}
            })
            await setupClient.query("COMMIT")
        } finally {
            setupClient.release()
        }

        const client = await pool.connect()
        try {
            await client.query("BEGIN")
            const result = await tryAcquireSharedProjectionLock(client, "lock-test", 1)
            expect(result.acquired).toBe(true)
            expect(result.isActive).toBe(true)
            await client.query("ROLLBACK")
        } finally {
            client.release()
        }
    })

    test("shared lock acquired but isActive = false when status is inactive", async () => {
        const setupClient = await pool.connect()
        try {
            await setupClient.query("BEGIN")
            await registerProjection(setupClient, {
                name: "inactive-test",
                version: 1,
                type: "a",
                kind: "raw-sql",
                status: "active",
                definition: {}
            })
            await setProjectionStatus(setupClient, { name: "inactive-test", version: 1, status: "inactive" })
            await setupClient.query("COMMIT")
        } finally {
            setupClient.release()
        }

        const client = await pool.connect()
        try {
            await client.query("BEGIN")
            const result = await tryAcquireSharedProjectionLock(client, "inactive-test", 1)
            expect(result.acquired).toBe(true)
            expect(result.isActive).toBe(false)
            await client.query("ROLLBACK")
        } finally {
            client.release()
        }
    })

    test("shared lock fails when exclusive held by another transaction", async () => {
        const setupClient = await pool.connect()
        try {
            await setupClient.query("BEGIN")
            await registerProjection(setupClient, {
                name: "excl-test",
                version: 1,
                type: "a",
                kind: "raw-sql",
                status: "active",
                definition: {}
            })
            await setupClient.query("COMMIT")
        } finally {
            setupClient.release()
        }

        // Hold exclusive lock in one transaction
        const holder = await pool.connect()
        try {
            await holder.query("BEGIN")
            await acquireExclusiveProjectionLock(holder, "excl-test", 1)

            // Try shared lock in another transaction — should fail
            const client = await pool.connect()
            try {
                await client.query("BEGIN")
                const result = await tryAcquireSharedProjectionLock(client, "excl-test", 1)
                expect(result.acquired).toBe(false)
                await client.query("ROLLBACK")
            } finally {
                client.release()
            }

            await holder.query("ROLLBACK")
        } finally {
            holder.release()
        }
    })

    test("multiple shared locks succeed concurrently", async () => {
        const setupClient = await pool.connect()
        try {
            await setupClient.query("BEGIN")
            await registerProjection(setupClient, {
                name: "multi-shared",
                version: 1,
                type: "a",
                kind: "raw-sql",
                status: "active",
                definition: {}
            })
            await setupClient.query("COMMIT")
        } finally {
            setupClient.release()
        }

        const client1 = await pool.connect()
        const client2 = await pool.connect()
        try {
            await client1.query("BEGIN")
            await client2.query("BEGIN")

            const result1 = await tryAcquireSharedProjectionLock(client1, "multi-shared", 1)
            const result2 = await tryAcquireSharedProjectionLock(client2, "multi-shared", 1)

            expect(result1.acquired).toBe(true)
            expect(result2.acquired).toBe(true)

            await client1.query("ROLLBACK")
            await client2.query("ROLLBACK")
        } finally {
            client1.release()
            client2.release()
        }
    })

    test("unregistered projection is treated as active", async () => {
        const client = await pool.connect()
        try {
            await client.query("BEGIN")
            const result = await tryAcquireSharedProjectionLock(client, "nonexistent-proj", 1)
            expect(result.acquired).toBe(true)
            expect(result.isActive).toBe(true)
            await client.query("ROLLBACK")
        } finally {
            client.release()
        }
    })

    test("exclusive lock blocks until shared released", async () => {
        const setupClient = await pool.connect()
        try {
            await setupClient.query("BEGIN")
            await registerProjection(setupClient, {
                name: "block-test",
                version: 1,
                type: "a",
                kind: "raw-sql",
                status: "active",
                definition: {}
            })
            await setupClient.query("COMMIT")
        } finally {
            setupClient.release()
        }

        // Hold shared lock
        const sharedHolder = await pool.connect()
        await sharedHolder.query("BEGIN")
        const sharedResult = await tryAcquireSharedProjectionLock(sharedHolder, "block-test", 1)
        expect(sharedResult.acquired).toBe(true)

        // Try exclusive lock with a timeout
        const exclusiveClient = await pool.connect()
        await exclusiveClient.query("BEGIN")
        // Set a statement timeout to prevent infinite blocking
        await exclusiveClient.query("SET LOCAL statement_timeout = '200ms'")

        let exclusiveAcquired = false
        try {
            await acquireExclusiveProjectionLock(exclusiveClient, "block-test", 1)
            exclusiveAcquired = true
        } catch {
            // Expected: timeout because shared lock is held
        }
        expect(exclusiveAcquired).toBe(false)

        await exclusiveClient.query("ROLLBACK").catch(() => {})
        exclusiveClient.release()

        // Release shared lock
        await sharedHolder.query("ROLLBACK")
        sharedHolder.release()

        // Now exclusive should succeed
        const exclusiveClient2 = await pool.connect()
        try {
            await exclusiveClient2.query("BEGIN")
            await acquireExclusiveProjectionLock(exclusiveClient2, "block-test", 1)
            // If we get here, lock was acquired
            await exclusiveClient2.query("ROLLBACK")
        } finally {
            exclusiveClient2.release()
        }
    })
})
