import { handle } from "@dcb-es/event-store"
import { on, NoContent, withETag, getIdempotencyKey, type WebApiSetup } from "@dcb-es/event-store-express"
import type { SliceDependencies } from "../../../../shared/dependencies.js"
import { findExistingPosition } from "../../../../shared/idempotency.js"
import { unsubscribeStudentFromCourse } from "./decider.js"

export function configureUnsubscribeStudentRoute(deps: SliceDependencies): WebApiSetup {
    const { store, pool } = deps

    return router => {
        router.delete(
            "/courses/:courseId/subscriptions/:studentId",
            on(async req => {
                const courseId = req.params["courseId"] as string
                const studentId = req.params["studentId"] as string
                const idempotencyKey = getIdempotencyKey(req)
                const existingPosition = await findExistingPosition(pool, idempotencyKey)
                const position =
                    existingPosition ??
                    (await handle(
                        store,
                        unsubscribeStudentFromCourse,
                        { type: "unsubscribeStudentFromCourse", data: { courseId, studentId } },
                        { idempotencyKey }
                    ))
                return res => {
                    withETag(position)(res)
                    NoContent()(res)
                }
            })
        )
    }
}
