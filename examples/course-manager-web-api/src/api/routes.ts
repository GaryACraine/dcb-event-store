import { handle } from "@dcb-es/event-store"
import type { EventStore } from "@dcb-es/event-store"
import { on, Created, NoContent, type WebApiSetup } from "@dcb-es/event-store-express"
import {
    registerCourse,
    registerStudent,
    updateCourseCapacity,
    updateCourseTitle,
    subscribeStudentToCourse,
    unsubscribeStudentFromCourse
} from "./Deciders.js"

export function configureRoutes(store: EventStore): WebApiSetup {
    return router => {
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
                const { courseId } = req.params
                const { newCapacity } = req.body as { newCapacity: number }
                await handle(store, updateCourseCapacity, {
                    type: "updateCourseCapacity",
                    data: { courseId, newCapacity }
                })
                return NoContent()
            })
        )

        router.put(
            "/courses/:courseId/title",
            on(async req => {
                const { courseId } = req.params
                const { newTitle } = req.body as { newTitle: string }
                await handle(store, updateCourseTitle, {
                    type: "updateCourseTitle",
                    data: { courseId, newTitle }
                })
                return NoContent()
            })
        )

        router.post(
            "/courses/:courseId/subscriptions",
            on(async req => {
                const { courseId } = req.params
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
                const { courseId, studentId } = req.params
                await handle(store, unsubscribeStudentFromCourse, {
                    type: "unsubscribeStudentFromCourse",
                    data: { courseId, studentId }
                })
                return NoContent()
            })
        )
    }
}
