import { decider, IllegalStateError } from "@dcb-es/event-store"
import { studentWasRegistered } from "../../Events.js"
import { StudentAlreadyRegistered, NextStudentNumber } from "./decisionModels.js"
import type { RegisterStudent } from "./command.js"

export const registerStudent = decider<
    RegisterStudent,
    {
        studentAlreadyRegistered: ReturnType<typeof StudentAlreadyRegistered>
        nextStudentNumber: ReturnType<typeof NextStudentNumber>
    }
>({
    handlers: cmd => ({
        studentAlreadyRegistered: StudentAlreadyRegistered(cmd.data.id),
        nextStudentNumber: NextStudentNumber()
    }),
    decide: (cmd, state) => {
        if (state.studentAlreadyRegistered)
            throw new IllegalStateError(`Student with id ${cmd.data.id} already registered.`)

        return studentWasRegistered({
            studentId: cmd.data.id,
            name: cmd.data.name,
            studentNumber: state.nextStudentNumber
        })
    }
})
