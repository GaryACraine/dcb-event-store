import type { RequestHandler } from "express"
import type { ZodType } from "zod"
import { ValidationError } from "@dcb-es/event-store"

/**
 * Express middleware that validates `req.body` against a Zod schema.
 *
 * On success: replaces `req.body` with the coerced, typed result and calls `next()`.
 * On failure: calls `next(new ValidationError(...))` so the problem-details middleware
 * renders a 400 `application/problem+json` response.
 *
 * `zod` is an optional peer dependency — only import this helper when zod is installed.
 */
export function validateBody<T>(schema: ZodType<T>): RequestHandler {
    return (req, _res, next) => {
        const result = schema.safeParse(req.body)
        if (result.success) {
            req.body = result.data
            next()
        } else {
            const issues = result.error.issues
                .map(issue => {
                    const path = issue.path.length > 0 ? issue.path.join(".") : "body"
                    return `${path}: ${issue.message}`
                })
                .join("; ")
            next(new ValidationError(`Validation failed: ${issues}`))
        }
    }
}
