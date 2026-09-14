import { describe, it, expect } from "vitest"
import express from "express"
import request from "supertest"
import { on } from "./handler.js"
import { OK, Created, Accepted, NoContent, sendProblem } from "./responses.js"

function createApp(handler: Parameters<typeof on>[0]) {
    const app = express()
    app.get("/test", on(handler))
    return app
}

describe("response helpers", () => {
    describe("OK", () => {
        it("returns 200 with a JSON body", async () => {
            const app = createApp(() => OK({ body: { items: [1, 2, 3] } }))
            const res = await request(app).get("/test")

            expect(res.status).toBe(200)
            expect(res.body).toEqual({ items: [1, 2, 3] })
        })

        it("returns 200 with no body", async () => {
            const app = createApp(() => OK())
            const res = await request(app).get("/test")

            expect(res.status).toBe(200)
        })
    })

    describe("Created", () => {
        it("returns 201 with Location from createdId", async () => {
            const app = createApp(() => Created({ createdId: "abc-123" }))
            const res = await request(app).get("/test")

            expect(res.status).toBe(201)
            expect(res.headers["location"]).toBe("/api/abc-123")
            expect(res.body).toEqual({ id: "abc-123" })
        })

        it("returns 201 with Location from url", async () => {
            const app = createApp(() => Created({ url: "/orders/42" }))
            const res = await request(app).get("/test")

            expect(res.status).toBe(201)
            expect(res.headers["location"]).toBe("/orders/42")
        })

        it("uses explicit location over createdId", async () => {
            const app = createApp(() =>
                Created({ createdId: "abc", location: "/custom/path" })
            )
            const res = await request(app).get("/test")

            expect(res.status).toBe(201)
            expect(res.headers["location"]).toBe("/custom/path")
            expect(res.body).toEqual({ id: "abc" })
        })

        it("uses explicit body over default", async () => {
            const app = createApp(() =>
                Created({ createdId: "abc", body: { custom: true } })
            )
            const res = await request(app).get("/test")

            expect(res.status).toBe(201)
            expect(res.body).toEqual({ custom: true })
        })
    })

    describe("Accepted", () => {
        it("returns 202 with Location header", async () => {
            const app = createApp(() =>
                Accepted({ location: "/jobs/42/status" })
            )
            const res = await request(app).get("/test")

            expect(res.status).toBe(202)
            expect(res.headers["location"]).toBe("/jobs/42/status")
        })

        it("returns 202 with body", async () => {
            const app = createApp(() =>
                Accepted({ location: "/jobs/42/status", body: { jobId: "42" } })
            )
            const res = await request(app).get("/test")

            expect(res.status).toBe(202)
            expect(res.body).toEqual({ jobId: "42" })
        })
    })

    describe("NoContent", () => {
        it("returns 204 with no body", async () => {
            const app = createApp(() => NoContent())
            const res = await request(app).get("/test")

            expect(res.status).toBe(204)
            expect(res.text).toBe("")
        })

        it("returns 204 with Location header", async () => {
            const app = createApp(() => NoContent({ location: "/next" }))
            const res = await request(app).get("/test")

            expect(res.status).toBe(204)
            expect(res.headers["location"]).toBe("/next")
        })
    })

    describe("sendProblem", () => {
        it("sends application/problem+json with status", async () => {
            const app = express()
            app.get("/test", (_req, res) => {
                sendProblem(res, 422, {
                    type: "https://example.com/validation",
                    title: "Validation Error",
                    status: 422,
                    detail: "Name is required"
                })
            })

            const res = await request(app).get("/test")

            expect(res.status).toBe(422)
            expect(res.headers["content-type"]).toContain("application/problem+json")
            expect(res.body.title).toBe("Validation Error")
            expect(res.body.detail).toBe("Name is required")
        })
    })
})
