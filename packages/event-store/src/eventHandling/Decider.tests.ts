import { describe, test, expect } from "vitest"
import { decider, handle, handleCommand } from "./Decider.js"
import { Command } from "../eventStore/Command.js"
import { AppendCommand, EventStore, SequencedEvent, TaggedEvent } from "../eventStore/EventStore.js"
import { SequencePosition } from "../eventStore/SequencePosition.js"
import { IllegalStateError } from "../eventStore/errors.js"
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
