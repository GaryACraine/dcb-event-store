import { Query } from "@dcb-es/event-store"
import { rawSqlProjection } from "@dcb-es/event-store-postgres"
import { PostgresCourseSubscriptionsRepository } from "../postgresCourseSubscriptionRepository/PostgresCourseSubscriptionRespository.js"

export const courseSubscriptionsProjection = rawSqlProjection({
    name: "CourseProjection",
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
    init: async client => {
        await client.query(`
            CREATE TABLE IF NOT EXISTS courses (
                id TEXT,
                title TEXT NOT NULL,
                capacity INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS students (
                id TEXT,
                name TEXT NOT NULL,
                student_number integer NOT NULL
            );
            CREATE TABLE IF NOT EXISTS subscriptions (
                course_id TEXT,
                student_id TEXT
            );
        `)
    },
    evolve: async (event, client) => {
        const repo = PostgresCourseSubscriptionsRepository(client)
        const data = event.event.data as Record<string, unknown>
        switch (event.event.type) {
            case "courseWasRegistered":
                await repo.registerCourse({
                    courseId: data.courseId as string,
                    title: data.title as string,
                    capacity: data.capacity as number
                })
                break
            case "courseTitleWasChanged":
                await repo.updateCourseTitle({
                    courseId: data.courseId as string,
                    newTitle: data.newTitle as string
                })
                break
            case "courseCapacityWasChanged":
                await repo.updateCourseCapacity({
                    courseId: data.courseId as string,
                    newCapacity: data.newCapacity as number
                })
                break
            case "studentWasRegistered":
                await repo.registerStudent({
                    studentId: data.studentId as string,
                    name: data.name as string,
                    studentNumber: data.studentNumber as number
                })
                break
            case "studentWasSubscribed":
                await repo.subscribeStudentToCourse({
                    studentId: data.studentId as string,
                    courseId: data.courseId as string
                })
                break
            case "studentWasUnsubscribed":
                await repo.unsubscribeStudentFromCourse({
                    studentId: data.studentId as string,
                    courseId: data.courseId as string
                })
                break
        }
    },
    truncate: async client => {
        await client.query("TRUNCATE courses, students, subscriptions")
    }
})
