import { handle } from "@dcb-es/event-store"
import { on, NoContent, withETag, getIdempotencyKey, validateBody, type WebApiSetup } from "@dcb-es/event-store-express"
import type { SliceDependencies } from "../../../../shared/dependencies.js"
import { findExistingPosition } from "../../../../shared/idempotency.js"
import { updateCourseCapacity } from "./decider.js"
import { UpdateCourseCapacitySchema } from "./schema.js"

export function configureChangeCourseCapacityRoute(deps: SliceDependencies): WebApiSetup {
    const { store, pool } = deps

    return router => {
        router.put(
            "/courses/:courseId/capacity",
            validateBody(UpdateCourseCapacitySchema),
            on(async req => {
                const courseId = req.params["courseId"] as string
                const { newCapacity } = req.body
                const idempotencyKey = getIdempotencyKey(req)
                const existingPosition = await findExistingPosition(pool, idempotencyKey)
                const position =
                    existingPosition ??
                    (await handle(
                        store,
                        updateCourseCapacity,
                        { type: "updateCourseCapacity", data: { courseId, newCapacity } },
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
