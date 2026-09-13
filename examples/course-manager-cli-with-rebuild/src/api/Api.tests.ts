import { Pool } from "pg"
import {
    Course,
    PongoCourseSubscriptionsRepository
} from "../postgresCourseSubscriptionRepository/PostgresCourseSubscriptionRespository.js"
import { Api, PROJECTION_NAME } from "./Api.js"
import { getTestPgDatabasePool } from "@test/testPgDbPool"
import {
    PostgresEventStore,
    createConsumer,
    projectionToProcessor,
    ensureHandlersInstalled,
    rebuildProjection,
    type RunningConsumer
} from "@dcb-es/event-store-postgres"
import {
    courseSubscriptionsProjection,
    courseSubscriptionsProjectionV2
} from "./PostgresCourseSubscriptionsProjection.js"

const COURSE_1 = {
    id: "course-1",
    title: "Course 1",
    capacity: 5
}

const STUDENT_1 = {
    id: "student-1",
    name: "Student 1",
    studentNumber: 1
}

describe("EventSourcedApi with pongoProjection and rebuild", () => {
    let pool: Pool
    let repository: ReturnType<typeof PongoCourseSubscriptionsRepository>
    let api: Api
    let consumer: RunningConsumer

    function startConsumer(eventStore: PostgresEventStore) {
        return createConsumer({
            pool,
            eventStore,
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
        const eventStore = new PostgresEventStore({ pool })
        await eventStore.ensureInstalled()

        // Init Pongo collection tables eagerly
        const initClient = await pool.connect()
        try {
            await courseSubscriptionsProjection.init!(initClient)
        } finally {
            initClient.release()
        }

        await ensureHandlersInstalled(pool, [PROJECTION_NAME], "_handler_bookmarks")

        consumer = startConsumer(eventStore)
        api = new Api(pool, eventStore)
        repository = PongoCourseSubscriptionsRepository(pool)
    })

    afterEach(async () => {
        await pool.query("TRUNCATE table events")
        // Clear Pongo collection data (not table structure)
        await pool.query("DELETE FROM courses")
        await pool.query("DELETE FROM students")
        await pool.query("UPDATE _handler_bookmarks SET last_sequence_position = 0, version = 1, instance_id = NULL")

        // Restart consumer with fresh bookmark
        await consumer.stop()
        const eventStore = new PostgresEventStore({ pool })
        consumer = startConsumer(eventStore)
    })

    afterAll(async () => {
        await consumer.stop()
        if (pool) await pool.end()
    })

    test("single course registered shows in repository", async () => {
        await api.registerCourse({ id: COURSE_1.id, title: COURSE_1.title, capacity: COURSE_1.capacity })

        const course = await repository.findCourseById(COURSE_1.id)
        expect(course).toEqual(<Course>{
            id: COURSE_1.id,
            title: COURSE_1.title,
            capacity: COURSE_1.capacity,
            subscribedStudents: []
        })
    })

    test("student subscribed to course shows in repository", async () => {
        await api.registerCourse({ id: COURSE_1.id, title: COURSE_1.title, capacity: COURSE_1.capacity })
        await api.registerStudent({ id: STUDENT_1.id, name: STUDENT_1.name })
        await api.subscribeStudentToCourse({ courseId: COURSE_1.id, studentId: STUDENT_1.id })

        const course = await repository.findCourseById(COURSE_1.id)
        expect(course?.subscribedStudents).toEqual([
            { id: STUDENT_1.id, name: STUDENT_1.name, studentNumber: STUDENT_1.studentNumber }
        ])
    })
})

describe("Projection rebuild: v1 → v2 migration", () => {
    let pool: Pool
    let eventStore: PostgresEventStore
    let api: Api
    let consumer: RunningConsumer

    beforeAll(async () => {
        pool = await getTestPgDatabasePool({ max: 20 })
        eventStore = new PostgresEventStore({ pool })
        await eventStore.ensureInstalled()

        // Init v1 projection
        const initClient = await pool.connect()
        try {
            await courseSubscriptionsProjection.init!(initClient)
        } finally {
            initClient.release()
        }

        await ensureHandlersInstalled(pool, [PROJECTION_NAME], "_handler_bookmarks")

        consumer = createConsumer({
            pool,
            eventStore,
            processors: [
                projectionToProcessor(courseSubscriptionsProjection, {
                    batchSize: 100,
                    startFrom: "BEGINNING"
                })
            ]
        })

        api = new Api(pool, eventStore)
    })

    afterAll(async () => {
        await consumer.stop()
        if (pool) await pool.end()
    })

    test("append events → verify v1 read model → rebuild with v2 → verify v2 → append more → verify v2 includes new events", async () => {
        // Step 1: Append events through v1 projection
        await api.registerCourse({ id: "c1", title: "Math", capacity: 30 })
        await api.registerStudent({ id: "s1", name: "Alice" })
        await api.subscribeStudentToCourse({ courseId: "c1", studentId: "s1" })

        // Step 2: Verify v1 read model — no subscriberCount field
        const v1Course = await pool.query("SELECT data FROM courses WHERE _id = 'c1'")
        expect(v1Course.rows[0].data.subscribedStudents).toHaveLength(1)
        expect(v1Course.rows[0].data.subscriberCount).toBeUndefined()

        // Step 3: Stop the v1 consumer before rebuild
        await consumer.stop()

        // Step 4: Rebuild with v2 projection
        await rebuildProjection({
            pool,
            eventStore,
            projection: courseSubscriptionsProjectionV2
        })

        // Step 5: Verify v2 read model — subscriberCount field is populated
        const v2Course = await pool.query("SELECT data FROM courses WHERE _id = 'c1'")
        expect(v2Course.rows[0].data.subscriberCount).toBe(1)
        expect(v2Course.rows[0].data.subscribedStudents).toHaveLength(1)

        const v2Student = await pool.query("SELECT data FROM students WHERE _id = 's1'")
        expect(v2Student.rows[0].data.subscribedCourses).toHaveLength(1)

        // Step 6: Start v2 consumer for ongoing processing
        consumer = createConsumer({
            pool,
            eventStore,
            processors: [
                projectionToProcessor(courseSubscriptionsProjectionV2, {
                    batchSize: 100,
                    startFrom: "BEGINNING"
                })
            ]
        })

        // Step 7: Append more events after rebuild
        await api.registerStudent({ id: "s2", name: "Bob" })
        await api.subscribeStudentToCourse({ courseId: "c1", studentId: "s2" })

        // Step 8: Verify v2 includes new events with subscriberCount
        const finalCourse = await pool.query("SELECT data FROM courses WHERE _id = 'c1'")
        expect(finalCourse.rows[0].data.subscriberCount).toBe(2)
        expect(finalCourse.rows[0].data.subscribedStudents).toHaveLength(2)
    })
})
