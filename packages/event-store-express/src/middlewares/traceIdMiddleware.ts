import { randomUUID } from "node:crypto"
import type { NextFunction, Request, Response } from "express"

const HEADER = "x-request-id"

export const traceIdMiddleware =
    () =>
    (request: Request, response: Response, next: NextFunction): void => {
        const incoming = request.headers[HEADER]
        const traceId = typeof incoming === "string" && incoming.length > 0 ? incoming : randomUUID()
        response.setHeader(HEADER, traceId)
        next()
    }
