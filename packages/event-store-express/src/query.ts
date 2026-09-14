import type { Request, Response } from "express"
import { SequencePosition } from "@dcb-es/event-store"
import type { HttpResponse } from "./handler.js"

export interface PaginatedResult<T> {
    data: T[]
    cursor?: string
    position?: string
}

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

export function withETag(position: SequencePosition | string): HttpResponse {
    const etag = `"${position.toString()}"`
    return (response: Response) => {
        response.setHeader("ETag", etag)
    }
}

export function parsePageParams(req: Request): { after?: SequencePosition; limit: number } {
    let after: SequencePosition | undefined
    const afterParam = req.query["after"]
    if (typeof afterParam === "string" && afterParam.trim() !== "") {
        try {
            after = SequencePosition.fromString(afterParam.trim())
        } catch {
            // Invalid position — ignore and use default
        }
    }

    let limit = DEFAULT_LIMIT
    const limitParam = req.query["limit"]
    if (typeof limitParam === "string" && limitParam.trim() !== "") {
        const parsed = parseInt(limitParam.trim(), 10)
        if (!isNaN(parsed) && parsed > 0) {
            limit = Math.min(parsed, MAX_LIMIT)
        }
    }

    return { after, limit }
}
