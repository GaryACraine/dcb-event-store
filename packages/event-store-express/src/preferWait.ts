import type { NextFunction, Request, Response } from "express"
import { SequencePosition } from "@dcb-es/event-store"
import { sendProblem } from "./responses.js"

export type WaitFunction = (position: SequencePosition, timeoutMs: number) => Promise<void>

export interface PreferWaitOptions {
    waitFn: WaitFunction
    defaultTimeoutMs?: number
    maxTimeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 5000
const MAX_TIMEOUT_MS = 30000

function parsePreferWait(preferHeader: string | undefined): number | undefined {
    if (!preferHeader) return undefined
    const match = /\bwait=(\d+(?:\.\d+)?)\b/.exec(preferHeader)
    if (!match) return undefined
    const seconds = parseFloat(match[1])
    if (isNaN(seconds) || seconds <= 0) return undefined
    return Math.round(seconds * 1000)
}

function parseIfNoneMatch(ifNoneMatchHeader: string | undefined): SequencePosition | undefined {
    if (!ifNoneMatchHeader) return undefined
    // Strip surrounding quotes: `"5"` → `5`
    const value = ifNoneMatchHeader.trim().replace(/^"(.*)"$/, "$1")
    try {
        return SequencePosition.fromString(value)
    } catch {
        return undefined
    }
}

export function preferWait(options: PreferWaitOptions): (req: Request, res: Response, next: NextFunction) => void {
    const defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS
    const maxTimeoutMs = options.maxTimeoutMs ?? MAX_TIMEOUT_MS

    return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        const preferHeader = req.headers["prefer"]
        const ifNoneMatchHeader = req.headers["if-none-match"]

        const waitMs = parsePreferWait(typeof preferHeader === "string" ? preferHeader : undefined)

        // No Prefer: wait header → pass through
        if (waitMs === undefined) {
            next()
            return
        }

        const position = parseIfNoneMatch(typeof ifNoneMatchHeader === "string" ? ifNoneMatchHeader : undefined)

        // No If-None-Match position → nothing to wait for, pass through
        if (position === undefined) {
            next()
            return
        }

        const timeoutMs = Math.min(waitMs ?? defaultTimeoutMs, maxTimeoutMs)

        try {
            await options.waitFn(position, timeoutMs)
            res.setHeader("Preference-Applied", "wait")
            // Clear If-None-Match after consuming it as a position cursor so that
            // Express's conditional-GET freshness check does not produce a spurious
            // 304 when the response ETag happens to equal the wait position.
            delete req.headers["if-none-match"]
            next()
        } catch (err: unknown) {
            // Distinguish timeout from other errors
            if (err instanceof Error && err.message.includes("timeout")) {
                sendProblem(res, 504, {
                    type: "about:blank",
                    title: "Gateway Timeout",
                    status: 504,
                    detail: `Wait for position ${position.toString()} timed out after ${timeoutMs}ms`
                })
            } else {
                next(err)
            }
        }
    }
}
