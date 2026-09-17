import { decider, IllegalStateError, NotFoundError } from "@dcb-es/event-store"
import { studentWasSubscribed } from "../../Events.js"
import { CourseExists, CourseCapacity, StudentAlreadySubscribed, StudentSubscriptions } from "./decisionModels.js"
import type { SubscribeStudentToCourse } from "./command.js"

const STUDENT_SUBSCRIPTION_LIMIT = 5

export const subscribeStudentToCourse = decider<
    SubscribeStudentToCourse,
    {
        courseExists: ReturnType<typeof CourseExists>
        courseCapacity: ReturnType<typeof CourseCapacity>
        studentAlreadySubscribed: ReturnType<typeof StudentAlreadySubscribed>
        studentSubscriptions: ReturnType<typeof StudentSubscriptions>
    }
>({
    handlers: cmd => ({
        courseExists: CourseExists(cmd.data.courseId),
        courseCapacity: CourseCapacity(cmd.data.courseId),
        studentAlreadySubscribed: StudentAlreadySubscribed({
            courseId: cmd.data.courseId,
            studentId: cmd.data.studentId
        }),
        studentSubscriptions: StudentSubscriptions(cmd.data.studentId)
    }),
    decide: (cmd, state) => {
        if (!state.courseExists) throw new NotFoundError(`Course ${cmd.data.courseId} doesn't exist.`)
        if (state.courseCapacity.subscriberCount >= state.courseCapacity.capacity)
            throw new IllegalStateError(`Course ${cmd.data.courseId} is full.`)
        if (state.studentAlreadySubscribed)
            throw new IllegalStateError(
                `Student ${cmd.data.studentId} already subscribed to course ${cmd.data.courseId}.`
            )
        if (state.studentSubscriptions.subscriptionCount >= STUDENT_SUBSCRIPTION_LIMIT)
            throw new IllegalStateError(
                `Student ${cmd.data.studentId} is already subscribed to the maximum number of courses`
            )

        return studentWasSubscribed({
            courseId: cmd.data.courseId,
            studentId: cmd.data.studentId
        })
    }
})
