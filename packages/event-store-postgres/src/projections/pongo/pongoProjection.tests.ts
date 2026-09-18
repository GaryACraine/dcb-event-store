/* eslint-disable @typescript-eslint/no-explicit-any */
import { Pool } from "pg"
import { getTestPgDatabasePool } from "@test/testPgDbPool"
import { Tags, AnyEvent, TaggedEvent, SequencedEvent, SequencePosition } from "@dcb-es/event-store"
import { v4 as uuid } from "uuid"
import { pongoProjection, PongoProjectionContext } from "./pongoProjection.js"
import { pongoDocumentProjection } from "./pongoDocumentProjection.js"
import { ProjectionSpec } from "../projectionSpec.js"

interface CourseDoc {
    _id?: string
    courseId: string
    title: string
    capacity: number
    subscribedStudents: string[]
}

interface StudentDoc {
    _id?: string
    studentId: string
    name: string
    studentNumber: number
    subscribedCourses: string[]
}

const courseWasRegistered = (data: { courseId: string; title: string; capacity: number }): TaggedEvent<AnyEvent> => ({
    event: { type: "courseWasRegistered", data } as AnyEvent,
    tags: Tags.fromObj({ courseId: data.courseId })
})

const studentWasRegistered = (data: {
    studentId: string
    name: string
    studentNumber: number
}): TaggedEvent<AnyEvent> => ({
    event: { type: "studentWasRegistered", data } as AnyEvent,
    tags: Tags.fromObj({ studentId: data.studentId })
})

const studentWasSubscribed = (data: { courseId: string; studentId: string }): TaggedEvent<AnyEvent> => ({
    event: { type: "studentWasSubscribed", data } as AnyEvent,
    tags: Tags.fromObj({ courseId: data.courseId, studentId: data.studentId })
})

const studentWasUnsubscribed = (data: { courseId: string; studentId: string }): TaggedEvent<AnyEvent> => ({
    event: { type: "studentWasUnsubscribed", data } as AnyEvent,
    tags: Tags.fromObj({ courseId: data.courseId, studentId: data.studentId })
})

function toSequencedEvent(tagged: TaggedEvent<AnyEvent>, position: number): SequencedEvent {
    return {
        event: tagged.event,
        tags: tagged.tags,
        position: SequencePosition.fromString(String(position)),
        id: uuid(),
        recordedAt: new Date()
    }
}

const courseProjection = pongoProjection({
    name: "PongoCourseProjection",
    canHandle: ["courseWasRegistered", "studentWasRegistered", "studentWasSubscribed", "studentWasUnsubscribed"],
    init: async pongo => {
        const db = pongo.db()
        await db.collection<CourseDoc>("courses").createCollection()
        await db.collection<StudentDoc>("students").createCollection()
    },
    handle: async (events: SequencedEvent[], context: PongoProjectionContext) => {
        const courses = context.pongo.db().collection<CourseDoc>("courses")
        const students = context.pongo.db().collection<StudentDoc>("students")

        for (const sequencedEvent of events) {
            const data = sequencedEvent.event.data as Record<string, unknown>
            switch (sequencedEvent.event.type) {
                case "courseWasRegistered":
                    await courses.insertOne({
                        _id: data.courseId as string,
                        courseId: data.courseId as string,
                        title: data.title as string,
                        capacity: data.capacity as number,
                        subscribedStudents: []
                    })
                    break
                case "studentWasRegistered":
                    await students.insertOne({
                        _id: data.studentId as string,
                        studentId: data.studentId as string,
                        name: data.name as string,
                        studentNumber: data.studentNumber as number,
                        subscribedCourses: []
                    })
                    break
                case "studentWasSubscribed": {
                    const courseId = data.courseId as string
                    const studentId = data.studentId as string
                    await courses.updateOne({ _id: courseId } as any, {
                        $push: { subscribedStudents: studentId } as any
                    })
                    await students.updateOne({ _id: studentId } as any, {
                        $push: { subscribedCourses: courseId } as any
                    })
                    break
                }
                case "studentWasUnsubscribed": {
                    const courseId = data.courseId as string
                    const studentId = data.studentId as string
                    await courses.updateOne({ _id: courseId } as any, {
                        $pull: { subscribedStudents: studentId } as any
                    })
                    await students.updateOne({ _id: studentId } as any, {
                        $pull: { subscribedCourses: courseId } as any
                    })
                    break
                }
            }
        }
    },
    truncate: async pongo => {
        const db = pongo.db()
        await db.collection<CourseDoc>("courses").deleteMany()
        await db.collection<StudentDoc>("students").deleteMany()
    }
})

describe("pongoProjection", () => {
    let pool: Pool

    beforeAll(async () => {
        pool = await getTestPgDatabasePool({ max: 10 })
    })

    afterAll(async () => {
        if (pool) await pool.end()
    })

    test("transaction rollback undoes Pongo writes", async () => {
        const client = await pool.connect()
        try {
            await client.query("BEGIN")

            // Init creates the collection tables
            await courseProjection.init!(client)

            // Handle an event within the transaction
            const event = toSequencedEvent(courseWasRegistered({ courseId: "c1", title: "Math", capacity: 30 }), 1)
            await courseProjection.handle([event], { client })

            // Verify it's visible within the transaction
            const result = await client.query("SELECT data FROM courses WHERE _id = 'c1'")
            expect(result.rows).toHaveLength(1)
            const doc = result.rows[0].data
            expect(doc.title).toBe("Math")
            expect(doc.capacity).toBe(30)

            // Rollback
            await client.query("ROLLBACK")

            // Verify table doesn't exist after rollback
            const tableCheck = await pool.query(`
                SELECT EXISTS (
                    SELECT FROM information_schema.tables WHERE table_name = 'courses'
                ) as exists
            `)
            expect(tableCheck.rows[0].exists).toBe(false)
        } finally {
            client.release()
        }
    })

    test("init creates collection tables eagerly", async () => {
        const client = await pool.connect()
        try {
            await client.query("BEGIN")

            await courseProjection.init!(client)

            // Verify tables exist
            const coursesCheck = await client.query(`
                SELECT EXISTS (
                    SELECT FROM information_schema.tables WHERE table_name = 'courses'
                ) as exists
            `)
            expect(coursesCheck.rows[0].exists).toBe(true)

            const studentsCheck = await client.query(`
                SELECT EXISTS (
                    SELECT FROM information_schema.tables WHERE table_name = 'students'
                ) as exists
            `)
            expect(studentsCheck.rows[0].exists).toBe(true)

            await client.query("ROLLBACK")
        } finally {
            client.release()
        }
    })

    test("processes multiple event types into Pongo collections", async () => {
        const client = await pool.connect()
        try {
            await client.query("BEGIN")
            await courseProjection.init!(client)

            const events = [
                toSequencedEvent(courseWasRegistered({ courseId: "c1", title: "Math", capacity: 30 }), 1),
                toSequencedEvent(studentWasRegistered({ studentId: "s1", name: "Alice", studentNumber: 1 }), 2),
                toSequencedEvent(studentWasSubscribed({ courseId: "c1", studentId: "s1" }), 3)
            ]

            await courseProjection.handle(events, { client })

            // Verify course has the student
            const courseResult = await client.query("SELECT data FROM courses WHERE _id = 'c1'")
            const courseDoc = courseResult.rows[0].data
            expect(courseDoc.subscribedStudents).toEqual(["s1"])

            // Verify student has the course
            const studentResult = await client.query("SELECT data FROM students WHERE _id = 's1'")
            const studentDoc = studentResult.rows[0].data
            expect(studentDoc.subscribedCourses).toEqual(["c1"])

            await client.query("ROLLBACK")
        } finally {
            client.release()
        }
    })
})

describe("pongoDocumentProjection", () => {
    let pool: Pool

    beforeAll(async () => {
        pool = await getTestPgDatabasePool({ max: 10 })
    })

    afterAll(async () => {
        if (pool) await pool.end()
    })

    const courseDocProjection = pongoDocumentProjection<CourseDoc>({
        name: "PongoCourseDocProjection",
        canHandle: ["courseWasRegistered", "studentWasSubscribed", "studentWasUnsubscribed"],
        collectionName: "course_docs",
        getDocumentId: event => {
            const data = event.event.data as Record<string, unknown>
            return (data.courseId as string) ?? null
        },
        evolve: (doc, event) => {
            const data = event.event.data as Record<string, unknown>
            switch (event.event.type) {
                case "courseWasRegistered":
                    return {
                        courseId: data.courseId as string,
                        title: data.title as string,
                        capacity: data.capacity as number,
                        subscribedStudents: []
                    }
                case "studentWasSubscribed":
                    if (!doc) return null
                    return {
                        ...doc,
                        subscribedStudents: [...doc.subscribedStudents, data.studentId as string]
                    }
                case "studentWasUnsubscribed":
                    if (!doc) return null
                    return {
                        ...doc,
                        subscribedStudents: doc.subscribedStudents.filter(s => s !== (data.studentId as string))
                    }
                default:
                    return doc
            }
        }
    })

    test("events with different entity IDs produce separate documents", async () => {
        const client = await pool.connect()
        try {
            await client.query("BEGIN")
            await courseDocProjection.init!(client)

            const events = [
                toSequencedEvent(courseWasRegistered({ courseId: "c1", title: "Math", capacity: 30 }), 1),
                toSequencedEvent(courseWasRegistered({ courseId: "c2", title: "Science", capacity: 25 }), 2)
            ]

            await courseDocProjection.handle(events, { client })

            const r1 = await client.query("SELECT data FROM course_docs WHERE _id = 'c1'")
            expect(r1.rows[0].data.title).toBe("Math")
            expect(r1.rows[0].data.capacity).toBe(30)

            const r2 = await client.query("SELECT data FROM course_docs WHERE _id = 'c2'")
            expect(r2.rows[0].data.title).toBe("Science")
            expect(r2.rows[0].data.capacity).toBe(25)

            await client.query("ROLLBACK")
        } finally {
            client.release()
        }
    })

    test("fold state correctly across multiple events for same document", async () => {
        const client = await pool.connect()
        try {
            await client.query("BEGIN")
            await courseDocProjection.init!(client)

            const events = [
                toSequencedEvent(courseWasRegistered({ courseId: "c1", title: "Math", capacity: 30 }), 1),
                toSequencedEvent(studentWasSubscribed({ courseId: "c1", studentId: "s1" }), 2),
                toSequencedEvent(studentWasSubscribed({ courseId: "c1", studentId: "s2" }), 3),
                toSequencedEvent(studentWasUnsubscribed({ courseId: "c1", studentId: "s1" }), 4)
            ]

            await courseDocProjection.handle(events, { client })

            const result = await client.query("SELECT data FROM course_docs WHERE _id = 'c1'")
            const doc = result.rows[0].data
            expect(doc.title).toBe("Math")
            expect(doc.subscribedStudents).toEqual(["s2"])

            await client.query("ROLLBACK")
        } finally {
            client.release()
        }
    })

    test("events with null getDocumentId are skipped", async () => {
        const projection = pongoDocumentProjection<CourseDoc>({
            name: "NullIdProjection",
            canHandle: ["courseWasRegistered"],
            collectionName: "null_id_docs",
            getDocumentId: () => null,
            evolve: doc => doc
        })

        const client = await pool.connect()
        try {
            await client.query("BEGIN")
            await projection.init!(client)

            const events = [toSequencedEvent(courseWasRegistered({ courseId: "c1", title: "Math", capacity: 30 }), 1)]

            await projection.handle(events, { client })

            const result = await client.query("SELECT count(*) as cnt FROM null_id_docs")
            expect(result.rows[0].cnt).toBe("0")

            await client.query("ROLLBACK")
        } finally {
            client.release()
        }
    })

    test("transaction rollback undoes pongoDocumentProjection writes", async () => {
        const client = await pool.connect()
        try {
            await client.query("BEGIN")
            await courseDocProjection.init!(client)

            const events = [toSequencedEvent(courseWasRegistered({ courseId: "c1", title: "Math", capacity: 30 }), 1)]
            await courseDocProjection.handle(events, { client })

            // Visible within transaction
            const result = await client.query("SELECT data FROM course_docs WHERE _id = 'c1'")
            expect(result.rows).toHaveLength(1)

            await client.query("ROLLBACK")

            // Gone after rollback
            const tableCheck = await pool.query(`
                SELECT EXISTS (
                    SELECT FROM information_schema.tables WHERE table_name = 'course_docs'
                ) as exists
            `)
            expect(tableCheck.rows[0].exists).toBe(false)
        } finally {
            client.release()
        }
    })
})

describe("ProjectionSpec with pongoProjection", () => {
    let pool: Pool

    beforeAll(async () => {
        pool = await getTestPgDatabasePool({ max: 10 })
    })

    afterAll(async () => {
        if (pool) await pool.end()
    })

    test("given/when/then works with pongoProjection", async () => {
        await ProjectionSpec.for({ projection: courseProjection, pool })
            .given([])
            .when([courseWasRegistered({ courseId: "c1", title: "Math", capacity: 30 })])
            .then(async client => {
                const result = await client.query("SELECT data FROM courses WHERE _id = 'c1'")
                expect(result.rows).toHaveLength(1)
                expect(result.rows[0].data.title).toBe("Math")
            })
    })

    test("given events are applied before when events", async () => {
        await ProjectionSpec.for({ projection: courseProjection, pool })
            .given([
                courseWasRegistered({ courseId: "c1", title: "Math", capacity: 30 }),
                studentWasRegistered({ studentId: "s1", name: "Alice", studentNumber: 1 })
            ])
            .when([studentWasSubscribed({ courseId: "c1", studentId: "s1" })])
            .then(async client => {
                const courseResult = await client.query("SELECT data FROM courses WHERE _id = 'c1'")
                expect(courseResult.rows[0].data.subscribedStudents).toEqual(["s1"])

                const studentResult = await client.query("SELECT data FROM students WHERE _id = 's1'")
                expect(studentResult.rows[0].data.subscribedCourses).toEqual(["c1"])
            })
    })

    test("changes are rolled back after assertion", async () => {
        await ProjectionSpec.for({ projection: courseProjection, pool })
            .given([courseWasRegistered({ courseId: "c1", title: "Math", capacity: 30 })])
            .when([])
            .then(async client => {
                const result = await client.query("SELECT count(*) as cnt FROM courses")
                expect(result.rows[0].cnt).toBe("1")
            })

        // After rollback, the table should not exist
        const tableCheck = await pool.query(`
            SELECT EXISTS (
                SELECT FROM information_schema.tables WHERE table_name = 'courses'
            ) as exists
        `)
        expect(tableCheck.rows[0].exists).toBe(false)
    })

    test("ProjectionSpec with pongoDocumentProjection", async () => {
        const courseDocProjection = pongoDocumentProjection<CourseDoc>({
            name: "SpecCourseDocProjection",
            canHandle: ["courseWasRegistered", "studentWasSubscribed"],
            collectionName: "spec_course_docs",
            getDocumentId: event => {
                const data = event.event.data as Record<string, unknown>
                return (data.courseId as string) ?? null
            },
            evolve: (doc, event) => {
                const data = event.event.data as Record<string, unknown>
                switch (event.event.type) {
                    case "courseWasRegistered":
                        return {
                            courseId: data.courseId as string,
                            title: data.title as string,
                            capacity: data.capacity as number,
                            subscribedStudents: []
                        }
                    case "studentWasSubscribed":
                        if (!doc) return null
                        return {
                            ...doc,
                            subscribedStudents: [...doc.subscribedStudents, data.studentId as string]
                        }
                    default:
                        return doc
                }
            }
        })

        await ProjectionSpec.for({ projection: courseDocProjection, pool })
            .given([courseWasRegistered({ courseId: "c1", title: "Math", capacity: 30 })])
            .when([studentWasSubscribed({ courseId: "c1", studentId: "s1" })])
            .then(async client => {
                const result = await client.query("SELECT data FROM spec_course_docs WHERE _id = 'c1'")
                expect(result.rows).toHaveLength(1)
                expect(result.rows[0].data.subscribedStudents).toEqual(["s1"])
            })
    })
})
