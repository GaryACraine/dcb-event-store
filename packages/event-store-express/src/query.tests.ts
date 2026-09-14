import { describe, it, expect } from "vitest"
import express from "express"
import request from "supertest"
import { SequencePosition } from "@dcb-es/event-store"
import { withETag, parsePageParams } from "./query.js"
import { on } from "./handler.js"
import { OK } from "./responses.js"

describe("withETag", () => {
    it("sets ETag header from SequencePosition", async () => {
        const position = SequencePosition.fromString("42")
        const app = express()
        app.get(
            "/test",
            on(() => {
                const setEtag = withETag(position)
                return (res: express.Response) => {
                    setEtag(res)
                    res.status(200).json({ ok: true })
                }
            })
        )

        const res = await request(app).get("/test")
        expect(res.headers["etag"]).toBe('"42"')
    })

    it("sets ETag header from string", async () => {
        const app = express()
        app.get(
            "/test",
            on(() => {
                const setEtag = withETag("99")
                return (res: express.Response) => {
                    setEtag(res)
                    res.status(200).json({ ok: true })
                }
            })
        )

        const res = await request(app).get("/test")
        expect(res.headers["etag"]).toBe('"99"')
    })
})

describe("parsePageParams", () => {
    function createApp() {
        const app = express()
        app.get(
            "/test",
            on(req => {
                const params = parsePageParams(req)
                return OK({
                    body: {
                        after: params.after?.toString() ?? null,
                        limit: params.limit
                    }
                })
            })
        )
        return app
    }

    it("returns default limit when no params provided", async () => {
        const app = createApp()
        const res = await request(app).get("/test")

        expect(res.status).toBe(200)
        expect(res.body.after).toBeNull()
        expect(res.body.limit).toBe(50)
    })

    it("parses ?after= as SequencePosition", async () => {
        const app = createApp()
        const res = await request(app).get("/test?after=10")

        expect(res.status).toBe(200)
        expect(res.body.after).toBe("10")
    })

    it("parses ?limit= and applies it", async () => {
        const app = createApp()
        const res = await request(app).get("/test?limit=25")

        expect(res.status).toBe(200)
        expect(res.body.limit).toBe(25)
    })

    it("caps limit at max (200)", async () => {
        const app = createApp()
        const res = await request(app).get("/test?limit=999")

        expect(res.status).toBe(200)
        expect(res.body.limit).toBe(200)
    })

    it("ignores invalid ?after= value and returns undefined", async () => {
        const app = createApp()
        const res = await request(app).get("/test?after=notanumber")

        expect(res.status).toBe(200)
        expect(res.body.after).toBeNull()
    })

    it("ignores invalid ?limit= value and uses default", async () => {
        const app = createApp()
        const res = await request(app).get("/test?limit=abc")

        expect(res.status).toBe(200)
        expect(res.body.limit).toBe(50)
    })

    it("parses both ?after= and ?limit= together", async () => {
        const app = createApp()
        const res = await request(app).get("/test?after=5&limit=100")

        expect(res.status).toBe(200)
        expect(res.body.after).toBe("5")
        expect(res.body.limit).toBe(100)
    })
})
