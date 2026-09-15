import { describe, test, beforeAll, afterAll } from "vitest"
import http from "node:http"
import supertest from "supertest"
import type { Pool } from "pg"
import { getApplication } from "@dcb-es/event-store-express"
import {
    PostgresEventStore,
    createConsumer,
    projectionToProcessor,
    ensureHandlersInstalled,
    waitUntilProcessed,
    type RunningConsumer
} from "@dcb-es/event-store-postgres"
import { SequencePosition } from "@dcb-es/event-store"
import { getTestPgDatabasePool } from "@test/testPgDbPool"
import { configureRoutes } from "./api/routes.js"
import { courseSubscriptionsProjection, PROJECTION_NAME } from "./api/PostgresCourseSubscriptionsProjection.js"

// ---------------------------------------------------------------------------
// Scenario: course enrollment lifecycle
// ---------------------------------------------------------------------------
// This test demonstrates the full read-your-writes loop:
//
//   Write → ETag in response → If-None-Match on next read → wait until projected
//
// Each POST/PUT/DELETE returns ETag: "<position>".
// The subsequent GET passes that ETag as If-None-Match + Prefer: wait=5 so
// the server blocks until the projection has caught up, then responds.
// ---------------------------------------------------------------------------

describe("Scenario: course enrollment lifecycle", () => {
    let pool: Pool
    let eventStore: PostgresEventStore
    let consumer: RunningConsumer
    let app: ReturnType<typeof getApplication>

    function makeWaitFn(p: Pool): (position: SequencePosition, timeoutMs: number) => Promise<void> {
        return (position, timeoutMs) => waitUntilProcessed(p, PROJECTION_NAME, position, { timeoutMs })
    }

    function startConsumer(store: PostgresEventStore): RunningConsumer {
        return createConsumer({
            pool,
            eventStore: store,
            processors: [
                projectionToProcessor(courseSubscriptionsProjection, {
                    batchSize: 100,
                    startFrom: "BEGINNING"
                })
            ]
        })
    }

    beforeAll(async () => {
        pool = await getTestPgDatabasePool({ max: 20 })
        eventStore = new PostgresEventStore({ pool })
        await eventStore.ensureInstalled()

        const initClient = await pool.connect()
        try {
            await courseSubscriptionsProjection.init!(initClient)
        } finally {
            initClient.release()
        }

        await ensureHandlersInstalled(pool, [PROJECTION_NAME], "_handler_bookmarks")
        consumer = startConsumer(eventStore)

        app = getApplication({
            apis: [configureRoutes({ store: eventStore, pool, waitFn: makeWaitFn(pool) })]
        })
    })

    afterAll(async () => {
        await consumer.stop()
        if (pool) await pool.end()
    })

    test("full course enrollment lifecycle with read-your-writes", async () => {
        const agent = supertest(app)

        // ── Step 1: Register the course ──────────────────────────────────────
        console.log("\n[Step 1] POST /courses — Register 'Introduction to TypeScript' (capacity 2)")
        const step1 = await agent
            .post("/courses")
            .send({ id: "ts101", title: "Introduction to TypeScript", capacity: 2 })
        console.log(`  → ${step1.status}  ETag: ${step1.headers["etag"]}`)
        expect(step1.status).toBe(201)
        expect(step1.headers["etag"]).toBeDefined()
        const courseETag = step1.headers["etag"] as string

        // ── Step 2: Register Alice ────────────────────────────────────────────
        console.log("\n[Step 2] POST /students — Register Alice")
        const step2 = await agent.post("/students").send({ id: "alice", name: "Alice" })
        console.log(`  → ${step2.status}  ETag: ${step2.headers["etag"]}`)
        expect(step2.status).toBe(201)
        const aliceETag = step2.headers["etag"] as string

        // ── Step 3: Register Bob ──────────────────────────────────────────────
        console.log("\n[Step 3] POST /students — Register Bob")
        const step3 = await agent.post("/students").send({ id: "bob", name: "Bob" })
        console.log(`  → ${step3.status}  ETag: ${step3.headers["etag"]}`)
        expect(step3.status).toBe(201)
        const bobETag = step3.headers["etag"] as string

        // ── Step 4: Register Charlie ──────────────────────────────────────────
        console.log("\n[Step 4] POST /students — Register Charlie")
        const step4 = await agent.post("/students").send({ id: "charlie", name: "Charlie" })
        console.log(`  → ${step4.status}  ETag: ${step4.headers["etag"]}`)
        expect(step4.status).toBe(201)
        const charlieETag = step4.headers["etag"] as string

        // Suppress unused variable warnings — we capture these to show the pattern
        void aliceETag
        void bobETag
        void charlieETag

        // ── Step 5: Read course — wait until courseETag is projected ──────────
        // The ETag from step 1 tells us what position the course event landed at.
        // Passing it as If-None-Match asks the server to block until the projection
        // has processed at least that position — the key read-your-writes pattern.
        console.log(`\n[Step 5] GET /courses/ts101  Prefer: wait=5  If-None-Match: ${courseETag}`)
        const step5 = await agent.get("/courses/ts101").set("Prefer", "wait=5").set("If-None-Match", courseETag)
        console.log(`  → ${step5.status}  body: ${JSON.stringify(step5.body)}`)
        expect(step5.status).toBe(200)
        expect(step5.body.subscribedStudents).toHaveLength(0)
        expect(step5.headers["etag"]).toBeDefined()

        // ── Step 6: Subscribe Alice ───────────────────────────────────────────
        console.log("\n[Step 6] POST /courses/ts101/subscriptions — Subscribe Alice")
        const step6 = await agent.post("/courses/ts101/subscriptions").send({ studentId: "alice" })
        console.log(`  → ${step6.status}  ETag: ${step6.headers["etag"]}`)
        expect(step6.status).toBe(201)
        const subETag = step6.headers["etag"] as string

        // ── Step 7: Read course — wait until Alice's subscription is projected ─
        console.log(`\n[Step 7] GET /courses/ts101  Prefer: wait=5  If-None-Match: ${subETag}`)
        const step7 = await agent.get("/courses/ts101").set("Prefer", "wait=5").set("If-None-Match", subETag)
        console.log(`  → ${step7.status}  body: ${JSON.stringify(step7.body)}`)
        expect(step7.status).toBe(200)
        expect(step7.body.subscribedStudents).toHaveLength(1)
        expect(step7.body.subscribedStudents[0].studentId).toBe("alice")

        // ── Step 8: Subscribe Bob (fills the course) ──────────────────────────
        console.log("\n[Step 8] POST /courses/ts101/subscriptions — Subscribe Bob (course now full 2/2)")
        const step8 = await agent.post("/courses/ts101/subscriptions").send({ studentId: "bob" })
        console.log(`  → ${step8.status}  ETag: ${step8.headers["etag"]}`)
        expect(step8.status).toBe(201)

        // ── Step 9: Try to subscribe Charlie — course is full ─────────────────
        console.log("\n[Step 9] POST /courses/ts101/subscriptions — Subscribe Charlie (expect 422 — full)")
        const step9 = await agent.post("/courses/ts101/subscriptions").send({ studentId: "charlie" })
        console.log(`  → ${step9.status}  body: ${JSON.stringify(step9.body)}`)
        expect(step9.status).toBe(422)
        expect(step9.body.detail).toBe("Course ts101 is full.")

        // ── Step 10: Unsubscribe Alice ────────────────────────────────────────
        console.log("\n[Step 10] DELETE /courses/ts101/subscriptions/alice — Unsubscribe Alice")
        const step10 = await agent.delete("/courses/ts101/subscriptions/alice")
        console.log(`  → ${step10.status}  ETag: ${step10.headers["etag"]}`)
        expect(step10.status).toBe(204)
        const unsubETag = step10.headers["etag"] as string

        // ── Step 11: Subscribe Charlie — now there is a spot ─────────────────
        console.log("\n[Step 11] POST /courses/ts101/subscriptions — Subscribe Charlie (spot available)")
        const step11 = await agent.post("/courses/ts101/subscriptions").send({ studentId: "charlie" })
        console.log(`  → ${step11.status}  ETag: ${step11.headers["etag"]}`)
        expect(step11.status).toBe(201)
        const charlieSubETag = step11.headers["etag"] as string

        void unsubETag

        // ── Step 12: Read student — wait until Charlie's subscription is projected
        console.log(`\n[Step 12] GET /students/charlie  Prefer: wait=5  If-None-Match: ${charlieSubETag}`)
        const step12 = await agent.get("/students/charlie").set("Prefer", "wait=5").set("If-None-Match", charlieSubETag)
        console.log(`  → ${step12.status}  body: ${JSON.stringify(step12.body)}`)
        expect(step12.status).toBe(200)
        const subscribedCourseIds = step12.body.subscribedCourses.map((c: { courseId: string }) => c.courseId)
        expect(subscribedCourseIds).toContain("ts101")

        // ── Step 13: SSE push notification ───────────────────────────────────
        // Open a persistent SSE connection BEFORE the write so we receive the
        // event the moment it is appended — no polling required.
        console.log("\n[Step 13] SSE push notification — open /events, then POST a new course")

        const server = await new Promise<http.Server>(resolve => {
            const srv = http.createServer(app).listen(0, "127.0.0.1", () => resolve(srv))
        })

        try {
            const addr = server.address() as { port: number }

            const messagePromise = new Promise<{ id: string; data: unknown }>((resolve, reject) => {
                let buffer = ""
                const req = http.get({ host: "127.0.0.1", port: addr.port, path: "/events" }, res => {
                    const timer = setTimeout(() => {
                        req.destroy()
                        reject(new Error("SSE timeout — no event received within 8 s"))
                    }, 8000)

                    res.on("data", (chunk: Buffer) => {
                        buffer += chunk.toString()
                        const parts = buffer.split("\n\n")
                        buffer = parts.pop() ?? ""
                        for (const part of parts) {
                            if (!part.trim() || part.startsWith(":")) continue
                            const lines = part.split("\n")
                            let id = ""
                            let dataStr = ""
                            for (const line of lines) {
                                if (line.startsWith("id: ")) id = line.slice(4)
                                else if (line.startsWith("data: ")) dataStr = line.slice(6)
                            }
                            if (dataStr) {
                                clearTimeout(timer)
                                req.destroy()
                                try {
                                    resolve({ id, data: JSON.parse(dataStr) })
                                } catch {
                                    resolve({ id, data: dataStr })
                                }
                            }
                        }
                    })
                    res.on("error", () => resolve({ id: "", data: null }))
                })
                req.on("error", err => {
                    if ((err as NodeJS.ErrnoException).code !== "ECONNRESET") {
                        reject(err)
                    }
                })
            })

            // Give SSE connection time to establish before writing
            await new Promise<void>(resolve => setTimeout(resolve, 100))

            // Append a new course — this will be pushed to the SSE stream
            console.log("  → POST /courses { id: 'extra101', title: 'Bonus Course', capacity: 5 }")
            const postRes = await agent.post("/courses").send({ id: "extra101", title: "Bonus Course", capacity: 5 })
            console.log(`  → POST status: ${postRes.status}  ETag: ${postRes.headers["etag"]}`)
            expect(postRes.status).toBe(201)

            const message = await messagePromise
            console.log(`  → SSE message received  id: ${message.id}  data: ${JSON.stringify(message.data)}`)

            const data = message.data as { event: { type: string } }
            expect(data.event.type).toBe("courseWasRegistered")
        } finally {
            await new Promise<void>(resolve => {
                server.closeAllConnections?.()
                server.close(() => resolve())
            })
        }

        // ── Step 14: Register a third course (go101) ─────────────────────────
        // Now we have 3 courses: ts101, extra101, go101
        // Sorted alphabetically by _id: extra101, go101, ts101
        console.log("\n[Step 14] POST /courses — Register 'Introduction to Go' (capacity 20)")
        const step14 = await agent.post("/courses").send({ id: "go101", title: "Introduction to Go", capacity: 20 })
        console.log(`  → ${step14.status}  ETag: ${step14.headers["etag"]}`)
        expect(step14.status).toBe(201)
        const goETag = step14.headers["etag"] as string

        // ── Step 15: First page of courses (limit=2) ─────────────────────────
        // Prefer: wait ensures the projection has processed go101 before we read.
        // The response wraps results in { data, cursor? } — a paginated result.
        console.log(`\n[Step 15] GET /courses?limit=2  Prefer: wait=5  If-None-Match: ${goETag}`)
        const step15 = await agent.get("/courses?limit=2").set("Prefer", "wait=5").set("If-None-Match", goETag)
        console.log(`  → ${step15.status}  body: ${JSON.stringify(step15.body)}`)
        expect(step15.status).toBe(200)
        expect(Array.isArray(step15.body.data)).toBe(true)
        expect(step15.body.data).toHaveLength(2)
        expect(step15.body.cursor).toBeDefined()
        const pageCursor = step15.body.cursor as string
        console.log(`  → first page items: ${step15.body.data.map((c: { id: string }) => c.id).join(", ")}`)
        console.log(`  → cursor for next page: ${pageCursor}`)

        // ── Step 16: Second (last) page of courses ────────────────────────────
        // Fetching with the cursor from step 15 returns the remaining 1 course.
        // No cursor in the response means we are on the last page.
        console.log(`\n[Step 16] GET /courses?cursor=${pageCursor}&limit=2 — second page`)
        const step16 = await agent.get(`/courses?cursor=${pageCursor}&limit=2`)
        console.log(`  → ${step16.status}  body: ${JSON.stringify(step16.body)}`)
        expect(step16.status).toBe(200)
        expect(Array.isArray(step16.body.data)).toBe(true)
        expect(step16.body.data).toHaveLength(1)
        expect(step16.body.cursor).toBeUndefined()
        console.log(`  → last page items: ${step16.body.data.map((c: { id: string }) => c.id).join(", ")}`)
        console.log("  → no cursor — last page confirmed")

        // ── Step 17: POST /courses with Idempotency-Key ───────────────────────
        // Client generates a UUID and attaches it as Idempotency-Key. The server
        // stores it as the event's message_id, enabling safe retries.
        const idempotencyKey = "f47ac10b-58cc-4372-a567-0e02b2c3d479"
        console.log(`\n[Step 17] POST /courses with Idempotency-Key: ${idempotencyKey}`)
        const step17 = await agent
            .post("/courses")
            .set("Idempotency-Key", idempotencyKey)
            .send({ id: "idempotent101", title: "Idempotent Course", capacity: 10 })
        console.log(`  → ${step17.status}  ETag: ${step17.headers["etag"]}`)
        expect(step17.status).toBe(201)
        const idempotentETag = step17.headers["etag"] as string

        // ── Step 18: Retry with same Idempotency-Key ──────────────────────────
        // The server finds the existing event by message_id (the pre-check),
        // short-circuits before the decision model, and returns the same ETag.
        // No duplicate event is appended.
        console.log(`\n[Step 18] POST /courses retry with same Idempotency-Key (expect same ETag: ${idempotentETag})`)
        const step18 = await agent
            .post("/courses")
            .set("Idempotency-Key", idempotencyKey)
            .send({ id: "idempotent101", title: "Idempotent Course", capacity: 10 })
        console.log(`  → ${step18.status}  ETag: ${step18.headers["etag"]}`)
        expect(step18.status).toBe(201)
        expect(step18.headers["etag"]).toBe(idempotentETag)
        console.log("  → retry returned same ETag — idempotent")
    })
})
