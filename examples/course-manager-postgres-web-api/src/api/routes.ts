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
    parsePageParams,
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
import { PROJECTION_NAME } from "./PostgresCourseSubscriptionsProjection.js"
import type { CourseDoc, StudentDoc } from "./PostgresCourseSubscriptionsProjection.js"

export interface RouteDependencies {
    store: EventStore
    pool: Pool
    waitFn?: WaitFunction
}

export function configureRoutes(deps: RouteDependencies): WebApiSetup {
    const { store, pool, waitFn } = deps

    const getBookmarkPosition = async (): Promise<string> => {
        const r = await pool.query<{ last_sequence_position: string }>(
            "SELECT last_sequence_position FROM _handler_bookmarks WHERE handler_id = $1",
            [PROJECTION_NAME]
        )
        return r.rows[0]?.last_sequence_position?.toString() ?? "0"
    }

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
                const position = await handle(store, registerCourse, {
                    type: "registerCourse",
                    data: { id, title, capacity }
                })
                return res => {
                    withETag(position)(res)
                    Created({ createdId: id })(res)
                }
            })
        )

        router.post(
            "/students",
            on(async req => {
                const { id, name } = req.body as { id: string; name: string }
                const position = await handle(store, registerStudent, { type: "registerStudent", data: { id, name } })
                return res => {
                    withETag(position)(res)
                    Created({ createdId: id })(res)
                }
            })
        )

        router.put(
            "/courses/:courseId/capacity",
            on(async req => {
                const courseId = req.params["courseId"] as string
                const { newCapacity } = req.body as { newCapacity: number }
                const position = await handle(store, updateCourseCapacity, {
                    type: "updateCourseCapacity",
                    data: { courseId, newCapacity }
                })
                return res => {
                    withETag(position)(res)
                    NoContent()(res)
                }
            })
        )

        router.post(
            "/courses/:courseId/subscriptions",
            on(async req => {
                const courseId = req.params["courseId"] as string
                const { studentId } = req.body as { studentId: string }
                const position = await handle(store, subscribeStudentToCourse, {
                    type: "subscribeStudentToCourse",
                    data: { courseId, studentId }
                })
                return res => {
                    withETag(position)(res)
                    Created({ url: `/courses/${courseId}/subscriptions/${studentId}` })(res)
                }
            })
        )

        router.delete(
            "/courses/:courseId/subscriptions/:studentId",
            on(async req => {
                const courseId = req.params["courseId"] as string
                const studentId = req.params["studentId"] as string
                const position = await handle(store, unsubscribeStudentFromCourse, {
                    type: "unsubscribeStudentFromCourse",
                    data: { courseId, studentId }
                })
                return res => {
                    withETag(position)(res)
                    NoContent()(res)
                }
            })
        )

        // Read routes
        router.get(
            "/courses",
            on(async req => {
                const { limit } = parsePageParams(req)
                const cursor = typeof req.query["cursor"] === "string" ? req.query["cursor"] : undefined

                let result: { rows: { _id: string; data: CourseDoc }[] }
                if (cursor) {
                    result = await pool.query<{ _id: string; data: CourseDoc }>(
                        "SELECT _id, data FROM courses WHERE _id > $1 ORDER BY _id LIMIT $2",
                        [cursor, limit]
                    )
                } else {
                    result = await pool.query<{ _id: string; data: CourseDoc }>(
                        "SELECT _id, data FROM courses ORDER BY _id LIMIT $1",
                        [limit]
                    )
                }

                const courses = result.rows.map(row => ({
                    id: row.data.courseId,
                    title: row.data.title,
                    capacity: row.data.capacity,
                    subscribedStudents: row.data.subscribedStudents
                }))

                const nextCursor = result.rows.length === limit ? result.rows[result.rows.length - 1]._id : undefined

                const body: { data: typeof courses; cursor?: string } = {
                    data: courses,
                    ...(nextCursor && { cursor: nextCursor })
                }

                const bookmarkPosition = await getBookmarkPosition()
                return res => {
                    withETag(bookmarkPosition)(res)
                    OK({ body })(res)
                }
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
                const bookmarkPosition = await getBookmarkPosition()
                return res => {
                    withETag(bookmarkPosition)(res)
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
                const bookmarkPosition = await getBookmarkPosition()
                return res => {
                    withETag(bookmarkPosition)(res)
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
