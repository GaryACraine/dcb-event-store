import { MemoryEventStore } from "./MemoryEventStore.js"
import { TaggedEvent, SequencedEvent } from "../EventStore.js"
import { SequencePosition } from "../SequencePosition.js"
import { Tags } from "../Tags.js"
import { Query } from "../Query.js"

const event = (type: string, tags: Tags = Tags.fromObj({ e: "1" })): TaggedEvent => ({
    event: { type, data: {}, kind: "Event" },
    tags
})

async function collectEvents(
    gen: AsyncGenerator<SequencedEvent>,
    count: number,
    timeoutMs = 2000
): Promise<SequencedEvent[]> {
    const events: SequencedEvent[] = []
    const deadline = Date.now() + timeoutMs
    for await (const ev of gen) {
        events.push(ev)
        if (events.length >= count) break
        if (Date.now() > deadline) throw new Error("Timed out waiting for events")
    }
    return events
}

describe("MemoryEventStore.subscribe", () => {
    let store: MemoryEventStore

    beforeEach(() => {
        store = new MemoryEventStore()
    })

    test("delivers historical events first", async () => {
        await store.append({ events: event("A") })
        await store.append({ events: event("B") })

        const events = await collectEvents(store.subscribe(Query.all()), 2)
        expect(events[0].event.type).toBe("A")
        expect(events[1].event.type).toBe("B")
    })

    test("delivers new events appended after subscribe starts", async () => {
        const sub = store.subscribe(Query.all())

        // Append after subscribe is running
        setTimeout(async () => {
            await store.append({ events: event("Live") })
        }, 10)

        const events = await collectEvents(sub, 1)
        expect(events[0].event.type).toBe("Live")
    })

    test("after option skips earlier events", async () => {
        await store.append({ events: event("A") })
        await store.append({ events: event("B") })

        const sub = store.subscribe(Query.all(), { after: SequencePosition.fromString("1") })

        setTimeout(async () => {
            await store.append({ events: event("C") })
        }, 10)

        const events = await collectEvents(sub, 2)
        expect(events[0].event.type).toBe("B")
        expect(events[1].event.type).toBe("C")
    })

    test("AbortSignal terminates the generator", async () => {
        const controller = new AbortController()
        const sub = store.subscribe(Query.all(), { signal: controller.signal })

        await store.append({ events: event("A") })

        setTimeout(() => controller.abort(), 50)

        const events: SequencedEvent[] = []
        for await (const ev of sub) {
            events.push(ev)
        }
        expect(events.length).toBe(1)
        expect(events[0].event.type).toBe("A")
    })

    test("empty store blocks until events arrive", async () => {
        const sub = store.subscribe(Query.all())

        setTimeout(async () => {
            await store.append({ events: event("First") })
        }, 50)

        const events = await collectEvents(sub, 1)
        expect(events[0].event.type).toBe("First")
    })

    test("delivers filtered events only", async () => {
        await store.append({ events: event("A", Tags.fromObj({ kind: "x" })) })
        await store.append({ events: event("B", Tags.fromObj({ kind: "y" })) })

        const sub = store.subscribe(Query.fromItems([{ types: ["A"], tags: Tags.fromObj({ kind: "x" }) }]))

        setTimeout(async () => {
            await store.append({ events: event("A", Tags.fromObj({ kind: "x" })) })
        }, 10)

        const events = await collectEvents(sub, 2)
        expect(events.every(e => e.event.type === "A")).toBe(true)
    })

    test("historical + live events are seamless", async () => {
        await store.append({ events: event("Historical") })

        const sub = store.subscribe(Query.all())

        setTimeout(async () => {
            await store.append({ events: event("Live") })
        }, 10)

        const events = await collectEvents(sub, 2)
        expect(events[0].event.type).toBe("Historical")
        expect(events[1].event.type).toBe("Live")
    })

    describe("onCaughtUp (phase 18)", () => {
        const drive = (query: Query, after?: SequencePosition) => {
            const controller = new AbortController()
            const log: string[] = []
            const done = (async () => {
                for await (const ev of store.subscribe(query, {
                    after,
                    signal: controller.signal,
                    onCaughtUp: position => {
                        log.push(`caughtUp ${position.toString()}`)
                    }
                })) {
                    log.push(`event ${ev.event.type} ${ev.position.toString()}`)
                }
            })()
            return {
                log,
                stop: async () => {
                    controller.abort()
                    await done
                }
            }
        }
        const settle = () => new Promise(r => setTimeout(r, 20))

        test("reports the store's last position when only unrelated events were appended", async () => {
            const sub = drive(Query.fromItems([{ types: ["A"] }]))
            await store.append({ events: event("B") })
            await store.append({ events: event("B") })
            await settle()
            await sub.stop()

            // Both appends may land before the subscription wakes; either way it ends caught up at 2, having
            // yielded nothing.
            expect(sub.log.at(-1)).toBe("caughtUp 2")
            expect(sub.log.every(line => line.startsWith("caughtUp"))).toBe(true)
        })

        test("yields a matching event before reporting a position past it", async () => {
            await store.append({ events: event("A") })
            await store.append({ events: event("B") })
            const sub = drive(Query.fromItems([{ types: ["A"] }]))
            await settle()
            await sub.stop()

            expect(sub.log).toEqual(["event A 1", "caughtUp 2"])
        })

        test("doesn't report when nothing lies past `after`", async () => {
            await store.append({ events: event("B") })
            const sub = drive(Query.fromItems([{ types: ["A"] }]), SequencePosition.fromString("1"))
            await settle()
            await sub.stop()

            expect(sub.log).toEqual([])
        })

        test("an idle subscription leaves no listeners behind", async () => {
            const controller = new AbortController()
            const sub = store.subscribe(Query.all(), { signal: controller.signal })
            const pending = sub.next()
            await settle()
            await store.append({ events: event("A") })
            await pending
            const next = sub.next()
            await settle()
            controller.abort()
            await next

            expect(store["emitter"].listenerCount("append")).toBe(0)
        })
    })
})
