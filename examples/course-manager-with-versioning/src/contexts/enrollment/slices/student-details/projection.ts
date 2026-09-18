/* eslint-disable @typescript-eslint/no-explicit-any */
import { Query, SequencedEvent } from "@dcb-es/event-store"
import { pongoProjection, PongoProjectionContext } from "@dcb-es/event-store-postgres"

export interface StudentDoc {
    [key: string]: unknown
    _id?: string
    studentId: string
    name: string
    studentNumber: number
    subscribedCourses: { courseId: string; title: string; capacity: number }[]
}

/** Private lookup — course data owned by this projection, not shared */
interface CourseLookupDoc {
    [key: string]: unknown
    _id?: string
    courseId: string
    title: string
    capacity: number
}

export const STUDENT_PROJECTION_NAME = "StudentDetailsProjection"

export const studentDetailsProjection = pongoProjection({
    name: STUDENT_PROJECTION_NAME,
    canHandle: Query.fromItems([
        {
            types: [
                "studentWasRegistered",
                "courseWasRegistered",
                "courseTitleWasChanged",
                "courseCapacityWasChanged",
                "studentWasSubscribed",
                "studentWasUnsubscribed"
            ]
        }
    ]),
    init: async pongo => {
        const db = pongo.db()
        await db.collection<StudentDoc>("students").createCollection()
        await db.collection<CourseLookupDoc>("_student_projection_courses").createCollection()
    },
    handle: async (events: SequencedEvent[], context: PongoProjectionContext) => {
        const students = context.pongo.db().collection<StudentDoc>("students")
        const courseLookup = context.pongo.db().collection<CourseLookupDoc>("_student_projection_courses")

        for (const sequencedEvent of events) {
            const data = sequencedEvent.event.data as Record<string, unknown>
            switch (sequencedEvent.event.type) {
                case "studentWasRegistered":
                    await students.insertOne({
                        _id: data.studentId as string,
                        studentId: data.studentId as string,
                        name: data.name as string,
                        studentNumber: data.studentNumber as number,
                        subscribedCourses: []
                    })
                    break
                case "courseWasRegistered": {
                    /**
                     * Version-aware course lookup population.
                     * V1/V2 use data.title; V3 uses data.name.
                     */
                    const version = sequencedEvent.schemaVersion ?? "1"
                    const title =
                        version === "3" ? (data.name as string) : (data.title as string)

                    await courseLookup.insertOne({
                        _id: data.courseId as string,
                        courseId: data.courseId as string,
                        title,
                        capacity: data.capacity as number
                    })
                    break
                }
                case "courseTitleWasChanged":
                    await courseLookup.updateOne(
                        { _id: data.courseId as string },
                        { $set: { title: data.newTitle as string } }
                    )
                    break
                case "courseCapacityWasChanged":
                    await courseLookup.updateOne(
                        { _id: data.courseId as string },
                        { $set: { capacity: data.newCapacity as number } }
                    )
                    break
                case "studentWasSubscribed": {
                    const courseId = data.courseId as string
                    const studentId = data.studentId as string
                    const course = await courseLookup.findOne({ _id: courseId })
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
        await db.collection<StudentDoc>("students").deleteMany()
        await db.collection<CourseLookupDoc>("_student_projection_courses").deleteMany()
    }
})
