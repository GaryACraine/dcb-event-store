import { handle } from "@dcb-es/event-store"
import { on, Created, withETag, getIdempotencyKey, validateBody, type WebApiSetup } from "@dcb-es/event-store-express"
import type { SliceDependencies } from "../../../../shared/dependencies.js"
import { findExistingPosition } from "../../../../shared/idempotency.js"
import { registerStudent } from "./decider.js"
import { RegisterStudentSchema } from "./schema.js"

export function configureRegisterStudentRoute(deps: SliceDependencies): WebApiSetup {
    const { store, pool } = deps

    return router => {
        router.post(
            "/students",
            validateBody(RegisterStudentSchema),
            on(async req => {
                const { id, name } = req.body
                const idempotencyKey = getIdempotencyKey(req)
                const existingPosition = await findExistingPosition(pool, idempotencyKey)
                const position =
                    existingPosition ??
                    (await handle(
                        store,
                        registerStudent,
                        { type: "registerStudent", data: { id, name } },
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
