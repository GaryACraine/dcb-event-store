import { describe, it, expect } from "vitest"
import express from "express"
import request from "supertest"
import { on } from "./handler.js"

describe("on() handler wrapper", () => {
    it("handles a synchronous handler", async () => {
        const app = express()
        app.get(
            "/test",
            on(() => (res) => {
                res.status(200).json({ ok: true })
            })
        )

        const res = await request(app).get("/test")

        expect(res.status).toBe(200)
        expect(res.body).toEqual({ ok: true })
    })

    it("handles an async handler", async () => {
        const app = express()
        app.get(
            "/test",
            on(async () => {
                await Promise.resolve()
                return (res) => {
                    res.status(200).json({ async: true })
                }
            })
        )

        const res = await request(app).get("/test")

        expect(res.status).toBe(200)
        expect(res.body).toEqual({ async: true })
    })

    it("forwards thrown errors to next()", async () => {
        const app = express()
        app.get(
            "/test",
            on(() => {
                throw new Error("sync boom")
            })
        )
        app.use(
            (
                err: Error,
                _req: express.Request,
                res: express.Response,
                _next: express.NextFunction
            ) => {
                res.status(500).json({ error: err.message })
            }
        )

        const res = await request(app).get("/test")

        expect(res.status).toBe(500)
        expect(res.body.error).toBe("sync boom")
    })

    it("forwards async rejections to next()", async () => {
        const app = express()
        app.get(
            "/test",
            on(async () => {
                throw new Error("async boom")
            })
        )
        app.use(
            (
                err: Error,
                _req: express.Request,
                res: express.Response,
                _next: express.NextFunction
            ) => {
                res.status(500).json({ error: err.message })
            }
        )

        const res = await request(app).get("/test")

        expect(res.status).toBe(500)
        expect(res.body.error).toBe("async boom")
    })
})
