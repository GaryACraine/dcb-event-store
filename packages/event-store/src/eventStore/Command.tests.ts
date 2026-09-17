import { describe, expect, it } from "vitest"
import {
    Command,
    AnyCommand,
    CommandTypeOf,
    CommandDataOf,
    CommandMetaDataOf,
    DefaultCommandMetadata,
    command
} from "./Command.js"

describe("Command", () => {
    type RegisterCourse = Command<"registerCourse", { id: string; capacity: number }>
    type ChangeCourseCapacity = Command<
        "changeCourseCapacity",
        { courseId: string; newCapacity: number },
        { userId: string } & DefaultCommandMetadata
    >

    it("supports plain object literals without metadata", () => {
        const cmd: RegisterCourse = {
            type: "registerCourse",
            data: { id: "c-1", capacity: 30 }
        }

        expect(cmd.type).toBe("registerCourse")
        expect(cmd.data).toEqual({ id: "c-1", capacity: 30 })
        expect(cmd.metadata).toBeUndefined()
    })

    it("creates commands using the command builder factory function without metadata", () => {
        const cmd = command<RegisterCourse>("registerCourse", {
            id: "c-1",
            capacity: 30
        })

        expect(cmd.type).toBe("registerCourse")
        expect(cmd.data).toEqual({ id: "c-1", capacity: 30 })
        expect(cmd.kind).toBe("Command")
        expect(cmd.metadata).toBeUndefined()
    })

    it("creates commands with optional default metadata using the command builder", () => {
        const now = new Date()
        const cmd = command<RegisterCourse>("registerCourse", { id: "c-1", capacity: 30 }, { now })

        expect(cmd.type).toBe("registerCourse")
        expect(cmd.data).toEqual({ id: "c-1", capacity: 30 })
        expect(cmd.kind).toBe("Command")
        expect(cmd.metadata).toEqual({ now })
    })

    it("creates commands with explicit metadata requirements using the command builder", () => {
        const cmd = command<ChangeCourseCapacity>(
            "changeCourseCapacity",
            { courseId: "c-1", newCapacity: 50 },
            { userId: "user-123", now: new Date() }
        )

        expect(cmd.type).toBe("changeCourseCapacity")
        expect(cmd.data).toEqual({ courseId: "c-1", newCapacity: 50 })
        expect(cmd.metadata).toHaveProperty("userId", "user-123")
        expect(cmd.kind).toBe("Command")
    })

    it("extracts type, data, and metadata using utility types", () => {
        type RegType = CommandTypeOf<RegisterCourse>
        type RegData = CommandDataOf<RegisterCourse>
        type RegMeta = CommandMetaDataOf<RegisterCourse>

        type ChangeType = CommandTypeOf<ChangeCourseCapacity>
        type ChangeData = CommandDataOf<ChangeCourseCapacity>
        type ChangeMeta = CommandMetaDataOf<ChangeCourseCapacity>

        // Type level assertions via assignments
        const typeVal: RegType = "registerCourse"
        const dataVal: RegData = { id: "c-1", capacity: 30 }
        const metaVal: RegMeta = undefined

        expect(typeVal).toBe("registerCourse")
        expect(dataVal).toEqual({ id: "c-1", capacity: 30 })
        expect(metaVal).toBeUndefined()

        const changeTypeVal: ChangeType = "changeCourseCapacity"
        const changeDataVal: ChangeData = { courseId: "c-1", newCapacity: 50 }
        const changeMetaVal: ChangeMeta = { userId: "user-123", now: new Date() }

        expect(changeTypeVal).toBe("changeCourseCapacity")
        expect(changeDataVal).toEqual({ courseId: "c-1", newCapacity: 50 })
        expect(changeMetaVal).toHaveProperty("userId", "user-123")
    })

    it("allows AnyCommand as a high-level constraint", () => {
        const checkCommand = (cmd: AnyCommand) => {
            return cmd.type
        }

        const cmd1 = command<RegisterCourse>("registerCourse", { id: "c-1", capacity: 30 })
        const cmd2 = command<ChangeCourseCapacity>(
            "changeCourseCapacity",
            { courseId: "c-1", newCapacity: 50 },
            { userId: "user-123", now: new Date() }
        )

        expect(checkCommand(cmd1)).toBe("registerCourse")
        expect(checkCommand(cmd2)).toBe("changeCourseCapacity")
    })
})
