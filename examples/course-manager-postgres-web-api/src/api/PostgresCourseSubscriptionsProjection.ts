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

export interface StudentDoc {
    [key: string]: unknown
    _id?: string
    studentId: string
    name: string
    studentNumber: number
    subscribedCourses: { courseId: string; title: string; capacity: number }[]
}

export const PROJECTION_NAME = "CourseProjection"

export const courseSubscriptionsProjection = pongoProjection({
    name: PROJECTION_NAME,
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

                    // Look up the student to embed in the course document
                    const student = await students.findOne({ _id: studentId })
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

                    // Look up the course to embed in the student document
                    const course = await courses.findOne({ _id: courseId })
                    if (course) {
                        await students.updateOne(
                            { _id: studentId },
                            {
                                $push: {
                                    subscribedCourses: {
                                        courseId: course.courseId,
                                        title: course.title,
                                        capacity: course.capacity
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

                    // Read-modify-write: remove student from course
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

                    // Read-modify-write: remove course from student
                    const student = await students.findOne({ _id: studentId })
                    if (student) {
                        await students.updateOne(
                            { _id: studentId },
                            {
                                $set: {
                                    subscribedCourses: student.subscribedCourses.filter(c => c.courseId !== courseId)
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
        await db.collection<StudentDoc>("students").deleteMany()
    }
})
