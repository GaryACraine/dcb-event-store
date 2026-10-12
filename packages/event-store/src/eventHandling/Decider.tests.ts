import { describe, test, expect } from "vitest"
import { ConflictRetryDefaults, decider, handle, handleCommand } from "./Decider.js"
import { Command } from "../eventStore/Command.js"
import { AppendCommand, EventStore, SequencedEvent, TaggedEvent } from "../eventStore/EventStore.js"
import { SequencePosition } from "../eventStore/SequencePosition.js"
import { IllegalStateError } from "../eventStore/errors.js"
import { AppendConditionError } from "../eventStore/AppendConditionError.js"
import { CourseExists } from "./buildDecisionModel.tests.handlers.js"
import { CourseWasRegisteredEvent } from "./buildDecisionModel.tests.events.js"

// A store holding the given events, recording what is appended
function storeWith(...events: TaggedEvent[]) {
    const appended: AppendCommand[] = []
    const sequenced: SequencedEvent[] = events.map((e, i) => ({
        ...e,
        position: SequencePosition.fromString(String(i + 1)),
        id: `e${i + 1}`,
        recordedAt: new Date()
    }))
    const store: EventStore = {
        append: async command => {
            appended.push(...(Array.isArray(command) ? command : [command]))
            return SequencePosition.fromString(String(sequenced.length + 1))
        },
        read: async function* () {
            yield* sequenced
        },
        subscribe: async function* () {}
    }
    return { store, appended }
}

type RegisterCourse = Command<"registerCourse", { id: string; capacity: number }>

// Registering a course that exists is a no-op when it's the same course; another capacity is refused
const registerCourse = decider<RegisterCourse, { courseExists: ReturnType<typeof CourseExists> }>({
    handlers: cmd => ({ courseExists: CourseExists(cmd.data.id) }),
    decide: (cmd, state) => {
        if (!state.courseExists)
            return new CourseWasRegisteredEvent({ courseId: cmd.data.id, capacity: cmd.data.capacity })
        if (cmd.data.capacity === 10) return []
        throw new IllegalStateError(`Course ${cmd.data.id} already exists with another capacity`)
    }
})
const register = (capacity: number): RegisterCourse => ({ type: "registerCourse", data: { id: "c1", capacity } })

describe("handle: a decision of no events", () => {
    test("appends what the decider decides, and says so", async () => {
        const { store, appended } = storeWith()
        const result = await handleCommand(store, registerCourse, register(10))
        expect(appended).toHaveLength(1)
        expect(result.events).toHaveLength(1)
        expect(result.position.toString()).toBe("1")
    })

    test("appends nothing and throws nothing when the decider decides nothing", async () => {
        const { store, appended } = storeWith(new CourseWasRegisteredEvent({ courseId: "c1", capacity: 10 }))
        const result = await handleCommand(store, registerCourse, register(10))
        expect(appended).toHaveLength(0)
        expect(result.events).toEqual([])
        // the position the decision was read at: the last event it read
        expect(result.position.toString()).toBe("1")
    })

    test("handle returns that read position for a decision of nothing", async () => {
        const { store, appended } = storeWith(new CourseWasRegisteredEvent({ courseId: "c1", capacity: 10 }))
        const position = await handle(store, registerCourse, register(10), { idempotencyKey: "k1" })
        expect(appended).toHaveLength(0)
        expect(position.toString()).toBe("1")
    })

    test("a decision of nothing with no events read is at the initial position", async () => {
        const nothing = decider<RegisterCourse, { courseExists: ReturnType<typeof CourseExists> }>({
            handlers: cmd => ({ courseExists: CourseExists(cmd.data.id) }),
            decide: () => []
        })
        const { store } = storeWith()
        const result = await handleCommand(store, nothing, register(10))
        expect(result.position.toString()).toBe(SequencePosition.initial().toString())
    })

    test("a refusal is still a refusal", async () => {
        const { store, appended } = storeWith(new CourseWasRegisteredEvent({ courseId: "c1", capacity: 10 }))
        await expect(handleCommand(store, registerCourse, register(5))).rejects.toThrow(IllegalStateError)
        expect(appended).toHaveLength(0)
    })
})

// A store where another append gets there first `losses` times: each time, the winner's event lands, and the append
// fails its condition. Then appends succeed.
function racingStore(winner: TaggedEvent, losses = 1) {
    const { store, appended } = storeWith()
    const sequenced: SequencedEvent[] = []
    let lost = 0
    const attempts: AppendCommand[] = []
    const racing: EventStore = {
        append: async command => {
            const commands = Array.isArray(command) ? command : [command]
            attempts.push(...commands)
            if (lost < losses) {
                lost++
                sequenced.push({
                    ...winner,
                    position: SequencePosition.fromString(String(sequenced.length + 1)),
                    id: `w${lost}`,
                    recordedAt: new Date()
                })
                throw new AppendConditionError(commands[0].condition!)
            }
            return store.append(command)
        },
        read: async function* () {
            yield* sequenced
        },
        subscribe: async function* () {}
    }
    return { store: racing, appended, attempts }
}

const fast = { backoff: { initialMs: 1, maxMs: 1 } }
const otherCourse = new CourseWasRegisteredEvent({ courseId: "c1", capacity: 10 })

describe("handle: deciding again after a conflict", () => {
    test("without retry, a conflict is the caller's", async () => {
        const { store, attempts } = racingStore(otherCourse)
        await expect(handleCommand(store, registerCourse, register(5))).rejects.toThrow(AppendConditionError)
        expect(attempts).toHaveLength(1)
    })

    test("decides again, and the second decision sees the winner: the decider's own refusal", async () => {
        const { store, attempts, appended } = racingStore(otherCourse)
        await expect(
            handleCommand(store, registerCourse, register(5), { retry: { onConflict: { retries: 3, ...fast } } })
        ).rejects.toThrow(IllegalStateError)
        expect(attempts).toHaveLength(1)
        expect(appended).toHaveLength(0)
    })

    test("decides again, and the second decision may be nothing: the same intent already holds", async () => {
        const { store, appended } = racingStore(otherCourse)
        const result = await handleCommand(store, registerCourse, register(10), { retry: { onConflict: { ...fast } } })
        expect(result.events).toEqual([])
        expect(appended).toHaveLength(0)
    })

    test("appends on a later attempt under the new condition, with the same idempotent ids", async () => {
        const unrelated = new CourseWasRegisteredEvent({ courseId: "c2", capacity: 1 })
        const { store, attempts, appended } = racingStore(unrelated, 2)
        const result = await handleCommand(store, registerCourse, register(5), {
            idempotencyKey: "00000000-0000-4000-8000-000000000001",
            retry: { onConflict: { retries: 3, ...fast } }
        })
        expect(attempts).toHaveLength(3)
        expect(appended).toHaveLength(1)
        expect(result.events).toHaveLength(1)
        expect(attempts.map(a => (a.events as TaggedEvent[])[0].id)).toEqual(
            Array(3).fill("00000000-0000-4000-8000-000000000001")
        )
    })

    test("gives up after its retries, with the conflict", async () => {
        const unrelated = new CourseWasRegisteredEvent({ courseId: "c2", capacity: 1 })
        const { store, attempts } = racingStore(unrelated, 5)
        await expect(
            handleCommand(store, registerCourse, register(5), { retry: { onConflict: { retries: 2, ...fast } } })
        ).rejects.toThrow(AppendConditionError)
        expect(attempts).toHaveLength(3)
    })

    test("never retries another error", async () => {
        let reads = 0
        const failing: EventStore = {
            append: async () => {
                throw new Error("connection lost")
            },
            read: async function* () {
                reads++
                yield* []
            },
            subscribe: async function* () {}
        }
        await expect(
            handleCommand(failing, registerCourse, register(5), { retry: { onConflict: { retries: 3, ...fast } } })
        ).rejects.toThrow("connection lost")
        expect(reads).toBe(1)
    })

    test("a conflict from another copy of the package is known by its code", async () => {
        const foreign = Object.assign(new Error("Expected Version fail"), { code: "APPEND_CONDITION" })
        let calls = 0
        const store: EventStore = {
            append: async () => {
                if (calls++ === 0) throw foreign
                return SequencePosition.fromString("1")
            },
            read: async function* () {},
            subscribe: async function* () {}
        }
        await handleCommand(store, registerCourse, register(5), { retry: { onConflict: { ...fast } } })
        expect(calls).toBe(2)
    })

    test("true takes the defaults: 3 retries from 100 ms", () => {
        expect(ConflictRetryDefaults).toEqual({ retries: 3, backoff: { initialMs: 100, maxMs: 1000 } })
    })
})
