import { Pool } from "pg"
import { AnyEvent, TaggedEvent, Query, streamAllEventsToArray, Tags } from "@dcb-es/event-store"
import { PostgresEventStore } from "./PostgresEventStore.js"
import { LockStrategy, advisoryLocks, rowLocks } from "./lockStrategy.js"
import { getTestPgDatabasePool } from "@test/testPgDbPool"
import { v4 as uuid } from "uuid"

const event = (type: string, tags: Tags, data: unknown = {}, metadata?: unknown): TaggedEvent<AnyEvent> => ({
    event: { type, data, ...(metadata !== undefined ? { metadata } : {}) } as AnyEvent,
    tags
})

const eventWithId = (id: string, type: string, tags: Tags, data: unknown = {}): TaggedEvent<AnyEvent> => ({
    event: { type, data } as AnyEvent,
    tags,
    id
})

const eventWithVersion = (
    type: string,
    tags: Tags,
    schemaVersion: string,
    data: unknown = {}
): TaggedEvent<AnyEvent> => ({
    event: { type, data } as AnyEvent,
    tags,
    schemaVersion
})

const strategies: [string, () => LockStrategy][] = [
    ["advisory", () => advisoryLocks()],
    ["row-locks", () => rowLocks()]
]

describe.each(strategies)("Event Identity [%s]", (_name, createStrategy) => {
    let pool: Pool
    let store: PostgresEventStore

    beforeAll(async () => {
        pool = await getTestPgDatabasePool({ max: 30 })
        store = new PostgresEventStore({ pool, lockStrategy: createStrategy() })
        await store.ensureInstalled()
    })

    afterEach(async () => {
        await pool.query("TRUNCATE table events")
        await pool.query("ALTER SEQUENCE events_sequence_position_seq RESTART WITH 1")
    })

    afterAll(async () => {
        if (pool) await pool.end()
    })

    // ─── IDEMPOTENT APPEND (FUNCTION PATH) ──────────────────────────

    describe("idempotent append via function path", () => {
        test("explicit id stores and round-trips", async () => {
            const id = uuid()
            await store.append({
                events: eventWithId(id, "TestEvent", Tags.fromObj({ e: "1" }), { foo: "bar" })
            })

            const events = await streamAllEventsToArray(store.read(Query.all()))
            expect(events).toHaveLength(1)
            expect(events[0].id).toBe(id)
        })

        test("duplicate append returns same position and inserts nothing", async () => {
            const id = uuid()
            const evt = eventWithId(id, "TestEvent", Tags.fromObj({ e: "1" }), { foo: "bar" })

            const pos1 = await store.append({ events: evt })
            const pos2 = await store.append({ events: evt })

            expect(pos1.toString()).toBe(pos2.toString())

            const events = await streamAllEventsToArray(store.read(Query.all()))
            expect(events).toHaveLength(1)
        })

        test("auto-generated ids are unique", async () => {
            await store.append({
                events: [event("A", Tags.fromObj({ e: "1" })), event("B", Tags.fromObj({ e: "2" }))]
            })

            const events = await streamAllEventsToArray(store.read(Query.all()))
            expect(events).toHaveLength(2)
            expect(events[0].id).toBeTruthy()
            expect(events[1].id).toBeTruthy()
            expect(events[0].id).not.toBe(events[1].id)
        })
    })

    // ─── IDEMPOTENT APPEND (COPY PATH) ──────────────────────────────

    describe("idempotent append via COPY path", () => {
        let copyStore: PostgresEventStore

        beforeAll(async () => {
            copyStore = new PostgresEventStore({
                pool,
                lockStrategy: createStrategy(),
                copyThreshold: 0 // force COPY path for all appends
            })
            await copyStore.ensureInstalled()
        })

        test("generated ids are unique across COPY batch", async () => {
            const events = Array.from({ length: 10 }, (_, i) => event(`Type${i}`, Tags.fromObj({ e: `${i}` })))

            await copyStore.append({ events })

            const stored = await streamAllEventsToArray(copyStore.read(Query.all()))
            const ids = stored.map(e => e.id)
            const uniqueIds = new Set(ids)
            expect(uniqueIds.size).toBe(10)
        })

        test("all-duplicate COPY returns existing position", async () => {
            const id1 = uuid()
            const id2 = uuid()
            const events = [
                eventWithId(id1, "A", Tags.fromObj({ e: "1" })),
                eventWithId(id2, "B", Tags.fromObj({ e: "2" }))
            ]

            const pos1 = await copyStore.append({ events })
            const pos2 = await copyStore.append({ events })

            expect(pos1.toString()).toBe(pos2.toString())

            const stored = await streamAllEventsToArray(copyStore.read(Query.all()))
            expect(stored).toHaveLength(2)
        })

        test("partial-duplicate COPY throws", async () => {
            const existingId = uuid()
            await copyStore.append({
                events: eventWithId(existingId, "A", Tags.fromObj({ e: "1" }))
            })

            const mixedEvents = [
                eventWithId(existingId, "A", Tags.fromObj({ e: "1" })),
                eventWithId(uuid(), "B", Tags.fromObj({ e: "2" }))
            ]

            await expect(copyStore.append({ events: mixedEvents })).rejects.toThrow(/Partial duplicate/)
        })

        test("no supplied ids skips duplicate check", async () => {
            const events = Array.from({ length: 5 }, (_, i) => event(`Type${i}`, Tags.fromObj({ e: `${i}` })))

            // Should succeed without any duplicate detection overhead
            const pos = await copyStore.append({ events })
            expect(pos).toBeTruthy()
        })
    })

    // ─── RECORDED_AT ─────────────────────────────────────────────────

    describe("recorded_at", () => {
        test("returns a valid Date", async () => {
            await store.append({
                events: event("TestEvent", Tags.fromObj({ e: "1" }))
            })

            const events = await streamAllEventsToArray(store.read(Query.all()))
            expect(events[0].recordedAt).toBeInstanceOf(Date)
            expect(events[0].recordedAt.getTime()).not.toBeNaN()
        })

        test("monotonic non-decreasing within a batch", async () => {
            await store.append({
                events: Array.from({ length: 5 }, (_, i) => event(`Type${i}`, Tags.fromObj({ e: `${i}` })))
            })

            const events = await streamAllEventsToArray(store.read(Query.all()))
            for (let i = 1; i < events.length; i++) {
                expect(events[i].recordedAt.getTime()).toBeGreaterThanOrEqual(events[i - 1].recordedAt.getTime())
            }
        })
    })

    // ─── METADATA JSONB ──────────────────────────────────────────────

    describe("metadata JSONB", () => {
        test("round-trips structured metadata", async () => {
            const meta = { userId: "U1", correlationId: "C1", nested: { key: "value" } }
            await store.append({
                events: event("TestEvent", Tags.fromObj({ e: "1" }), { foo: "bar" }, meta)
            })

            const events = await streamAllEventsToArray(store.read(Query.all()))
            expect(events[0].event.metadata).toEqual(meta)
        })

        test("metadata column is queryable with ->>", async () => {
            const meta = { userId: "U42", source: "test" }
            await store.append({
                events: event("TestEvent", Tags.fromObj({ e: "1" }), {}, meta)
            })

            const result = await pool.query(
                `SELECT metadata->>'userId' as user_id FROM events WHERE metadata->>'userId' = $1`,
                ["U42"]
            )
            expect(result.rows).toHaveLength(1)
            expect(result.rows[0].user_id).toBe("U42")
        })
    })

    // ─── SCHEMA VERSION ──────────────────────────────────────────────

    describe("schema_version", () => {
        test("defaults to '1'", async () => {
            await store.append({
                events: event("TestEvent", Tags.fromObj({ e: "1" }))
            })

            const result = await pool.query(`SELECT schema_version FROM events`)
            expect(result.rows[0].schema_version).toBe("1")
        })

        test("explicit version stored correctly", async () => {
            await store.append({
                events: eventWithVersion("TestEvent", Tags.fromObj({ e: "1" }), "2")
            })

            const result = await pool.query(`SELECT schema_version FROM events`)
            expect(result.rows[0].schema_version).toBe("2")

            const events = await streamAllEventsToArray(store.read(Query.all()))
            expect(events[0].schemaVersion).toBe("2")
        })
    })

    // ─── NEW FIELDS WITH EXISTING FEATURES ───────────────────────────

    describe("integration with existing features", () => {
        test("events with ids work with conditions", async () => {
            const id1 = uuid()
            const id2 = uuid()
            const tags = Tags.fromObj({ entity: "1" })

            await store.append({
                events: eventWithId(id1, "Created", tags, { v: 1 }),
                condition: {
                    failIfEventsMatch: Query.fromItems([{ types: ["Created"], tags }])
                }
            })

            // Second append with condition should still work (different event type)
            const pos = await store.append({
                events: eventWithId(id2, "Updated", tags, { v: 2 }),
                condition: {
                    failIfEventsMatch: Query.fromItems([{ types: ["Updated"], tags }])
                }
            })

            expect(pos.toString()).toBe("2")
        })

        test("read returns id and recordedAt for all events", async () => {
            await store.append({
                events: [
                    event("A", Tags.fromObj({ e: "1" })),
                    event("B", Tags.fromObj({ e: "2" })),
                    event("C", Tags.fromObj({ e: "3" }))
                ]
            })

            const events = await streamAllEventsToArray(store.read(Query.all()))
            for (const ev of events) {
                expect(ev.id).toBeTruthy()
                expect(typeof ev.id).toBe("string")
                expect(ev.recordedAt).toBeInstanceOf(Date)
            }
        })
    })
})
