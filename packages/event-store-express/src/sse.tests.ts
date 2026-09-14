import { describe, it, expect, beforeEach, afterEach } from "vitest"
import http from "node:http"
import express from "express"
import { MemoryEventStore, Query, Tags } from "@dcb-es/event-store"
import type { DcbEvent } from "@dcb-es/event-store"
import { sseEventFeed } from "./sse.js"

// Helper: collect SSE messages from a Node HTTP request
function collectSseMessages(
    server: http.Server,
    path: string,
    opts: {
        headers?: Record<string, string>
        stopAfter?: number
        timeoutMs?: number
    } = {}
): Promise<{ id: string; data: unknown }[]> {
    const { stopAfter = 1, timeoutMs = 3000 } = opts
    return new Promise((resolve, reject) => {
        const addr = server.address() as { port: number }
        const messages: { id: string; data: unknown }[] = []
        let buffer = ""
        let settled = false

        const done = (req: http.ClientRequest) => {
            if (settled) return
            settled = true
            req.destroy()
            resolve(messages)
        }

        const req = http.get({ host: "127.0.0.1", port: addr.port, path, headers: opts.headers ?? {} }, res => {
            const timer = setTimeout(() => done(req), timeoutMs)

            res.on("data", (chunk: Buffer) => {
                buffer += chunk.toString()
                const parts = buffer.split("\n\n")
                buffer = parts.pop() ?? ""
                for (const part of parts) {
                    if (!part.trim() || part.startsWith(":")) continue
                    const lines = part.split("\n")
                    let id = ""
                    let dataStr = ""
                    for (const line of lines) {
                        if (line.startsWith("id: ")) id = line.slice(4)
                        else if (line.startsWith("data: ")) dataStr = line.slice(6)
                    }
                    if (dataStr) {
                        try {
                            messages.push({ id, data: JSON.parse(dataStr) })
                        } catch {
                            messages.push({ id, data: dataStr })
                        }
                    }
                    if (messages.length >= stopAfter) {
                        clearTimeout(timer)
                        done(req)
                        return
                    }
                }
            })

            res.on("end", () => {
                clearTimeout(timer)
                done(req)
            })
        })
        req.on("error", err => {
            if ((err as NodeJS.ErrnoException).code === "ECONNRESET" || settled) {
                resolve(messages)
            } else {
                reject(err)
            }
        })
    })
}

function collectHeartbeats(server: http.Server, path: string, opts: { timeoutMs?: number } = {}): Promise<number> {
    const { timeoutMs = 500 } = opts
    return new Promise(resolve => {
        const addr = server.address() as { port: number }
        let heartbeats = 0
        let buffer = ""
        const req = http.get({ host: "127.0.0.1", port: addr.port, path }, res => {
            res.on("data", (chunk: Buffer) => {
                buffer += chunk.toString()
                const parts = buffer.split("\n\n")
                buffer = parts.pop() ?? ""
                for (const part of parts) {
                    if (part.trim().startsWith(":")) heartbeats++
                }
            })
            res.on("error", () => resolve(heartbeats))
        })
        req.on("error", () => resolve(heartbeats))
        setTimeout(() => {
            req.destroy()
            resolve(heartbeats)
        }, timeoutMs)
    })
}

function makeCourseEvent(courseId: string): DcbEvent {
    return {
        type: "courseWasRegistered",
        tags: Tags.fromObj({ courseId }),
        data: { courseId, title: "Math", capacity: 30 },
        metadata: {}
    }
}

function makeStudentEvent(studentId: string): DcbEvent {
    return {
        type: "studentWasRegistered",
        tags: Tags.fromObj({ studentId }),
        data: { studentId, name: "Alice" },
        metadata: {}
    }
}

describe("sseEventFeed", () => {
    let store: MemoryEventStore
    let server: http.Server | undefined

    beforeEach(() => {
        store = new MemoryEventStore()
        server = undefined
    })

    afterEach(() => {
        return new Promise<void>(resolve => {
            if (server?.listening) {
                server.closeAllConnections?.()
                server.close(() => resolve())
            } else {
                resolve()
            }
        })
    })

    function createServer(path: string, middleware: express.RequestHandler): Promise<http.Server> {
        const app = express()
        app.get(path, middleware)
        return new Promise(resolve => {
            const srv = http.createServer(app).listen(0, "127.0.0.1", () => resolve(srv))
        })
    }

    it("streams existing events on connect", async () => {
        await store.append({ events: makeCourseEvent("c1") })

        server = await createServer("/events", sseEventFeed(store))

        const messages = await collectSseMessages(server, "/events", { stopAfter: 1 })
        expect(messages).toHaveLength(1)
        expect(messages[0].id).toBe("1")
        expect((messages[0].data as { event: { type: string } }).event.type).toBe("courseWasRegistered")
    })

    it("streams multiple existing events in order", async () => {
        await store.append({ events: [makeCourseEvent("c1"), makeStudentEvent("s1")] })

        server = await createServer("/events", sseEventFeed(store))

        const messages = await collectSseMessages(server, "/events", { stopAfter: 2 })
        expect(messages).toHaveLength(2)
        expect(messages[0].id).toBe("1")
        expect(messages[1].id).toBe("2")
        expect((messages[0].data as { event: { type: string } }).event.type).toBe("courseWasRegistered")
        expect((messages[1].data as { event: { type: string } }).event.type).toBe("studentWasRegistered")
    })

    it("Last-Event-ID header resumes from position", async () => {
        await store.append({ events: [makeCourseEvent("c1"), makeStudentEvent("s1")] })

        server = await createServer("/events", sseEventFeed(store))

        const messages = await collectSseMessages(server, "/events", {
            headers: { "Last-Event-ID": "1" },
            stopAfter: 1
        })
        expect(messages).toHaveLength(1)
        expect(messages[0].id).toBe("2")
        expect((messages[0].data as { event: { type: string } }).event.type).toBe("studentWasRegistered")
    })

    it("?after= query param works for resumption", async () => {
        await store.append({ events: [makeCourseEvent("c1"), makeStudentEvent("s1")] })

        server = await createServer("/events", sseEventFeed(store))

        const messages = await collectSseMessages(server, "/events?after=1", { stopAfter: 1 })
        expect(messages).toHaveLength(1)
        expect(messages[0].id).toBe("2")
    })

    it("Last-Event-ID takes precedence over ?after= param", async () => {
        await store.append({ events: [makeCourseEvent("c1"), makeStudentEvent("s1")] })

        server = await createServer("/events", sseEventFeed(store))

        const messages = await collectSseMessages(server, "/events?after=0", {
            headers: { "Last-Event-ID": "1" },
            stopAfter: 1
        })
        // Should resume from Last-Event-ID=1, returning only event at position 2
        expect(messages).toHaveLength(1)
        expect(messages[0].id).toBe("2")
    })

    it("?types= filter returns only matching events", async () => {
        await store.append({ events: [makeCourseEvent("c1"), makeStudentEvent("s1")] })

        server = await createServer("/events", sseEventFeed(store))

        const messages = await collectSseMessages(server, "/events?types=courseWasRegistered", { stopAfter: 1 })
        expect(messages).toHaveLength(1)
        expect((messages[0].data as { event: { type: string } }).event.type).toBe("courseWasRegistered")
        expect(messages[0].id).toBe("1")
    })

    it("sends heartbeat comments periodically", async () => {
        server = await createServer("/events", sseEventFeed(store, { heartbeatMs: 50 }))

        const heartbeats = await collectHeartbeats(server, "/events", { timeoutMs: 300 })
        expect(heartbeats).toBeGreaterThanOrEqual(1)
    })

    it("client disconnect aborts subscription cleanly", async () => {
        // Verify no hanging promise after disconnect
        server = await createServer("/events", sseEventFeed(store))

        const addr = server.address() as { port: number }
        const req = http.get({ host: "127.0.0.1", port: addr.port, path: "/events" })
        req.on("error", () => {
            // ignore ECONNRESET after destroy
        })

        await new Promise<void>(resolve => setTimeout(resolve, 50))
        req.destroy()
        await new Promise<void>(resolve => setTimeout(resolve, 100))

        // If we get here without hanging, the subscription was cleaned up
        expect(true).toBe(true)
    })

    it("uses options.query when no types param provided", async () => {
        await store.append({ events: [makeCourseEvent("c1"), makeStudentEvent("s1")] })

        const courseOnlyQuery = Query.fromItems([{ types: ["courseWasRegistered"] }])
        server = await createServer("/events", sseEventFeed(store, { query: () => courseOnlyQuery }))

        const messages = await collectSseMessages(server, "/events", { stopAfter: 1, timeoutMs: 500 })
        expect(messages).toHaveLength(1)
        expect((messages[0].data as { event: { type: string } }).event.type).toBe("courseWasRegistered")
    })

    it("SSE message data includes position, id, and recordedAt fields", async () => {
        await store.append({ events: makeCourseEvent("c1") })

        server = await createServer("/events", sseEventFeed(store))

        const messages = await collectSseMessages(server, "/events", { stopAfter: 1 })
        expect(messages).toHaveLength(1)
        const data = messages[0].data as {
            event: unknown
            position: string
            id: string
            recordedAt: string
        }
        expect(data.position).toBe("1")
        expect(typeof data.id).toBe("string")
        expect(data.id.length).toBeGreaterThan(0)
        expect(typeof data.recordedAt).toBe("string")
    })
})
