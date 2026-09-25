import { describe, it, expect, vi, afterEach } from "vitest"
import http from "node:http"
import express from "express"
import { onShutdown } from "./lifecycle.js"
import { startAPI, stopAPI } from "./application.js"

// Emmett's gracefulShutdown.unit.spec.ts, translated (PR #406: one process listener per signal however many
// handlers), plus what our apps need: a handler runs once per shutdown, and a second signal exits.

const cleanups: (() => void)[] = []
const register = (handler: () => void | Promise<void>) => {
    const cleanup = onShutdown(handler)
    cleanups.push(cleanup)
    return cleanup
}
const tick = () => new Promise(r => setImmediate(r))

afterEach(() => {
    cleanups.splice(0).forEach(cleanup => cleanup())
    vi.restoreAllMocks()
})

describe("onShutdown", () => {
    it("calls the handler on SIGTERM", async () => {
        let called = false
        register(() => {
            called = true
        })

        process.emit("SIGTERM")
        await tick()

        expect(called).toBe(true)
    })

    it("calls the handler on SIGINT", async () => {
        let called = false
        register(() => {
            called = true
        })

        process.emit("SIGINT")
        await tick()

        expect(called).toBe(true)
    })

    it("stops calling the handler after cleanup", async () => {
        let count = 0
        const cleanup = register(() => {
            count++
        })
        cleanup()

        process.emit("SIGTERM")
        await tick()

        expect(count).toBe(0)
    })

    it("supports async handlers", async () => {
        let value = "pending"
        register(async () => {
            await Promise.resolve()
            value = "done"
        })

        process.emit("SIGTERM")
        await tick()

        expect(value).toBe("done")
    })

    it("calls every handler, and a cleaned-up one no more", async () => {
        let count1 = 0
        let count2 = 0
        const cleanup1 = register(() => {
            count1++
        })
        register(() => {
            count2++
        })
        cleanup1()

        process.emit("SIGTERM")
        await tick()

        expect(count1).toBe(0)
        expect(count2).toBe(1)
    })

    it("adds one process listener per signal for many handlers (Emmett #406)", () => {
        const sigterm = process.listenerCount("SIGTERM")
        const sigint = process.listenerCount("SIGINT")

        for (let i = 0; i < 11; i++) register(() => {})

        expect(process.listenerCount("SIGTERM")).toBe(sigterm + 1)
        expect(process.listenerCount("SIGINT")).toBe(sigint + 1)
    })

    it("removes the process listeners when every handler is cleaned up (Emmett #406)", () => {
        const sigterm = process.listenerCount("SIGTERM")
        const sigint = process.listenerCount("SIGINT")

        const mine = Array.from({ length: 11 }, () => onShutdown(() => {}))
        mine.forEach(cleanup => cleanup())

        expect(process.listenerCount("SIGTERM")).toBe(sigterm)
        expect(process.listenerCount("SIGINT")).toBe(sigint)
    })

    it("runs a handler once per shutdown: a second signal exits instead of running it again", async () => {
        const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never)
        let count = 0
        register(async () => {
            count++
            await new Promise(r => setTimeout(r, 50))
        })

        process.emit("SIGINT")
        process.emit("SIGINT")
        await new Promise(r => setTimeout(r, 80))

        // The double "Shutting down…" and `Called end on pool more than once` seen in the kit's server.
        expect(count).toBe(1)
        expect(exit).toHaveBeenCalledWith(130)
    })

    it("a failing handler is logged and doesn't stop the others", async () => {
        const logged = vi.spyOn(console, "error").mockImplementation(() => {})
        let other = false
        register(async () => {
            throw new Error("boom")
        })
        register(() => {
            other = true
        })

        process.emit("SIGTERM")
        await tick()

        expect(other).toBe(true)
        expect(logged).toHaveBeenCalled()
    })

    it("is ready again once every handler is cleaned up (a new shutdown runs the new handlers)", async () => {
        const first = onShutdown(() => {})
        process.emit("SIGTERM")
        await tick()
        first()

        let called = false
        register(() => {
            called = true
        })
        process.emit("SIGTERM")
        await tick()

        expect(called).toBe(true)
    })
})

describe("startAPI and stopAPI", () => {
    it("startAPI registers no signal listeners of its own", async () => {
        const sigterm = process.listenerCount("SIGTERM")
        const sigint = process.listenerCount("SIGINT")

        const server = startAPI(express(), { port: 0 })
        await new Promise(r => server.once("listening", r))
        try {
            expect(process.listenerCount("SIGTERM")).toBe(sigterm)
            expect(process.listenerCount("SIGINT")).toBe(sigint)
        } finally {
            await stopAPI(server)
        }
    })

    it("stopAPI closes the server even with a stream open (an SSE feed never ends by itself)", async () => {
        const app = express()
        app.get("/events", (_req, res) => {
            res.writeHead(200, { "Content-Type": "text/event-stream" })
            res.write(": open\n\n")
        })
        const server = startAPI(app, { port: 0 })
        await new Promise(r => server.once("listening", r))
        const { port } = server.address() as { port: number }

        const streamClosed = new Promise<void>(resolve => {
            http.get(`http://localhost:${port}/events`, res => {
                res.on("data", () => {})
                res.on("close", () => resolve())
                res.on("error", () => resolve())
            }).on("error", () => resolve())
        })
        await new Promise(r => setTimeout(r, 50))

        const start = Date.now()
        await stopAPI(server)
        await streamClosed

        expect(Date.now() - start).toBeLessThan(1000)
        expect(server.listening).toBe(false)
    })
})
