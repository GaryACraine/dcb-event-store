import { Pool } from "pg"
import {
    Course,
    PongoCourseSubscriptionsRepository
} from "../postgresCourseSubscriptionRepository/PostgresCourseSubscriptionRespository.js"
import { Api } from "./Api.js"
import { getTestPgDatabasePool } from "@test/testPgDbPool"
import { PostgresEventStore, ProjectionSpec } from "@dcb-es/event-store-postgres"
import { courseSubscriptionsProjection } from "./PostgresCourseSubscriptionsProjection.js"
import { CourseWasRegisteredEvent, StudentWasRegistered, StudentWasSubscribedEvent } from "./Events.js"

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

describe("EventSourcedApi with inline projection", () => {
    let pool: Pool
    let repository: ReturnType<typeof PongoCourseSubscriptionsRepository>
    let api: Api

    beforeAll(async () => {
        pool = await getTestPgDatabasePool({ max: 20 })
        // Inline projection — no consumer, no bookmarks
        const eventStore = new PostgresEventStore({
            pool,
            inlineProjections: [courseSubscriptionsProjection]
        })
        await eventStore.ensureInstalled()

        // Init Pongo collection tables eagerly
        const initClient = await pool.connect()
        try {
            await courseSubscriptionsProjection.init!(initClient)
        } finally {
            initClient.release()
        }

        api = new Api(pool, eventStore)
        repository = PongoCourseSubscriptionsRepository(pool)
    })

    afterEach(async () => {
        await pool.query("TRUNCATE table events")
        await pool.query("ALTER SEQUENCE events_sequence_position_seq RESTART WITH 1")
        // Clear Pongo collection data (not table structure)
        await pool.query("DELETE FROM courses")
        await pool.query("DELETE FROM students")
    })

    afterAll(async () => {
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

describe("ProjectionSpec for pongoProjection", () => {
    let pool: Pool

    beforeAll(async () => {
        pool = await getTestPgDatabasePool({ max: 10 })
    })

    afterAll(async () => {
        if (pool) await pool.end()
    })

    test("course registration is projected into Pongo document", async () => {
        await ProjectionSpec.for({ projection: courseSubscriptionsProjection, pool })
            .given([])
            .when([new CourseWasRegisteredEvent({ courseId: "c1", title: "Math", capacity: 30 })])
            .then(async client => {
                const result = await client.query("SELECT data FROM courses WHERE _id = 'c1'")
                expect(result.rows[0].data).toMatchObject({ courseId: "c1", title: "Math", capacity: 30 })
            })
    })

    test("student registration is projected into Pongo document", async () => {
        await ProjectionSpec.for({ projection: courseSubscriptionsProjection, pool })
            .given([])
            .when([new StudentWasRegistered({ studentId: "s1", name: "Alice", studentNumber: 1 })])
            .then(async client => {
                const result = await client.query("SELECT data FROM students WHERE _id = 's1'")
                expect(result.rows[0].data).toMatchObject({
                    studentId: "s1",
                    name: "Alice",
                    studentNumber: 1
                })
            })
    })

    test("subscription embeds student in course and course in student", async () => {
        await ProjectionSpec.for({ projection: courseSubscriptionsProjection, pool })
            .given([
                new CourseWasRegisteredEvent({ courseId: "c1", title: "Math", capacity: 30 }),
                new StudentWasRegistered({ studentId: "s1", name: "Alice", studentNumber: 1 })
            ])
            .when([new StudentWasSubscribedEvent({ courseId: "c1", studentId: "s1" })])
            .then(async client => {
                const courseResult = await client.query("SELECT data FROM courses WHERE _id = 'c1'")
                expect(courseResult.rows[0].data.subscribedStudents).toEqual([
                    { studentId: "s1", name: "Alice", studentNumber: 1 }
                ])

                const studentResult = await client.query("SELECT data FROM students WHERE _id = 's1'")
                expect(studentResult.rows[0].data.subscribedCourses).toEqual([
                    { courseId: "c1", title: "Math", capacity: 30 }
                ])
            })
    })

    test("changes are rolled back after assertion", async () => {
        await ProjectionSpec.for({ projection: courseSubscriptionsProjection, pool })
            .given([new CourseWasRegisteredEvent({ courseId: "c1", title: "Math", capacity: 30 })])
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
