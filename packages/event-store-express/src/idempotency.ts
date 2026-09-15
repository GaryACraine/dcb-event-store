import type { Request } from "express"

export function getIdempotencyKey(req: Request): string | undefined {
    const key = req.headers["idempotency-key"]
    return typeof key === "string" && key.length > 0 ? key : undefined
}
