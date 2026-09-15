import { describe, test } from "vitest"
import { ApiSpecification, expectResponse } from "@dcb-es/event-store-express"
import { configureOpenApiRoute } from "./route.js"

const spec = ApiSpecification.for({
    configureApi: () => configureOpenApiRoute()
})

describe("GET /openapi.json", () => {
    test("returns a valid OpenAPI 3.1.0 document", async () => {
        await spec.when(agent => agent.get("/openapi.json")).then(expectResponse(200, { body: { openapi: "3.1.0" } }))
    })
})
