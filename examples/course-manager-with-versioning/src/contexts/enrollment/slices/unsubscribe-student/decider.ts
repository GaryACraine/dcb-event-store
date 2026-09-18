import { decider, NotFoundError } from "@dcb-es/event-store"
import { studentWasUnsubscribed } from "../../Events.js"
import { CourseExists, StudentAlreadySubscribed } from "./decisionModels.js"
import type { UnsubscribeStudentFromCourse } from "./command.js"

export const unsubscribeStudentFromCourse = decider<
    UnsubscribeStudentFromCourse,
    {
        studentAlreadySubscribed: ReturnType<typeof StudentAlreadySubscribed>
        courseExists: ReturnType<typeof CourseExists>
    }
>({
    handlers: cmd => ({
        studentAlreadySubscribed: StudentAlreadySubscribed({
            courseId: cmd.data.courseId,
            studentId: cmd.data.studentId
        }),
        courseExists: CourseExists(cmd.data.courseId)
    }),
    decide: (cmd, state) => {
        if (!state.courseExists) throw new NotFoundError(`Course ${cmd.data.courseId} doesn't exist.`)
        if (!state.studentAlreadySubscribed)
            throw new NotFoundError(`Student ${cmd.data.studentId} is not subscribed to course ${cmd.data.courseId}.`)

        return studentWasUnsubscribed({
            courseId: cmd.data.courseId,
            studentId: cmd.data.studentId
        })
    }
})
