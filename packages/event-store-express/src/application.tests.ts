import { describe, it, expect } from "vitest"
import request from "supertest"
import { NotFoundError } from "@dcb-es/event-store"
import { on } from "./handler.js"
import { OK, Created, NoContent } from "./responses.js"
import { getApplication } from "./application.js"

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

describe("getApplication", () => {
    it("parses JSON bodies by default", async () => {
        const app = getApplication({
            apis: [
                router => {
                    router.post(
                        "/echo",
                        on(req => OK({ body: req.body }))
                    )
                }
            ]
        })

        const res = await request(app).post("/echo").send({ hello: "world" })

        expect(res.status).toBe(200)
        expect(res.body).toEqual({ hello: "world" })
    })

    it("can disable JSON body parsing", async () => {
        const app = getApplication({
            disableJsonMiddleware: true,
            apis: [
                router => {
                    router.post(
                        "/echo",
                        on(req => OK({ body: req.body }))
                    )
                }
            ]
        })

        const res = await request(app).post("/echo").send({ hello: "world" })

        expect(res.status).toBe(200)
        expect(res.body).toEqual({})
    })

    it("catches errors via problem details middleware", async () => {
        const app = getApplication({
            apis: [
                router => {
                    router.get(
                        "/fail",
                        on(() => {
                            throw new NotFoundError("Thing not found")
                        })
                    )
                }
            ]
        })

        const res = await request(app).get("/fail")

        expect(res.status).toBe(404)
        expect(res.headers["content-type"]).toContain("application/problem+json")
        expect(res.body.title).toBe("Not Found")
        expect(res.body.detail).toBe("Thing not found")
    })

    it("responds to GET /health/live with 200", async () => {
        const app = getApplication({ apis: [] })
        const res = await request(app).get("/health/live")

        expect(res.status).toBe(200)
        expect(res.body).toEqual({ status: "ok" })
    })

    it("responds to GET /health/ready with 200", async () => {
        const app = getApplication({ apis: [] })
        const res = await request(app).get("/health/ready")

        expect(res.status).toBe(200)
        expect(res.body).toEqual({ status: "ok" })
    })

    it("includes x-request-id header by default", async () => {
        const app = getApplication({ apis: [] })
        const res = await request(app).get("/health/live")

        expect(res.headers["x-request-id"]).toMatch(UUID_RE)
    })

    it("can disable trace-id middleware", async () => {
        const app = getApplication({
            disableTraceIdMiddleware: true,
            apis: []
        })

        const res = await request(app).get("/health/live")

        expect(res.headers["x-request-id"]).toBeUndefined()
    })

    it("disables Express ETags by default", async () => {
        const app = getApplication({
            apis: [
                router => {
                    router.get(
                        "/data",
                        on(() => OK({ body: { value: 1 } }))
                    )
                }
            ]
        })

        const res = await request(app).get("/data")

        expect(res.headers["etag"]).toBeUndefined()
    })

    it("can enable default Express ETags", async () => {
        const app = getApplication({
            enableDefaultExpressEtag: true,
            apis: [
                router => {
                    router.get(
                        "/data",
                        on(() => OK({ body: { value: 1 } }))
                    )
                }
            ]
        })

        const res = await request(app).get("/data")

        expect(res.headers["etag"]).toBeDefined()
    })

    it("passes custom mapError to problem details middleware", async () => {
        const app = getApplication({
            mapError: () => ({
                type: "https://example.com/custom",
                title: "Custom",
                status: 418,
                detail: "I am a teapot"
            }),
            apis: [
                router => {
                    router.get(
                        "/fail",
                        on(() => {
                            throw new Error("boom")
                        })
                    )
                }
            ]
        })

        const res = await request(app).get("/fail")

        expect(res.status).toBe(418)
        expect(res.body.type).toBe("https://example.com/custom")
        expect(res.body.title).toBe("Custom")
    })

    it("works end-to-end with on() and response helpers", async () => {
        const app = getApplication({
            apis: [
                router => {
                    router.get(
                        "/items",
                        on(() => OK({ body: [{ id: 1 }] }))
                    )
                    router.post(
                        "/items",
                        on(() => Created({ createdId: "new-1" }))
                    )
                    router.delete(
                        "/items/:id",
                        on(() => NoContent())
                    )
                }
            ]
        })

        const listRes = await request(app).get("/items")
        expect(listRes.status).toBe(200)
        expect(listRes.body).toEqual([{ id: 1 }])

        const createRes = await request(app).post("/items").send({})
        expect(createRes.status).toBe(201)
        expect(createRes.headers["location"]).toBe("/api/new-1")
        expect(createRes.body).toEqual({ id: "new-1" })

        const deleteRes = await request(app).delete("/items/1")
        expect(deleteRes.status).toBe(204)
    })
})
