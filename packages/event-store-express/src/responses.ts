import type { Response } from "express"
import type { ProblemDetails } from "@dcb-es/event-store-web"
import type { HttpResponse } from "./handler.js"

export interface HttpResponseOptions {
    body?: unknown
    location?: string
}

export type CreatedHttpResponseOptions = ({ createdId: string } | { url: string }) & HttpResponseOptions

export type AcceptedHttpResponseOptions = {
    location: string
} & HttpResponseOptions

export type NoContentHttpResponseOptions = Omit<HttpResponseOptions, "body">

export function send(response: Response, statusCode: number, options?: HttpResponseOptions): void {
    if (options?.location) {
        response.setHeader("Location", options.location)
    }
    if (options?.body !== undefined) {
        response.status(statusCode).json(options.body)
    } else {
        response.sendStatus(statusCode)
    }
}

export function sendProblem(response: Response, statusCode: number, problem: ProblemDetails): void {
    response.setHeader("Content-Type", "application/problem+json")
    response.status(statusCode).json(problem)
}

export function OK(options?: HttpResponseOptions): HttpResponse {
    return response => send(response, 200, options)
}

export function Created(options: CreatedHttpResponseOptions): HttpResponse {
    return response => {
        const location =
            options.location ??
            ("createdId" in options ? `/api/${options.createdId}` : undefined) ??
            ("url" in options ? options.url : undefined)

        const body = options.body ?? ("createdId" in options ? { id: options.createdId } : undefined)

        send(response, 201, { body, location })
    }
}

export function Accepted(options: AcceptedHttpResponseOptions): HttpResponse {
    return response => send(response, 202, options)
}

export function NoContent(options?: NoContentHttpResponseOptions): HttpResponse {
    return response => {
        if (options?.location) {
            response.setHeader("Location", options.location)
        }
        response.sendStatus(204)
    }
}
