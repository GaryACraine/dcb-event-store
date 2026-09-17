import { MemoryEventStore } from "./MemoryEventStore.js"
import { AppendCondition, TaggedEvent } from "../EventStore.js"
import { AnyEvent, Event } from "../Event.js"
import { AppendConditionError } from "../AppendConditionError.js"
import { SequencePosition } from "../SequencePosition.js"
import { streamAllEventsToArray } from "../streamAllEventsToArray.js"
import { Tags } from "../Tags.js"
import { Query } from "../Query.js"

class EventType1 implements TaggedEvent<Event<"testEvent1", Record<string, never>>> {
    event: Event<"testEvent1", Record<string, never>> = { type: "testEvent1", data: {}, kind: "Event" }
    tags: Tags

    constructor(tagValue?: string) {
        this.tags = Tags.fromObj({ testTagKey: tagValue ?? "default" })
    }
}

describe("memoryEventStore.append", () => {
    let eventStore: MemoryEventStore

    describe("when event store empty", () => {
        beforeEach(async () => {
            eventStore = new MemoryEventStore()
        })

        test("should return an empty array when no events are stored", async () => {
            const events = await streamAllEventsToArray(eventStore.read(Query.all()))
            expect(events.length).toBe(0)
        })
        test("should assign a sequence number of 1 on appending the first event", async () => {
            await eventStore.append({ events: new EventType1() })
            const events = await streamAllEventsToArray(eventStore.read(Query.all()))
            const lastSequencePosition = events.at(-1)?.position

            expect(lastSequencePosition?.toString()).toBe("1")
        })
        test("should return the position of the last appended event", async () => {
            const pos = await eventStore.append({ events: new EventType1() })
            expect(pos.toString() === "1").toBe(true)
        })
        describe("when append condition with types filter and after provided", () => {
            const condition: AppendCondition = {
                failIfEventsMatch: Query.fromItems([
                    { types: ["testEvent1"], tags: Tags.fromObj({ testTagKey: "default" }) }
                ]),
                after: SequencePosition.fromString("1")
            }
            test("should successfully append an event without throwing under specified conditions", async () => {
                await eventStore.append({ events: new EventType1(), condition })
                const events = await streamAllEventsToArray(eventStore.read(Query.all()))
                const lastSequencePosition = events.at(-1)?.position

                expect(lastSequencePosition?.toString()).toBe("1")
            })
        })
    })

    describe("when event store has exactly one event", () => {
        beforeEach(async () => {
            eventStore = new MemoryEventStore()
            await eventStore.append({ events: new EventType1() })
        })

        test("should increment sequence number to 2 when a second event is appended", async () => {
            await eventStore.append({ events: new EventType1() })
            const events = await streamAllEventsToArray(eventStore.read(Query.all()))
            const lastSequencePosition = events.at(-1)?.position

            expect(lastSequencePosition?.toString()).toBe("2")
        })

        test("should update the sequence number to 3 after appending two more events", async () => {
            await eventStore.append({ events: [new EventType1(), new EventType1()] })
            const events = await streamAllEventsToArray(eventStore.read(Query.all()))
            const lastSequencePosition = events.at(-1)?.position

            expect(lastSequencePosition?.toString()).toBe("3")
        })

        test("should return position of last event in batch", async () => {
            const pos = await eventStore.append({ events: [new EventType1(), new EventType1()] })
            expect(pos.toString() === "3").toBe(true)
        })

        describe("when append condition with types filter and after provided", () => {
            const condition: AppendCondition = {
                failIfEventsMatch: Query.fromItems([
                    { types: ["testEvent1"], tags: Tags.fromObj({ testTagKey: "default" }) }
                ]),
                after: SequencePosition.initial()
            }
            test("should throw an error if appended event exceeds the maximum allowed sequence number", async () => {
                await expect(eventStore.append({ events: new EventType1(), condition })).rejects.toThrow(
                    "Expected Version fail: New events matching appendCondition found."
                )
            })

            test("should throw an AppendConditionError instance", async () => {
                await expect(eventStore.append({ events: new EventType1(), condition })).rejects.toThrow(
                    AppendConditionError
                )
            })

            test("should include the appendCondition in the thrown error", async () => {
                try {
                    await eventStore.append({ events: new EventType1(), condition })
                    expect.fail("Expected AppendConditionError to be thrown")
                } catch (error) {
                    expect(error).toBeInstanceOf(AppendConditionError)
                    const appendError = error as AppendConditionError
                    expect(appendError.appendCondition).toBe(condition)
                    expect(appendError.appendCondition.after).toBe(condition.after)
                    expect(appendError.appendCondition.failIfEventsMatch).toBe(condition.failIfEventsMatch)
                }
            })

            test("should have the correct error name", async () => {
                try {
                    await eventStore.append({ events: new EventType1(), condition })
                    expect.fail("Expected AppendConditionError to be thrown")
                } catch (error) {
                    expect(error).toBeInstanceOf(AppendConditionError)
                    expect((error as AppendConditionError).name).toBe("AppendConditionError")
                }
            })

            test("should be catchable as an Error", async () => {
                try {
                    await eventStore.append({ events: new EventType1(), condition })
                    expect.fail("Expected AppendConditionError to be thrown")
                } catch (error) {
                    expect(error).toBeInstanceOf(Error)
                    expect(error).toBeInstanceOf(AppendConditionError)
                }
            })
        })

        describe("when append condition with tag filter and maxSequencePosition provided", () => {
            test("should throw AppendConditionError when tag-filtered events exist beyond ceiling", async () => {
                const condition: AppendCondition = {
                    failIfEventsMatch: Query.fromItems([
                        { types: ["testEvent1"], tags: Tags.fromObj({ testTagKey: "tagA" }) }
                    ]),
                    after: SequencePosition.initial()
                }

                await eventStore.append({ events: new EventType1("tagA") })

                await expect(eventStore.append({ events: new EventType1("tagA"), condition })).rejects.toThrow(
                    AppendConditionError
                )
            })

            test("should not throw when tag-filtered events do not match", async () => {
                const condition: AppendCondition = {
                    failIfEventsMatch: Query.fromItems([
                        { types: ["testEvent1"], tags: Tags.fromObj({ testTagKey: "tagB" }) }
                    ]),
                    after: SequencePosition.initial()
                }

                await eventStore.append({ events: new EventType1("tagA") })

                await expect(eventStore.append({ events: new EventType1("tagA"), condition })).resolves.not.toThrow()
            })
        })

        describe("when append condition with after omitted (undefined)", () => {
            test("should throw when matching events exist and after is undefined", async () => {
                const condition: AppendCondition = {
                    failIfEventsMatch: Query.fromItems([
                        { types: ["testEvent1"], tags: Tags.fromObj({ testTagKey: "default" }) }
                    ])
                }
                await expect(eventStore.append({ events: new EventType1(), condition })).rejects.toThrow(
                    AppendConditionError
                )
            })

            test("should succeed when no matching events exist and after is undefined", async () => {
                const condition: AppendCondition = {
                    failIfEventsMatch: Query.fromItems([
                        { types: ["nonExistentEvent"], tags: Tags.fromObj({ testTagKey: "default" }) }
                    ])
                }
                await expect(eventStore.append({ events: new EventType1(), condition })).resolves.not.toThrow()
            })
        })

        describe("when append condition has multiple query items (OR semantics)", () => {
            test("should throw when any query item matches", async () => {
                const condition: AppendCondition = {
                    failIfEventsMatch: Query.fromItems([
                        { types: ["nonExistentEvent"], tags: Tags.fromObj({ testTagKey: "default" }) },
                        { types: ["testEvent1"], tags: Tags.fromObj({ testTagKey: "default" }) }
                    ]),
                    after: SequencePosition.initial()
                }
                await expect(eventStore.append({ events: new EventType1(), condition })).rejects.toThrow(
                    AppendConditionError
                )
            })

            test("should succeed when no query items match", async () => {
                const condition: AppendCondition = {
                    failIfEventsMatch: Query.fromItems([
                        { types: ["nonExistentEvent1"], tags: Tags.fromObj({ testTagKey: "default" }) },
                        { types: ["nonExistentEvent2"], tags: Tags.fromObj({ testTagKey: "default" }) }
                    ]),
                    after: SequencePosition.initial()
                }
                await expect(eventStore.append({ events: new EventType1(), condition })).resolves.not.toThrow()
            })
        })

        describe("when no append condition is provided", () => {
            test("should not throw any error", async () => {
                await expect(eventStore.append({ events: new EventType1() })).resolves.not.toThrow()
            })
        })

        test("test append count works", async () => {
            let appendCount = 0
            eventStore.on("append", () => appendCount++)
            await eventStore.append({ events: new EventType1() })

            expect(appendCount).toBe(1)
        })
    })

    describe("multi-command append", () => {
        beforeEach(() => {
            eventStore = new MemoryEventStore()
        })

        test("should execute multiple commands in one call", async () => {
            const pos = await eventStore.append([{ events: new EventType1("a") }, { events: new EventType1("b") }])
            expect(pos.toString() === "2").toBe(true)
            const events = await streamAllEventsToArray(eventStore.read(Query.all()))
            expect(events.length).toBe(2)
        })

        test("conditions check against pre-existing data only (not batch's own events)", async () => {
            const pos = await eventStore.append([
                {
                    events: new EventType1("a"),
                    condition: {
                        failIfEventsMatch: Query.fromItems([
                            { types: ["testEvent1"], tags: Tags.fromObj({ testTagKey: "a" }) }
                        ]),
                        after: SequencePosition.fromString("0")
                    }
                },
                {
                    events: new EventType1("b"),
                    condition: {
                        failIfEventsMatch: Query.fromItems([
                            { types: ["testEvent1"], tags: Tags.fromObj({ testTagKey: "b" }) }
                        ]),
                        after: SequencePosition.fromString("0")
                    }
                }
            ])
            expect(pos.toString() === "2").toBe(true)
        })

        test("detects pre-existing violation and includes commandIndex", async () => {
            await eventStore.append({ events: new EventType1("x") })
            try {
                await eventStore.append([
                    { events: new EventType1("y") },
                    {
                        events: new EventType1("x"),
                        condition: {
                            failIfEventsMatch: Query.fromItems([
                                { types: ["testEvent1"], tags: Tags.fromObj({ testTagKey: "x" }) }
                            ]),
                            after: SequencePosition.fromString("0")
                        }
                    }
                ])
                expect.fail("Expected AppendConditionError")
            } catch (error) {
                expect(error).toBeInstanceOf(AppendConditionError)
                expect((error as AppendConditionError).commandIndex).toBe(1)
            }
        })

        test("rolls back entire batch on condition failure", async () => {
            await eventStore.append({ events: new EventType1("x") })
            await expect(
                eventStore.append([
                    { events: new EventType1("y") },
                    {
                        events: new EventType1("x"),
                        condition: {
                            failIfEventsMatch: Query.fromItems([
                                { types: ["testEvent1"], tags: Tags.fromObj({ testTagKey: "x" }) }
                            ]),
                            after: SequencePosition.fromString("0")
                        }
                    }
                ])
            ).rejects.toThrow(AppendConditionError)

            const events = await streamAllEventsToArray(eventStore.read(Query.all()))
            expect(events.length).toBe(1)
        })

        test("single command does not include commandIndex in error", async () => {
            await eventStore.append({ events: new EventType1("x") })
            try {
                await eventStore.append({
                    events: new EventType1("x"),
                    condition: {
                        failIfEventsMatch: Query.fromItems([
                            { types: ["testEvent1"], tags: Tags.fromObj({ testTagKey: "x" }) }
                        ]),
                        after: SequencePosition.fromString("0")
                    }
                })
                expect.fail("Expected AppendConditionError")
            } catch (error) {
                expect(error).toBeInstanceOf(AppendConditionError)
                expect((error as AppendConditionError).commandIndex).toBeUndefined()
            }
        })
    })
})

describe("SequencedEvent property completeness — MemoryEventStore", () => {
    let eventStore: MemoryEventStore

    beforeEach(() => {
        eventStore = new MemoryEventStore()
    })

    const te = (type: string, tags: Tags = Tags.fromObj({ e: "1" })): TaggedEvent<Event> => ({
        event: { type, data: {} } as Event,
        tags
    })

    test("event.type and event.data match input", async () => {
        await eventStore.append({
            events: { event: { type: "myEvent", data: { value: 42 } } as Event, tags: Tags.fromObj({ e: "1" }) }
        })
        const [se] = await streamAllEventsToArray(eventStore.read(Query.all()))
        expect(se.event.type).toBe("myEvent")
        expect(se.event.data).toEqual({ value: 42 })
    })

    test("event.metadata propagates when provided", async () => {
        await eventStore.append({
            events: {
                event: { type: "myEvent", data: {}, metadata: { correlationId: "abc" } } as AnyEvent,
                tags: Tags.fromObj({ e: "1" })
            }
        })
        const [se] = await streamAllEventsToArray(eventStore.read(Query.all()))
        expect(se.event.metadata).toEqual({ correlationId: "abc" })
    })

    test("tags is on the SequencedEvent envelope, not inside event", async () => {
        const tags = Tags.fromObj({ courseId: "c1" })
        await eventStore.append({ events: { event: { type: "myEvent", data: {} } as Event, tags } })
        const [se] = await streamAllEventsToArray(eventStore.read(Query.all()))
        expect(se.tags.equals(tags)).toBe(true)
    })

    test("id is a non-empty string when not provided", async () => {
        await eventStore.append({ events: te("myEvent") })
        const [se] = await streamAllEventsToArray(eventStore.read(Query.all()))
        expect(typeof se.id).toBe("string")
        expect(se.id.length).toBeGreaterThan(0)
    })

    test("id is preserved when provided", async () => {
        const id = "00000000-0000-0000-0000-000000000001"
        await eventStore.append({ events: { ...te("myEvent"), id } })
        const [se] = await streamAllEventsToArray(eventStore.read(Query.all()))
        expect(se.id).toBe(id)
    })

    test("recordedAt is a Date instance", async () => {
        await eventStore.append({ events: te("myEvent") })
        const [se] = await streamAllEventsToArray(eventStore.read(Query.all()))
        expect(se.recordedAt).toBeInstanceOf(Date)
    })

    test("schemaVersion defaults to '1' when not provided", async () => {
        await eventStore.append({ events: te("myEvent") })
        const [se] = await streamAllEventsToArray(eventStore.read(Query.all()))
        expect(se.schemaVersion).toBe("1")
    })

    test("schemaVersion is preserved when provided", async () => {
        await eventStore.append({ events: { ...te("myEvent"), schemaVersion: "3" } })
        const [se] = await streamAllEventsToArray(eventStore.read(Query.all()))
        expect(se.schemaVersion).toBe("3")
    })
})
