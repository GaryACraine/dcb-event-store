import { describe, it, expect } from "vitest"
import express from "express"
import request from "supertest"
import { NotFoundError, ValidationError, AppendConditionError, Query } from "@dcb-es/event-store"
import { problemDetailsMiddleware } from "./problemDetailsMiddleware.js"

function createApp(routeError: unknown, mapError?: Parameters<typeof problemDetailsMiddleware>[0]) {
    const app = express()
    app.get("/test", (_req, _res, next) => {
        next(routeError)
    })
    app.use(problemDetailsMiddleware(mapError))
    return app
}

describe("problemDetailsMiddleware", () => {
    it("returns 500 with problem+json for a plain Error", async () => {
        const app = createApp(new Error("Something broke"))
        const res = await request(app).get("/test")

        expect(res.status).toBe(500)
        expect(res.headers["content-type"]).toContain("application/problem+json")
        expect(res.body.status).toBe(500)
        expect(res.body.title).toBe("Internal Server Error")
        expect(res.body.detail).toBe("Something broke")
    })

    it("returns 404 for NotFoundError", async () => {
        const app = createApp(new NotFoundError("Course not found"))
        const res = await request(app).get("/test")

        expect(res.status).toBe(404)
        expect(res.headers["content-type"]).toContain("application/problem+json")
        expect(res.body.status).toBe(404)
        expect(res.body.title).toBe("Not Found")
        expect(res.body.detail).toBe("Course not found")
    })

    it("returns 400 for ValidationError", async () => {
        const app = createApp(new ValidationError("Name is required"))
        const res = await request(app).get("/test")

        expect(res.status).toBe(400)
        expect(res.body.status).toBe(400)
        expect(res.body.title).toBe("Bad Request")
        expect(res.body.detail).toBe("Name is required")
    })

    it("returns 409 for AppendConditionError", async () => {
        const error = new AppendConditionError({
            failIfEventsMatch: Query.fromItems([{ types: ["TestEvent"] }]),
            after: 0n
        })
        const app = createApp(error)
        const res = await request(app).get("/test")

        expect(res.status).toBe(409)
        expect(res.body.status).toBe(409)
        expect(res.body.title).toBe("Conflict")
    })

    it("uses custom mapError override", async () => {
        const app = createApp(new NotFoundError("Not found"), () => ({
            type: "https://example.com/custom",
            title: "Custom Problem",
            status: 404,
            detail: "Custom detail"
        }))
        const res = await request(app).get("/test")

        expect(res.status).toBe(404)
        expect(res.body.type).toBe("https://example.com/custom")
        expect(res.body.title).toBe("Custom Problem")
        expect(res.body.detail).toBe("Custom detail")
    })

    it("returns 500 for non-Error thrown value", async () => {
        const app = createApp("a string error")
        const res = await request(app).get("/test")

        expect(res.status).toBe(500)
        expect(res.body.status).toBe(500)
        expect(res.body.title).toBe("Internal Server Error")
        expect(res.body.detail).toBe("a string error")
    })
})
