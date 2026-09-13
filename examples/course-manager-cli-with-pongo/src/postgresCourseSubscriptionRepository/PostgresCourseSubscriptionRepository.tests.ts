import { Pool, PoolClient } from "pg"
import { PongoCourseSubscriptionsRepository, Student } from "./PostgresCourseSubscriptionRespository.js"
import { getTestPgDatabasePool } from "@test/testPgDbPool"

const COURSE_1 = {
    id: "course-1",
    title: "Course 1",
    capacity: 30
}
const STUDENT_1 = {
    id: "student-1",
    name: "John Doe",
    studentNumber: 1
}

/*
    The repository reads from Pongo-managed JSONB tables (courses, students).
    These tests set up the tables and data directly to verify the query logic.
*/

describe("PongoCourseSubscriptionRepository", () => {
    let pool: Pool
    let client: PoolClient
    let repository: ReturnType<typeof PongoCourseSubscriptionsRepository>

    beforeAll(async () => {
        pool = await getTestPgDatabasePool()
        // Create Pongo-style tables
        const setupClient = await pool.connect()
        try {
            await setupClient.query(`
                CREATE TABLE IF NOT EXISTS courses (
                    _id TEXT PRIMARY KEY,
                    data JSONB NOT NULL DEFAULT '{}',
                    metadata JSONB DEFAULT '{}',
                    _version BIGINT DEFAULT 1,
                    _partition TEXT DEFAULT 'png_global',
                    _archived BOOLEAN DEFAULT FALSE,
                    _created TIMESTAMPTZ DEFAULT now(),
                    _updated TIMESTAMPTZ DEFAULT now()
                );
                CREATE TABLE IF NOT EXISTS students (
                    _id TEXT PRIMARY KEY,
                    data JSONB NOT NULL DEFAULT '{}',
                    metadata JSONB DEFAULT '{}',
                    _version BIGINT DEFAULT 1,
                    _partition TEXT DEFAULT 'png_global',
                    _archived BOOLEAN DEFAULT FALSE,
                    _created TIMESTAMPTZ DEFAULT now(),
                    _updated TIMESTAMPTZ DEFAULT now()
                );
            `)
        } finally {
            setupClient.release()
        }
    })

    beforeEach(async () => {
        client = await pool.connect()
        await client.query("BEGIN")
        repository = PongoCourseSubscriptionsRepository(client)
    })

    afterEach(async () => {
        await client.query("ROLLBACK")
        client.release()
        await pool.query("DELETE FROM courses")
        await pool.query("DELETE FROM students")
    })

    afterAll(async () => {
        if (pool) await pool.end()
    })

    async function insertCourseDoc(c: PoolClient, doc: { courseId: string; title: string; capacity: number; subscribedStudents?: any[] }) {
        await c.query(
            "INSERT INTO courses (_id, data) VALUES ($1, $2)",
            [doc.courseId, JSON.stringify({ ...doc, subscribedStudents: doc.subscribedStudents ?? [] })]
        )
    }

    async function insertStudentDoc(c: PoolClient, doc: { studentId: string; name: string; studentNumber: number; subscribedCourses?: any[] }) {
        await c.query(
            "INSERT INTO students (_id, data) VALUES ($1, $2)",
            [doc.studentId, JSON.stringify({ ...doc, subscribedCourses: doc.subscribedCourses ?? [] })]
        )
    }

    describe("findCourseById", () => {
        test("should return a course by ID with empty subscriptions", async () => {
            await insertCourseDoc(client, {
                courseId: COURSE_1.id,
                title: COURSE_1.title,
                capacity: COURSE_1.capacity
            })

            const course = await repository.findCourseById(COURSE_1.id)
            expect(course).toEqual({
                id: COURSE_1.id,
                title: COURSE_1.title,
                capacity: COURSE_1.capacity,
                subscribedStudents: []
            })
        })

        test("should return a course with embedded subscribed students", async () => {
            await insertCourseDoc(client, {
                courseId: COURSE_1.id,
                title: COURSE_1.title,
                capacity: COURSE_1.capacity,
                subscribedStudents: [
                    { studentId: STUDENT_1.id, name: STUDENT_1.name, studentNumber: STUDENT_1.studentNumber }
                ]
            })

            const course = await repository.findCourseById(COURSE_1.id)
            expect(course?.subscribedStudents).toEqual([
                { id: STUDENT_1.id, name: STUDENT_1.name, studentNumber: STUDENT_1.studentNumber }
            ])
        })

        test("should return undefined if the course does not exist", async () => {
            const course = await repository.findCourseById("non-existent-course")
            expect(course).toBeUndefined()
        })
    })

    describe("findStudentById", () => {
        test("should return a student by ID with no subscribed courses", async () => {
            await insertStudentDoc(client, {
                studentId: STUDENT_1.id,
                name: STUDENT_1.name,
                studentNumber: STUDENT_1.studentNumber
            })

            const student = await repository.findStudentById(STUDENT_1.id)
            expect(student).toEqual(<Student>{
                id: STUDENT_1.id,
                name: STUDENT_1.name,
                studentNumber: STUDENT_1.studentNumber,
                subscribedCourses: []
            })
        })

        test("should return a student with embedded subscribed courses", async () => {
            await insertStudentDoc(client, {
                studentId: STUDENT_1.id,
                name: STUDENT_1.name,
                studentNumber: STUDENT_1.studentNumber,
                subscribedCourses: [
                    { courseId: COURSE_1.id, title: COURSE_1.title, capacity: COURSE_1.capacity }
                ]
            })

            const student = await repository.findStudentById(STUDENT_1.id)
            expect(student?.subscribedCourses).toEqual([
                { id: COURSE_1.id, title: COURSE_1.title, capacity: COURSE_1.capacity }
            ])
        })

        test("should return undefined if the student does not exist", async () => {
            const student = await repository.findStudentById("non-existent-student")
            expect(student).toBeUndefined()
        })
    })
})
