import { handle } from "@dcb-es/event-store"
import { on, Created, withETag, getIdempotencyKey, validateBody, type WebApiSetup } from "@dcb-es/event-store-express"
import type { SliceDependencies } from "../../../../shared/dependencies.js"
import { findExistingPosition } from "../../../../shared/idempotency.js"
import { registerCourse } from "./decider.js"
import { RegisterCourseSchema } from "./schema.js"

export function configureRegisterCourseRoute(deps: SliceDependencies): WebApiSetup {
    const { store, pool } = deps

    return router => {
        router.post(
            "/courses",
            validateBody(RegisterCourseSchema),
            on(async req => {
                const { id, name, description, capacity, department } = req.body
                const idempotencyKey = getIdempotencyKey(req)
                const existingPosition = await findExistingPosition(pool, idempotencyKey)
                const position =
                    existingPosition ??
                    (await handle(
                        store,
                        registerCourse,
                        { type: "registerCourse", data: { id, name, description, capacity, department } },
                        { idempotencyKey }
                    ))
                return res => {
                    withETag(position)(res)
                    Created({ createdId: id })(res)
                }
            })
        )
    }
}
