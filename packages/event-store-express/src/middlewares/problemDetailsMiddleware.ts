import type { NextFunction, Request, Response } from "express"
import { toProblemDetails, type ErrorToProblemDetailsMapping } from "@dcb-es/event-store-web"

export const problemDetailsMiddleware =
    (mapError?: ErrorToProblemDetailsMapping) =>
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    (error: unknown, request: Request, response: Response, _next: NextFunction): void => {
        const problem = toProblemDetails(error, request, mapError)
        response.setHeader("Content-Type", "application/problem+json")
        response.status(problem.status).json(problem)
    }
