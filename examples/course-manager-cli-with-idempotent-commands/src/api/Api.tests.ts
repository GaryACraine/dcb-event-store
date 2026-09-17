import { Pool } from "pg"
import { Api } from "./Api.js"
import { getTestPgDatabasePool } from "@test/testPgDbPool"
import { PostgresEventStore } from "@dcb-es/event-store-postgres"
import { Query, streamAllEventsToArray } from "@dcb-es/event-store"
import { v4 as uuid } from "uuid"

const COURSE_1 = {
    id: "course-1",
    title: "Course 1",
    capacity: 5
}

describe("EventSourcedApi with idempotent commands", () => {
    let pool: Pool
    let eventStore: PostgresEventStore
    let api: Api

    beforeAll(async () => {
        pool = await getTestPgDatabasePool()
        eventStore = new PostgresEventStore({ pool })
        await eventStore.ensureInstalled()
        api = new Api(eventStore)
    })

    afterEach(async () => {
        await pool.query("DELETE FROM events")
    })

    afterAll(async () => {
        if (pool) await pool.end()
    })

    describe("idempotent commands", () => {
        test("same idempotency key twice produces only one event", async () => {
            const key = uuid()

            await api.registerCourse({ ...COURSE_1, idempotencyKey: key })
            // Second call with same key: append is a no-op due to ON CONFLICT DO NOTHING.
            // However, the decision model will see the course already exists and throw.
            // This is the correct behaviour — idempotency protects against network retries
            // where the first call succeeded but the client didn't get the response.
            // To demonstrate pure store-level idempotency, we use the store directly.
            const pos = await eventStore.append({
                events: {
                    event: { type: "courseWasRegistered", data: { courseId: "idem-1", title: "T", capacity: 1 } },
                    tags: (await import("@dcb-es/event-store")).Tags.fromObj({ courseId: "idem-1" }),
                    id: key
                }
            })

            // Only the original event exists (the duplicate was skipped)
            const events = await streamAllEventsToArray(eventStore.read(Query.all()))
            const matchingIds = events.filter(e => e.id === key)
            expect(matchingIds).toHaveLength(1)
            expect(pos.toString()).toBe("1")
        })

        test("different idempotency keys produce separate events", async () => {
            const key1 = uuid()
            const key2 = uuid()

            await api.registerCourse({ ...COURSE_1, id: "c1", idempotencyKey: key1 })
            await api.registerCourse({ ...COURSE_1, id: "c2", idempotencyKey: key2 })

            const events = await streamAllEventsToArray(eventStore.read(Query.all()))
            expect(events).toHaveLength(2)
            expect(events[0].id).toBe(key1)
            expect(events[1].id).toBe(key2)
        })
    })

    describe("metadata round-trip", () => {
        test("metadata is stored and readable on events", async () => {
            await api.registerCourse(COURSE_1)
            await api.registerStudent({ id: "s1", name: "Alice" })
            await api.subscribeStudentToCourse({
                courseId: COURSE_1.id,
                studentId: "s1",
                metadata: { userId: "admin", correlationId: "req-123" }
            })

            const events = await streamAllEventsToArray(eventStore.read(Query.all()))
            const subscriptionEvent = events.find(e => e.event.type === "studentWasSubscribed")
            expect(subscriptionEvent).toBeDefined()
            expect(subscriptionEvent!.event.metadata).toEqual({ userId: "admin", correlationId: "req-123" })
        })
    })

    describe("recordedAt", () => {
        test("events have a recordedAt timestamp", async () => {
            const before = new Date()
            await api.registerCourse(COURSE_1)
            const after = new Date()

            const events = await streamAllEventsToArray(eventStore.read(Query.all()))
            expect(events[0].recordedAt).toBeInstanceOf(Date)
            expect(events[0].recordedAt.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000)
            expect(events[0].recordedAt.getTime()).toBeLessThanOrEqual(after.getTime() + 1000)
        })
    })

    describe("core behaviour preserved", () => {
        test("should throw error when 6th student subscribes", async () => {
            await api.registerCourse(COURSE_1)
            for (let i = 0; i < 100; i++) {
                await api.registerStudent({ id: `student-${i}`, name: `Student ${i}` })
            }

            for (let i = 1; i <= 5; i++) {
                await api.subscribeStudentToCourse({ courseId: COURSE_1.id, studentId: `student-${i}` })
            }

            await expect(
                api.subscribeStudentToCourse({ courseId: COURSE_1.id, studentId: "student-6" })
            ).rejects.toThrow(`Course ${COURSE_1.id} is full.`)
        })
    })
})
