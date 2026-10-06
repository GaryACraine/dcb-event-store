import { Pool } from "pg"
import { getTestPgDatabasePool } from "@test/testPgDbPool"
import { collectUncaught, waitFor } from "@test/waitFor"
import { LockHolder } from "./lockHolder.js"

const checkedOut = (pool: Pool) => pool.totalCount - pool.idleCount

// The backends holding a processor lock in this test's database.
const lockHolders = async (pool: Pool): Promise<number[]> =>
    (
        await pool.query(
            `SELECT DISTINCT pid FROM pg_locks
              WHERE locktype = 'advisory' AND granted AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`
        )
    ).rows.map(r => r.pid)

describe("LockHolder (phase 20)", () => {
    let pool: Pool

    beforeEach(async () => {
        pool = await getTestPgDatabasePool({ max: 5 })
    })

    afterEach(async () => {
        await pool.end()
    })

    test("holds many processors' locks on one connection", async () => {
        const holder = new LockHolder(pool)
        const locks = await Promise.all(["a", "b", "c", "d", "e", "f"].map(name => holder.acquire(name)))
        expect(locks.every(l => l !== null)).toBe(true)
        expect(await lockHolders(pool)).toHaveLength(1)
        expect(checkedOut(pool)).toBe(1)

        await Promise.all(locks.map(l => l!.release()))
        expect(await lockHolders(pool)).toHaveLength(0)
        expect(checkedOut(pool)).toBe(0)
    })

    test("refuses a name it already holds (advisory locks are re-entrant within a session), and so does another holder", async () => {
        const holder = new LockHolder(pool)
        const first = await holder.acquire("same")
        expect(first).not.toBeNull()
        expect(await holder.acquire("same")).toBeNull()
        expect(await new LockHolder(pool).acquire("same")).toBeNull()

        await first!.release()
        const again = await new LockHolder(pool).acquire("same")
        expect(again).not.toBeNull()
        await again!.release()
    })

    test("a lost connection: every lock's `lost` aborts, nothing is thrown, and the locks are free", async () => {
        const uncaught = collectUncaught()
        const holder = new LockHolder(pool)
        const locks = (await Promise.all(["x", "y", "z"].map(name => holder.acquire(name)))).map(l => l!)
        const [pid] = await lockHolders(pool)

        await pool.query("SELECT pg_terminate_backend($1)", [pid])
        await waitFor("every lock to be lost", () => locks.every(l => l.lost.aborted))
        await waitFor("the session's locks to go", async () => (await lockHolders(pool)).length === 0)

        // Another instance can take them; this holder, on a new connection, can too once they're free.
        const other = await new LockHolder(pool).acquire("x")
        expect(other).not.toBeNull()
        const retaken = await holder.acquire("y")
        expect(retaken).not.toBeNull()
        expect(retaken!.lost.aborted).toBe(false)

        await Promise.all(locks.map(l => l.release())) // no-ops: their session is gone
        await other!.release()
        await retaken!.release()
        uncaught.stop()
        expect(uncaught.errors).toEqual([])
        await waitFor("every connection back in the pool", () => checkedOut(pool) === 0)
    })
})
