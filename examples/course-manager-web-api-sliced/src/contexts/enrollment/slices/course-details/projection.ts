/* eslint-disable @typescript-eslint/no-explicit-any */
import { Query, SequencedEvent } from "@dcb-es/event-store"
import { pongoProjection, PongoProjectionContext } from "@dcb-es/event-store-postgres"

export interface CourseDoc {
    [key: string]: unknown
    _id?: string
    courseId: string
    title: string
    capacity: number
    subscribedStudents: { studentId: string; name: string; studentNumber: number }[]
}

/** Private lookup — student data owned by this projection, not shared */
interface StudentLookupDoc {
    [key: string]: unknown
    _id?: string
    studentId: string
    name: string
    studentNumber: number
}

export const COURSE_PROJECTION_NAME = "CourseDetailsProjection"

export const courseDetailsProjection = pongoProjection({
    name: COURSE_PROJECTION_NAME,
    canHandle: Query.fromItems([
        {
            types: [
                "courseWasRegistered",
                "courseTitleWasChanged",
                "courseCapacityWasChanged",
                "studentWasRegistered",
                "studentWasSubscribed",
                "studentWasUnsubscribed"
            ]
        }
    ]),
    init: async pongo => {
        const db = pongo.db()
        await db.collection<CourseDoc>("courses").createCollection()
        await db.collection<StudentLookupDoc>("_course_projection_students").createCollection()
    },
    handle: async (events: SequencedEvent[], context: PongoProjectionContext) => {
        const courses = context.pongo.db().collection<CourseDoc>("courses")
        const studentLookup = context.pongo.db().collection<StudentLookupDoc>("_course_projection_students")

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
                case "courseTitleWasChanged":
                    await courses.updateOne(
                        { _id: data.courseId as string },
                        { $set: { title: data.newTitle as string } }
                    )
                    break
                case "courseCapacityWasChanged":
                    await courses.updateOne(
                        { _id: data.courseId as string },
                        { $set: { capacity: data.newCapacity as number } }
                    )
                    break
                case "studentWasRegistered":
                    await studentLookup.insertOne({
                        _id: data.studentId as string,
                        studentId: data.studentId as string,
                        name: data.name as string,
                        studentNumber: data.studentNumber as number
                    })
                    break
                case "studentWasSubscribed": {
                    const courseId = data.courseId as string
                    const studentId = data.studentId as string
                    const student = await studentLookup.findOne({ _id: studentId })
                    if (student) {
                        await courses.updateOne(
                            { _id: courseId },
                            {
                                $push: {
                                    subscribedStudents: {
                                        studentId: student.studentId,
                                        name: student.name,
                                        studentNumber: student.studentNumber
                                    }
                                } as any
                            }
                        )
                    }
                    break
                }
                case "studentWasUnsubscribed": {
                    const courseId = data.courseId as string
                    const studentId = data.studentId as string
                    const course = await courses.findOne({ _id: courseId })
                    if (course) {
                        await courses.updateOne(
                            { _id: courseId },
                            {
                                $set: {
                                    subscribedStudents: course.subscribedStudents.filter(s => s.studentId !== studentId)
                                }
                            }
                        )
                    }
                    break
                }
            }
        }
    },
    truncate: async pongo => {
        const db = pongo.db()
        await db.collection<CourseDoc>("courses").deleteMany()
        await db.collection<StudentLookupDoc>("_course_projection_students").deleteMany()
    }
})
