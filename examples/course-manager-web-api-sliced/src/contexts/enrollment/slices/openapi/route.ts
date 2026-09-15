import type { WebApiSetup } from "@dcb-es/event-store-express"
import { buildOpenApiDocument } from "./document.js"

export function configureOpenApiRoute(): WebApiSetup {
    const openApiDoc = buildOpenApiDocument()

    return router => {
        router.get("/openapi.json", (_req, res) => res.json(openApiDoc))
    }
}
