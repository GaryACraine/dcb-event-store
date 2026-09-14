import type { DcbEvent, SequencedEvent } from "../eventStore/EventStore.js"
import { Tags } from "../eventStore/Tags.js"

export function normalizeForComparison(event: DcbEvent): { type: string; tags: string[]; data: unknown; metadata: unknown } {
    return {
        type: event.type,
        tags: event.tags instanceof Tags ? event.tags.values : [],
        data: event.data,
        metadata: event.metadata
    }
}

export function deepEqual(a: unknown, b: unknown): boolean {
    if (a === b) return true
    if (a === null || b === null) return false
    if (typeof a !== typeof b) return false
    if (typeof a === "function") return true
    if (typeof a !== "object") return false

    if (Array.isArray(a) && Array.isArray(b)) {
        if (a.length !== b.length) return false
        return a.every((val, idx) => deepEqual(val, b[idx]))
    }

    const aObj = a as Record<string, unknown>
    const bObj = b as Record<string, unknown>

    const aKeys = Object.keys(aObj)
    const bKeys = Object.keys(bObj)

    if (aKeys.length !== bKeys.length) return false

    for (const key of aKeys) {
        if (!Object.prototype.hasOwnProperty.call(bObj, key)) return false
        if (!deepEqual(aObj[key], bObj[key])) return false
    }

    return true
}

/**
 * Partial deep match: every key present in `expected` must exist in `actual`
 * with an equal value. `actual` may have additional keys.
 */
export function assertMatches(actual: unknown, expected: unknown): void {
    if (expected === null || typeof expected !== "object") {
        if (!deepEqual(actual, expected)) {
            throw new Error(
                `Expected ${JSON.stringify(expected)} but got ${JSON.stringify(actual)}`
            )
        }
        return
    }

    if (actual === null || typeof actual !== "object") {
        throw new Error(`Expected object but got ${JSON.stringify(actual)}`)
    }

    const expectedObj = expected as Record<string, unknown>
    const actualObj = actual as Record<string, unknown>

    for (const key of Object.keys(expectedObj)) {
        if (!Object.prototype.hasOwnProperty.call(actualObj, key)) {
            throw new Error(
                `Expected key "${key}" to be present in ${JSON.stringify(actualObj)}`
            )
        }
        assertMatches(actualObj[key], expectedObj[key])
    }
}

export function assertNewEvents(actual: SequencedEvent[], expected: DcbEvent[]): void {
    const actualNormalized = actual.map(se => normalizeForComparison(se.event))
    const expectedNormalized = expected.map(normalizeForComparison)

    if (actualNormalized.length !== expectedNormalized.length) {
        throw new Error(
            `Expected ${expectedNormalized.length} new event(s) but got ${actualNormalized.length}.\n` +
                `Actual: ${JSON.stringify(actualNormalized, null, 2)}\n` +
                `Expected: ${JSON.stringify(expectedNormalized, null, 2)}`
        )
    }

    for (let i = 0; i < actualNormalized.length; i++) {
        if (!deepEqual(actualNormalized[i], expectedNormalized[i])) {
            throw new Error(
                `Event at index ${i} does not match.\n` +
                    `Actual: ${JSON.stringify(actualNormalized[i], null, 2)}\n` +
                    `Expected: ${JSON.stringify(expectedNormalized[i], null, 2)}`
            )
        }
    }
}
