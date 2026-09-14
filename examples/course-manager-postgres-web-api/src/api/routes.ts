import { handle } from "@dcb-es/event-store"
import type { EventStore } from "@dcb-es/event-store"
import {
    on,
    Created,
    NoContent,
    OK,
    sseEventFeed,
    preferWait,
    withETag,
    type WebApiSetup,
    type WaitFunction
} from "@dcb-es/event-store-express"
import type { Pool } from "pg"
import {
    registerCourse,
    registerStudent,
    updateCourseCapacity,
    subscribeStudentToCourse,
    unsubscribeStudentFromCourse
} from "./Deciders.js"
import type { CourseDoc, StudentDoc } from "./PostgresCourseSubscriptionsProjection.js"

export interface RouteDependencies {
    store: EventStore
    pool: Pool
    waitFn?: WaitFunction
}

export function configureRoutes(deps: RouteDependencies): WebApiSetup {
    const { store, pool, waitFn } = deps
    return router => {
        // Apply preferWait middleware to all routes when waitFn is provided
        if (waitFn) {
            router.use(preferWait({ waitFn }))
        }

        // Write routes
        router.post(
            "/courses",
            on(async req => {
                const { id, title, capacity } = req.body as { id: string; title: string; capacity: number }
                await handle(store, registerCourse, { type: "registerCourse", data: { id, title, capacity } })
                return Created({ createdId: id })
            })
        )

        router.post(
            "/students",
            on(async req => {
                const { id, name } = req.body as { id: string; name: string }
                await handle(store, registerStudent, { type: "registerStudent", data: { id, name } })
                return Created({ createdId: id })
            })
        )

        router.put(
            "/courses/:courseId/capacity",
            on(async req => {
                const courseId = req.params["courseId"] as string
                const { newCapacity } = req.body as { newCapacity: number }
                await handle(store, updateCourseCapacity, {
                    type: "updateCourseCapacity",
                    data: { courseId, newCapacity }
                })
                return NoContent()
            })
        )

        router.post(
            "/courses/:courseId/subscriptions",
            on(async req => {
                const courseId = req.params["courseId"] as string
                const { studentId } = req.body as { studentId: string }
                await handle(store, subscribeStudentToCourse, {
                    type: "subscribeStudentToCourse",
                    data: { courseId, studentId }
                })
                return Created({ url: `/courses/${courseId}/subscriptions/${studentId}` })
            })
        )

        router.delete(
            "/courses/:courseId/subscriptions/:studentId",
            on(async req => {
                const courseId = req.params["courseId"] as string
                const studentId = req.params["studentId"] as string
                await handle(store, unsubscribeStudentFromCourse, {
                    type: "unsubscribeStudentFromCourse",
                    data: { courseId, studentId }
                })
                return NoContent()
            })
        )

        // Read routes
        router.get(
            "/courses",
            on(async () => {
                const result = await pool.query<{ data: CourseDoc; _id: string }>("SELECT _id, data FROM courses")
                const courses = result.rows.map(row => ({
                    id: row.data.courseId,
                    title: row.data.title,
                    capacity: row.data.capacity,
                    subscribedStudents: row.data.subscribedStudents
                }))
                return OK({ body: courses })
            })
        )

        router.get(
            "/courses/:courseId",
            on(async req => {
                const courseId = req.params["courseId"] as string
                const result = await pool.query<{ data: CourseDoc }>("SELECT data FROM courses WHERE _id = $1", [
                    courseId
                ])
                if (result.rows.length === 0) {
                    return res => res.status(404).json({ status: 404, title: "Not Found", detail: "Course not found" })
                }
                const doc = result.rows[0].data
                return res => {
                    withETag(doc.courseId)(res)
                    OK({
                        body: {
                            id: doc.courseId,
                            title: doc.title,
                            capacity: doc.capacity,
                            subscribedStudents: doc.subscribedStudents
                        }
                    })(res)
                }
            })
        )

        router.get(
            "/students/:studentId",
            on(async req => {
                const studentId = req.params["studentId"] as string
                const result = await pool.query<{ data: StudentDoc }>("SELECT data FROM students WHERE _id = $1", [
                    studentId
                ])
                if (result.rows.length === 0) {
                    return res => res.status(404).json({ status: 404, title: "Not Found", detail: "Student not found" })
                }
                const doc = result.rows[0].data
                return res => {
                    withETag(doc.studentId)(res)
                    OK({
                        body: {
                            id: doc.studentId,
                            name: doc.name,
                            studentNumber: doc.studentNumber,
                            subscribedCourses: doc.subscribedCourses
                        }
                    })(res)
                }
            })
        )

        // SSE event feed
        router.get("/events", sseEventFeed(store))
    }
}
