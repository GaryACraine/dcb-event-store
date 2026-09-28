import { Pool, PoolClient } from "pg"
import { getTestPgDatabasePool } from "@test/testPgDbPool"
import {
    PostgresEventStore,
    createConsumer,
    ensureHandlersInstalled,
    readProcessorStatuses,
    type RunningConsumer
} from "@dcb-es/event-store-postgres"
import {
    installPostgresCourseSubscriptionsRepository,
    PostgresCourseSubscriptionsRepository
} from "./postgresCourseSubscriptionRepository/PostgresCourseSubscriptionRespository.js"
import { Api, PROJECTION_NAME } from "./api/Api.js"
import { PostgresCourseSubscriptionsProjection } from "./api/PostgresCourseSubscriptionsProjection.js"
import { AUDIT_LOG_NAME, CourseAuditLog, installCourseAuditLog } from "./api/CourseAuditLog.js"
import { CourseCapacityWasChangedEvent } from "./api/Events.js"
import { SequencedEvent } from "@dcb-es/event-store"

// Phase 19: a failing read model blocks and retries the same event until it's fixed; nothing is lost. The audit log
// opts in to skip, so an entry it can't write is logged and passed.

const until = async (check: () => boolean | Promise<boolean>, timeoutMs = 3000) => {
    const deadline = Date.now() + timeoutMs
    while (!(await check())) {
        if (Date.now() > deadline) throw new Error("condition not met in time")
        await new Promise(r => setTimeout(r, 20))
    }
}

describe("a consumer with a failure policy", () => {
    let pool: Pool
    let eventStore: PostgresEventStore
    let api: Api
    let consumer: RunningConsumer
    const warnings: string[] = []
    // Stands in for a deployed bug in the read model's capacity handler, and its fix.
    let capacityBug = false

    const projectionWithBug = (client: PoolClient) => {
        const projection = PostgresCourseSubscriptionsProjection(client)
        return {
            when: {
                ...projection.when,
                courseCapacityWasChanged: async (event: SequencedEvent<CourseCapacityWasChangedEvent>) => {
                    if (capacityBug) throw new Error('column "capacity" is misspelt')
                    await projection.when.courseCapacityWasChanged!(event)
                }
            }
        }
    }

    beforeAll(async () => {
        pool = await getTestPgDatabasePool({ max: 20 })
        eventStore = new PostgresEventStore({ pool })
        await eventStore.ensureInstalled()
        await installPostgresCourseSubscriptionsRepository(pool)
        await installCourseAuditLog(pool)
        await ensureHandlersInstalled(pool, [PROJECTION_NAME, AUDIT_LOG_NAME], "_handler_bookmarks")

        consumer = createConsumer({
            pool,
            eventStore,
            logger: { error: () => {}, warn: message => warnings.push(message) },
            processors: [
                {
                    processorName: PROJECTION_NAME,
                    handlerFactory: projectionWithBug,
                    backoff: { initialMs: 50, maxMs: 200 },
                    pollIntervalMs: 20
                },
                {
                    processorName: AUDIT_LOG_NAME,
                    handlerFactory: client => CourseAuditLog(client),
                    onError: "skip",
                    pollIntervalMs: 20
                }
            ]
        })
        api = new Api(pool, eventStore)
    })

    afterAll(async () => {
        await consumer.stop()
        if (pool) await pool.end()
    })

    test("a read model blocked by a bug says so, and catches up once it's fixed", async () => {
        await api.registerCourse({ id: "course-1", title: "Maths", capacity: 5 })

        capacityBug = true
        // The command's own wait for its read model finishes only once the read model has caught up.
        const changed = api.updateCourseCapacity({ courseId: "course-1", newCapacity: 10 })

        await until(() => consumer.status()[0].state === "blocked")
        const [blocked] = consumer.status()
        expect(blocked.blocked!.eventType).toBe("courseCapacityWasChanged")
        expect(blocked.blocked!.error).toContain("misspelt")
        const stored = (await readProcessorStatuses(pool)).find(s => s.processorName === PROJECTION_NAME)!
        expect(stored.blocked!.error).toContain("misspelt")
        // The other processor isn't held up.
        expect(consumer.status()[1].state).toBe("running")

        capacityBug = false
        await changed
        expect((await PostgresCourseSubscriptionsRepository(pool).findCourseById("course-1"))!.capacity).toBe(10)
        expect(consumer.status()[0].state).toBe("running")
        expect(
            (await readProcessorStatuses(pool)).find(s => s.processorName === PROJECTION_NAME)!.blocked
        ).toBeUndefined()
    })

    test("the audit log skips an entry it can't write and carries on", async () => {
        await api.registerCourse({
            id: "course-2",
            title: "A course title far too long for its audit line",
            capacity: 5
        })
        await api.updateCourseTitle({ courseId: "course-2", newTitle: "History" })

        const entries = async () =>
            (await pool.query("SELECT entry FROM course_audit WHERE course_id = 'course-2'")).rows.map(r => r.entry)
        await until(async () => (await entries()).length === 1)
        expect(await entries()).toEqual(["renamed to History"])
        expect(warnings.some(w => w.includes(AUDIT_LOG_NAME) && w.includes("courseWasRegistered"))).toBe(true)
        expect(consumer.status()[1].state).toBe("running")
    })
})
