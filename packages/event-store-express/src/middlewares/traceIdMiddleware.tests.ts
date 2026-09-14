import { describe, it, expect } from "vitest"
import express from "express"
import request from "supertest"
import { traceIdMiddleware } from "./traceIdMiddleware.js"

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function createApp() {
    const app = express()
    app.use(traceIdMiddleware())
    app.get("/test", (_req, res) => {
        res.json({ ok: true })
    })
    return app
}

describe("traceIdMiddleware", () => {
    it("generates a UUID when no x-request-id header is present", async () => {
        const app = createApp()
        const res = await request(app).get("/test")

        expect(res.status).toBe(200)
        expect(res.headers["x-request-id"]).toMatch(UUID_RE)
    })

    it("propagates an incoming x-request-id header", async () => {
        const app = createApp()
        const traceId = "my-custom-trace-id"
        const res = await request(app).get("/test").set("x-request-id", traceId)

        expect(res.headers["x-request-id"]).toBe(traceId)
    })

    it("generates a UUID when x-request-id header is empty", async () => {
        const app = createApp()
        const res = await request(app).get("/test").set("x-request-id", "")

        expect(res.headers["x-request-id"]).toMatch(UUID_RE)
    })
})
