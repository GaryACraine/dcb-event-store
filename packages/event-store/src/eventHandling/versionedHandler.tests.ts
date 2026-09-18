import { describe, test, expect } from "vitest"
import { versionedHandler } from "./versionedHandler.js"
import type { Event } from "../eventStore/Event.js"
import type { SequencedEvent } from "../eventStore/EventStore.js"
import { Tags } from "../eventStore/Tags.js"
import { SequencePosition } from "../eventStore/SequencePosition.js"

type CourseEventV1 = Event<"courseWasRegistered", { courseId: string; title: string }>
type CourseEventV2 = Event<"courseWasRegistered", { courseId: string; title: string; department: string }>
type CourseEventV3 = Event<
    "courseWasRegistered",
    { courseId: string; name: string; description: string; department: string }
>

function makeSequencedEvent<E extends Event>(
    event: E,
    schemaVersion?: string
): SequencedEvent<E> {
    return {
        event,
        tags: Tags.fromObj({ courseId: "c1" }),
        position: SequencePosition.fromString("1"),
        id: "00000000-0000-0000-0000-000000000001",
        recordedAt: new Date("2024-01-01T00:00:00Z"),
        schemaVersion
    }
}

describe("versionedHandler", () => {
    test("routes to the correct handler by schemaVersion", () => {
        const handler = versionedHandler<CourseEventV1 | CourseEventV2, string>({
            "1": ({ event }) => `v1:${event.data.title}`,
            "2": ({ event }) => `v2:${event.data.title}`
        })

        const seV1 = makeSequencedEvent<CourseEventV1>(
            { type: "courseWasRegistered", data: { courseId: "c1", title: "Math" } },
            "1"
        )
        const seV2 = makeSequencedEvent<CourseEventV2>(
            { type: "courseWasRegistered", data: { courseId: "c1", title: "Science", department: "STEM" } },
            "2"
        )

        expect(handler(seV1, "")).toBe("v1:Math")
        expect(handler(seV2, "")).toBe("v2:Science")
    })

    test("defaults to version '1' when schemaVersion is undefined", () => {
        const handler = versionedHandler<CourseEventV1, string>({
            "1": ({ event }) => event.data.title
        })

        const se = makeSequencedEvent<CourseEventV1>(
            { type: "courseWasRegistered", data: { courseId: "c1", title: "Math" } },
            undefined
        )

        expect(handler(se, "")).toBe("Math")
    })

    test("throws with informative message when version is unrecognised and no fallback", () => {
        const handler = versionedHandler<CourseEventV1, string>({
            "1": ({ event }) => event.data.title
        })

        const se = makeSequencedEvent<CourseEventV1>(
            { type: "courseWasRegistered", data: { courseId: "c1", title: "Math" } },
            "99"
        )

        expect(() => handler(se, "")).toThrow(`No handler for courseWasRegistered schemaVersion "99"`)
        expect(() => handler(se, "")).toThrow("Known versions: 1")
    })

    test("uses fallback when version is unrecognised and fallback is provided", () => {
        const handler = versionedHandler<CourseEventV1, string>(
            {
                "1": ({ event }) => event.data.title
            },
            {
                fallback: (_se, state) => `fallback:${state}`
            }
        )

        const se = makeSequencedEvent<CourseEventV1>(
            { type: "courseWasRegistered", data: { courseId: "c1", title: "Math" } },
            "99"
        )

        expect(handler(se, "previous")).toBe("fallback:previous")
    })

    test("passes SequencedEvent and current state to the version handler", () => {
        let capturedEvent: SequencedEvent<CourseEventV1> | undefined
        let capturedState: number | undefined

        const handler = versionedHandler<CourseEventV1, number>({
            "1": (se, state) => {
                capturedEvent = se
                capturedState = state
                return state + 1
            }
        })

        const se = makeSequencedEvent<CourseEventV1>(
            { type: "courseWasRegistered", data: { courseId: "c1", title: "Math" } },
            "1"
        )

        const result = handler(se, 41)

        expect(result).toBe(42)
        expect(capturedEvent).toBe(se)
        expect(capturedState).toBe(41)
    })

    test("handles multiple version types (V1/V2/V3) dispatching correctly", () => {
        const handler = versionedHandler<CourseEventV1 | CourseEventV2 | CourseEventV3, string>({
            "1": ({ event }) => `v1:${(event.data as { title: string }).title}`,
            "2": ({ event }) => `v2:${(event.data as { title: string }).title}`,
            "3": ({ event }) => `v3:${(event.data as { name: string }).name}`
        })

        const seV3 = makeSequencedEvent<CourseEventV3>(
            {
                type: "courseWasRegistered",
                data: { courseId: "c1", name: "Advanced Math", description: "Deep dive", department: "Math" }
            },
            "3"
        )

        expect(handler(seV3, "")).toBe("v3:Advanced Math")
    })
})
