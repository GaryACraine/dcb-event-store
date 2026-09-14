import type { Request, RequestHandler, Response } from "express"
import type { EventStore } from "@dcb-es/event-store"
import { Query, SequencePosition, Tags } from "@dcb-es/event-store"

export interface SseOptions {
    query?: (req: Request) => Query
    heartbeatMs?: number
}

function parseQueryFromRequest(req: Request): Query | undefined {
    const typesParam = req.query["types"]
    if (typeof typesParam !== "string" || typesParam.trim() === "") {
        return undefined
    }

    const types = typesParam
        .split(",")
        .map(t => t.trim())
        .filter(t => t.length > 0)
    if (types.length === 0) return undefined

    const tagsParam = req.query["tags"]
    if (typeof tagsParam === "string" && tagsParam.trim() !== "") {
        const tagStrings = tagsParam
            .split(",")
            .map(t => t.trim())
            .filter(t => t.length > 0)
            .map(t => {
                // Convert "key:val" format to "key=val" format for Tags.from()
                const colonIdx = t.indexOf(":")
                if (colonIdx === -1) return t
                return `${t.slice(0, colonIdx)}=${t.slice(colonIdx + 1)}`
            })
        return Query.fromItems([{ types, tags: Tags.from(tagStrings) }])
    }

    return Query.fromItems([{ types }])
}

function parseAfterPosition(value: string | undefined): SequencePosition | undefined {
    if (!value || value.trim() === "") return undefined
    try {
        return SequencePosition.fromString(value.trim())
    } catch {
        return undefined
    }
}

export function sseEventFeed(eventStore: EventStore, options?: SseOptions): RequestHandler {
    const heartbeatMs = options?.heartbeatMs ?? 15000

    return async (req: Request, res: Response): Promise<void> => {
        res.setHeader("Content-Type", "text/event-stream")
        res.setHeader("Cache-Control", "no-cache")
        res.setHeader("Connection", "keep-alive")
        res.flushHeaders()

        // Determine which query to use
        const queryFromRequest = parseQueryFromRequest(req)
        let query: Query
        if (queryFromRequest) {
            query = queryFromRequest
        } else if (options?.query) {
            query = options.query(req)
        } else {
            query = Query.all()
        }

        // Determine the starting position: Last-Event-ID header takes precedence over ?after= param
        const lastEventId = req.headers["last-event-id"]
        const afterHeader = typeof lastEventId === "string" ? lastEventId : undefined
        const afterParam = typeof req.query["after"] === "string" ? req.query["after"] : undefined
        const after = parseAfterPosition(afterHeader) ?? parseAfterPosition(afterParam)

        const controller = new AbortController()

        req.on("close", () => {
            controller.abort()
        })

        let heartbeatTimer: ReturnType<typeof setInterval> | undefined
        heartbeatTimer = setInterval(() => {
            if (!res.writableEnded) {
                res.write(": heartbeat\n\n")
            }
        }, heartbeatMs)

        try {
            const subscription = eventStore.subscribe(query, { after, signal: controller.signal })
            for await (const sequencedEvent of subscription) {
                if (controller.signal.aborted) break
                if (res.writableEnded) break

                const position = sequencedEvent.position.toString()
                const data = JSON.stringify({
                    event: sequencedEvent.event,
                    position,
                    id: sequencedEvent.id,
                    recordedAt: sequencedEvent.recordedAt
                })
                res.write(`id: ${position}\ndata: ${data}\n\n`)
            }
        } catch (err: unknown) {
            // AbortError is expected on client disconnect — swallow it
            if (err instanceof Error && err.name === "AbortError") {
                // normal disconnect
            } else if (!controller.signal.aborted) {
                // unexpected error
                if (!res.writableEnded) {
                    res.write(`event: error\ndata: ${JSON.stringify({ message: "internal error" })}\n\n`)
                }
            }
        } finally {
            clearInterval(heartbeatTimer)
            if (!res.writableEnded) {
                res.end()
            }
        }
    }
}
