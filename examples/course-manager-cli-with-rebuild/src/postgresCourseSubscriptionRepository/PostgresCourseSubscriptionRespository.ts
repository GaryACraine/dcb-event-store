import { Pool, PoolClient } from "pg"
import type { CourseDoc, StudentDoc } from "../api/PostgresCourseSubscriptionsProjection.js"

export const STUDENT_SUBSCRIPTION_LIMIT = 5

/*
    This repository reads from the Pongo JSONB collections (courses, students)
    that the pongoProjection writes to. No relational tables — the data lives
    in JSONB `data` columns managed by Pongo.
*/

export interface Course {
    id: string
    title: string
    capacity: number
    subscribedStudents: Omit<Student, "subscribedCourses">[]
}

export interface Student {
    id: string
    name: string
    studentNumber: number
    subscribedCourses: Omit<Course, "subscribedStudents">[]
}

export const PongoCourseSubscriptionsRepository = (client: Pool | PoolClient) => {
    return {
        findCourseById: async (courseId: string): Promise<Course | undefined> => {
            const result = await client.query("SELECT data FROM courses WHERE _id = $1", [courseId])

            if (result.rows.length === 0) {
                return undefined
            }

            const doc: CourseDoc = result.rows[0].data

            return {
                id: doc.courseId,
                title: doc.title,
                capacity: doc.capacity,
                subscribedStudents: doc.subscribedStudents.map(s => ({
                    id: s.studentId,
                    name: s.name,
                    studentNumber: s.studentNumber
                }))
            }
        },

        findStudentById: async (studentId: string): Promise<Student | undefined> => {
            const result = await client.query("SELECT data FROM students WHERE _id = $1", [studentId])

            if (result.rows.length === 0) {
                return undefined
            }

            const doc: StudentDoc = result.rows[0].data

            return {
                id: doc.studentId,
                name: doc.name,
                studentNumber: doc.studentNumber,
                subscribedCourses: doc.subscribedCourses.map(c => ({
                    id: c.courseId,
                    title: c.title,
                    capacity: c.capacity
                }))
            }
        }
    }
}
