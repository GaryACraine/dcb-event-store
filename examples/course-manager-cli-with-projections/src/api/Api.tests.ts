import { Pool } from "pg"
import {
    Course,
    PostgresCourseSubscriptionsRepository
} from "../postgresCourseSubscriptionRepository/PostgresCourseSubscriptionRespository.js"
import { Api, PROJECTION_NAME } from "./Api.js"
import { getTestPgDatabasePool } from "@test/testPgDbPool"
import {
    PostgresEventStore,
    createConsumer,
    projectionToProcessor,
    ensureHandlersInstalled,
    ProjectionSpec,
    type RunningConsumer
} from "@dcb-es/event-store-postgres"
import { courseSubscriptionsProjection } from "./PostgresCourseSubscriptionsProjection.js"
import { courseWasRegistered, studentWasRegistered, studentWasSubscribed } from "./Events.js"

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

describe("EventSourcedApi with projectionToProcessor", () => {
    let pool: Pool
    let repository: ReturnType<typeof PostgresCourseSubscriptionsRepository>
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

        // Use projection.init to create read model tables
        const initClient = await pool.connect()
        try {
            await courseSubscriptionsProjection.init!(initClient)
        } finally {
            initClient.release()
        }

        await ensureHandlersInstalled(pool, [PROJECTION_NAME], "_handler_bookmarks")

        consumer = startConsumer(eventStore)
        api = new Api(pool, eventStore)
        repository = PostgresCourseSubscriptionsRepository(pool)
    })

    afterEach(async () => {
        await pool.query("TRUNCATE table events")
        await pool.query("TRUNCATE table courses")
        await pool.query("TRUNCATE table students")
        await pool.query("TRUNCATE table subscriptions")
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

    test("single student registered shows in repository", async () => {
        await api.registerStudent({ id: STUDENT_1.id, name: STUDENT_1.name })

        const student = await repository.findStudentById(STUDENT_1.id)
        expect(student).toEqual({
            id: STUDENT_1.id,
            name: STUDENT_1.name,
            studentNumber: STUDENT_1.studentNumber,
            subscribedCourses: []
        })
    })

    test("student subscribed to course shows in repository", async () => {
        await api.registerCourse({ id: COURSE_1.id, title: COURSE_1.title, capacity: COURSE_1.capacity })
        await api.registerStudent({ id: STUDENT_1.id, name: STUDENT_1.name })
        await api.subscribeStudentToCourse({ courseId: COURSE_1.id, studentId: STUDENT_1.id })

        const course = await repository.findCourseById(COURSE_1.id)
        const student = await repository.findStudentById(STUDENT_1.id)

        expect(course?.subscribedStudents).toEqual([
            { id: STUDENT_1.id, name: STUDENT_1.name, studentNumber: STUDENT_1.studentNumber }
        ])
        expect(student?.subscribedCourses).toEqual([
            { id: COURSE_1.id, title: COURSE_1.title, capacity: COURSE_1.capacity }
        ])
    })

    describe("with one course and 100 students in database", () => {
        beforeEach(async () => {
            await api.registerCourse({ id: COURSE_1.id, title: COURSE_1.title, capacity: COURSE_1.capacity })

            for (let i = 0; i < 100; i++) {
                await api.registerStudent({ id: `student-${i}`, name: `Student ${i}` })
            }
        })

        test("should throw error when 6th student subscribes", async () => {
            for (let i = 1; i <= 5; i++) {
                await api.subscribeStudentToCourse({ courseId: COURSE_1.id, studentId: `student-${i}` })
            }

            await expect(
                api.subscribeStudentToCourse({ courseId: COURSE_1.id, studentId: "student-6" })
            ).rejects.toThrow(`Course ${COURSE_1.id} is full.`)
        })

        test("should reject subscriptions when 10 students subscribe simultaneously", async () => {
            const studentSubscriptionPromises: Promise<void>[] = []

            for (let i = 0; i < 10; i++) {
                studentSubscriptionPromises.push(
                    api.subscribeStudentToCourse({ courseId: COURSE_1.id, studentId: `student-${i}` })
                )
            }

            const results = await Promise.allSettled(studentSubscriptionPromises)
            const succeeded = results.filter(result => result.status === "fulfilled").length
            expect(succeeded).toBeLessThanOrEqual(COURSE_1.capacity)
        })
    })
})

describe("ProjectionSpec for courseSubscriptionsProjection", () => {
    let pool: Pool

    beforeAll(async () => {
        pool = await getTestPgDatabasePool({ max: 10 })
    })

    afterAll(async () => {
        if (pool) await pool.end()
    })

    test("course registration is projected", async () => {
        await ProjectionSpec.for({ projection: courseSubscriptionsProjection, pool })
            .given([])
            .when([courseWasRegistered({ courseId: "c1", title: "Math", capacity: 30 })])
            .then(async client => {
                const result = await client.query("SELECT id, title, capacity FROM courses WHERE id = 'c1'")
                expect(result.rows[0]).toEqual({ id: "c1", title: "Math", capacity: 30 })
            })
    })

    test("student registration is projected", async () => {
        await ProjectionSpec.for({ projection: courseSubscriptionsProjection, pool })
            .given([])
            .when([studentWasRegistered({ studentId: "s1", name: "Alice", studentNumber: 1 })])
            .then(async client => {
                const result = await client.query("SELECT id, name, student_number FROM students WHERE id = 's1'")
                expect(result.rows[0]).toEqual({ id: "s1", name: "Alice", student_number: 1 })
            })
    })

    test("subscription links student to course", async () => {
        await ProjectionSpec.for({ projection: courseSubscriptionsProjection, pool })
            .given([
                courseWasRegistered({ courseId: "c1", title: "Math", capacity: 30 }),
                studentWasRegistered({ studentId: "s1", name: "Alice", studentNumber: 1 })
            ])
            .when([studentWasSubscribed({ courseId: "c1", studentId: "s1" })])
            .then(async client => {
                const result = await client.query(
                    "SELECT course_id, student_id FROM subscriptions WHERE course_id = 'c1' AND student_id = 's1'"
                )
                expect(result.rows).toHaveLength(1)
            })
    })

    test("changes are rolled back after assertion", async () => {
        await ProjectionSpec.for({ projection: courseSubscriptionsProjection, pool })
            .given([courseWasRegistered({ courseId: "c1", title: "Math", capacity: 30 })])
            .when([])
            .then(async client => {
                const result = await client.query("SELECT count(*) as cnt FROM courses")
                expect(result.rows[0].cnt).toBe("1")
            })

        // After rollback, the table should not exist
        const tableCheck = await pool.query(`
            SELECT EXISTS (
                SELECT FROM information_schema.tables
                WHERE table_name = 'courses'
            ) as exists
        `)
        expect(tableCheck.rows[0].exists).toBe(false)
    })
})
