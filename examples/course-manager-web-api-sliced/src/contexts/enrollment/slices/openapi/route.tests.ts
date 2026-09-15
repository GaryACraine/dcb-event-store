import { describe, test } from "vitest"
import type { Pool } from "pg"
import { ApiSpecification, expectResponse } from "@dcb-es/event-store-express"
import type { EventStore } from "@dcb-es/event-store"
import { configureOpenApiRoute } from "./route.js"

const spec = ApiSpecification.for({
    configureApi: (_store: EventStore) => configureOpenApiRoute()
})

describe("GET /openapi.json", () => {
    test("returns a valid OpenAPI 3.1.0 document", async () => {
        await spec.when(agent => agent.get("/openapi.json")).then(expectResponse(200, { body: { openapi: "3.1.0" } }))
    })
})
