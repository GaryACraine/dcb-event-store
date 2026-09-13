import { Pool } from "pg"
import { getTestPgDatabasePool } from "@test/testPgDbPool"
import { acquireProcessorLock } from "./processorLock.js"
import { processorLockKey, leafKey, typeIntentKey, GLOBAL_INTENT_KEY } from "../eventStore/advisoryLocks.js"

describe("processorLock", () => {
    let pool: Pool

    beforeAll(async () => {
        pool = await getTestPgDatabasePool({ max: 10 })
    })

    afterAll(async () => {
        if (pool) await pool.end()
    })

    test("single processor acquires lock successfully", async () => {
        const handle = await acquireProcessorLock(pool, "my-projection")
        expect(handle.acquired).toBe(true)
        await handle.release()
    })

    test("two concurrent acquirers: second fails while first holds lock", async () => {
        const first = await acquireProcessorLock(pool, "exclusive-test")
        expect(first.acquired).toBe(true)

        const second = await acquireProcessorLock(pool, "exclusive-test")
        expect(second.acquired).toBe(false)

        await first.release()
        await second.release()
    })

    test("after first releases, second can acquire", async () => {
        const first = await acquireProcessorLock(pool, "release-test")
        expect(first.acquired).toBe(true)
        await first.release()

        const second = await acquireProcessorLock(pool, "release-test")
        expect(second.acquired).toBe(true)
        await second.release()
    })

    test("lock key uses P: namespace (distinct from L:, T:, G boundary keys)", () => {
        const pKey = processorLockKey("test-handler")
        const lKey = leafKey("testEvent", "tag:value")
        const tKey = typeIntentKey("testEvent")

        expect(pKey).not.toBe(lKey)
        expect(pKey).not.toBe(tKey)
        expect(pKey).not.toBe(GLOBAL_INTENT_KEY)
    })

    test("processorLockKey produces consistent keys for same input", () => {
        const key1 = processorLockKey("same-name")
        const key2 = processorLockKey("same-name")
        expect(key1).toBe(key2)
    })

    test("processorLockKey produces different keys for different inputs", () => {
        const key1 = processorLockKey("handler-a")
        const key2 = processorLockKey("handler-b")
        expect(key1).not.toBe(key2)
    })

    test("lock is session-scoped: releasing client releases lock", async () => {
        // Acquire lock, then release the handle (which releases the client)
        const first = await acquireProcessorLock(pool, "session-scope-test")
        expect(first.acquired).toBe(true)

        // Release the lock handle (releases advisory lock + client)
        await first.release()

        // Another acquirer should succeed now — the lock was released with the session
        const second = await acquireProcessorLock(pool, "session-scope-test")
        expect(second.acquired).toBe(true)
        await second.release()
    })

    test("acquired handle's release() is idempotent", async () => {
        const handle = await acquireProcessorLock(pool, "idempotent-release")
        expect(handle.acquired).toBe(true)

        await handle.release()
        // Second release should not throw
        await handle.release()

        // Lock should be free
        const second = await acquireProcessorLock(pool, "idempotent-release")
        expect(second.acquired).toBe(true)
        await second.release()
    })
})
