import { describe, it, expect, vi } from "vitest"
import express from "express"
import request from "supertest"
import { SequencePosition, WaitTimeoutError } from "@dcb-es/event-store"
import { preferWait, type WaitFunction } from "./preferWait.js"

function createApp(waitFn: WaitFunction, opts?: { defaultTimeoutMs?: number; maxTimeoutMs?: number }) {
    const app = express()
    app.use(preferWait({ waitFn, ...opts }))
    app.get("/data", (_req, res) => {
        res.status(200).json({ ok: true })
    })
    // Express 4-compat error handler
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
    })
    return app
}

describe("preferWait middleware", () => {
    it("passes through when no Prefer header is present", async () => {
        const waitFn = vi.fn<WaitFunction>().mockResolvedValue(undefined)
        const app = createApp(waitFn)

        const res = await request(app).get("/data")

        expect(res.status).toBe(200)
        expect(res.body).toEqual({ ok: true })
        expect(waitFn).not.toHaveBeenCalled()
    })

    it("passes through when Prefer header has no wait directive", async () => {
        const waitFn = vi.fn<WaitFunction>().mockResolvedValue(undefined)
        const app = createApp(waitFn)

        const res = await request(app).get("/data").set("Prefer", "return=representation")

        expect(res.status).toBe(200)
        expect(waitFn).not.toHaveBeenCalled()
    })

    it("passes through when Prefer: wait is present but If-None-Match is absent", async () => {
        const waitFn = vi.fn<WaitFunction>().mockResolvedValue(undefined)
        const app = createApp(waitFn)

        const res = await request(app).get("/data").set("Prefer", "wait=5")

        expect(res.status).toBe(200)
        expect(waitFn).not.toHaveBeenCalled()
    })

    it("calls waitFn when Prefer: wait and If-None-Match are both present", async () => {
        const waitFn = vi.fn<WaitFunction>().mockResolvedValue(undefined)
        const app = createApp(waitFn)

        const res = await request(app).get("/data").set("Prefer", "wait=2").set("If-None-Match", '"5"')

        expect(res.status).toBe(200)
        expect(waitFn).toHaveBeenCalledOnce()
        const [position, timeoutMs] = waitFn.mock.calls[0]
        expect(position.toString()).toBe("5")
        expect(timeoutMs).toBe(2000)
    })

    it("sets Preference-Applied: wait header on success", async () => {
        const waitFn = vi.fn<WaitFunction>().mockResolvedValue(undefined)
        const app = createApp(waitFn)

        const res = await request(app).get("/data").set("Prefer", "wait=2").set("If-None-Match", '"5"')

        expect(res.headers["preference-applied"]).toBe("wait")
    })

    it("responds 504 when waitFn throws a WaitTimeoutError", async () => {
        const waitFn = vi.fn<WaitFunction>().mockRejectedValue(new WaitTimeoutError("Projection", "3", 1000))
        const app = createApp(waitFn)

        const res = await request(app).get("/data").set("Prefer", "wait=1").set("If-None-Match", '"3"')

        expect(res.status).toBe(504)
        expect(res.headers["content-type"]).toContain("application/problem+json")
        expect(res.body.status).toBe(504)
        expect(res.body.title).toBe("Gateway Timeout")
    })

    it("responds 504 for the library's own timeout message, which starts with a capital T (phase 18)", async () => {
        // The old check was `message.includes("timeout")`: waitUntilProcessed's "Timeout: handler …" didn't match,
        // so a wait that ran out of time answered 500.
        const err = new WaitTimeoutError("CourseProjection", "860", 5000)
        expect(err.message.startsWith("Timeout:")).toBe(true)
        const app = createApp(vi.fn<WaitFunction>().mockRejectedValue(err))

        const res = await request(app).get("/data").set("Prefer", "wait=5").set("If-None-Match", '"860"')

        expect(res.status).toBe(504)
    })

    it("responds 504 for a WaitTimeoutError from another copy of the core package", async () => {
        // Two installed copies of @dcb-es/event-store make `instanceof` fail; the name still says what it is.
        const foreign = Object.assign(new Error('Timeout: handler "P" did not reach position 3 within 10ms'), {
            name: "WaitTimeoutError"
        })
        const app = createApp(vi.fn<WaitFunction>().mockRejectedValue(foreign))

        const res = await request(app).get("/data").set("Prefer", "wait=1").set("If-None-Match", '"3"')

        expect(res.status).toBe(504)
    })

    it("passes on other errors that merely mention a timeout (a connection timeout is a 500)", async () => {
        const waitFn = vi
            .fn<WaitFunction>()
            .mockRejectedValue(new Error("Connection terminated due to connection timeout"))
        const app = createApp(waitFn)

        const res = await request(app).get("/data").set("Prefer", "wait=1").set("If-None-Match", '"3"')

        expect(res.status).toBe(500)
    })

    it("respects maxTimeoutMs cap", async () => {
        const waitFn = vi.fn<WaitFunction>().mockResolvedValue(undefined)
        const app = createApp(waitFn, { maxTimeoutMs: 3000 })

        // Client requests 60 seconds but maxTimeoutMs is 3000
        const res = await request(app).get("/data").set("Prefer", "wait=60").set("If-None-Match", '"5"')

        expect(res.status).toBe(200)
        const [, timeoutMs] = waitFn.mock.calls[0]
        expect(timeoutMs).toBe(3000)
    })

    it("converts seconds to milliseconds for waitFn call", async () => {
        const waitFn = vi.fn<WaitFunction>().mockResolvedValue(undefined)
        const app = createApp(waitFn)

        await request(app).get("/data").set("Prefer", "wait=10").set("If-None-Match", '"7"')

        const [, timeoutMs] = waitFn.mock.calls[0]
        expect(timeoutMs).toBe(10000)
    })

    it("calls next(err) for non-timeout errors from waitFn", async () => {
        const waitFn = vi.fn<WaitFunction>().mockRejectedValue(new Error("database error"))
        const app = createApp(waitFn)

        const res = await request(app).get("/data").set("Prefer", "wait=2").set("If-None-Match", '"5"')

        // Should be caught by generic error handler → 500
        expect(res.status).toBe(500)
        expect(res.body.error).toBe("database error")
    })

    it("parses If-None-Match position from quoted string", async () => {
        const capturedPosition: SequencePosition[] = []
        const waitFn = vi.fn<WaitFunction>(async pos => {
            capturedPosition.push(pos)
        })
        const app = createApp(waitFn)

        await request(app).get("/data").set("Prefer", "wait=1").set("If-None-Match", '"42"')

        expect(capturedPosition[0].toString()).toBe("42")
    })
})
