import { decider, NotFoundError, ValidationError } from "@dcb-es/event-store"
import { CourseCapacityWasChangedEvent } from "../../Events.js"
import { CourseExists, CourseCapacity } from "./decisionModels.js"
import type { UpdateCourseCapacity } from "./command.js"

export const updateCourseCapacity = decider<
    UpdateCourseCapacity,
    { courseExists: ReturnType<typeof CourseExists>; courseCapacity: ReturnType<typeof CourseCapacity> }
>({
    handlers: cmd => ({
        courseExists: CourseExists(cmd.data.courseId),
        courseCapacity: CourseCapacity(cmd.data.courseId)
    }),
    decide: (cmd, state) => {
        if (!state.courseExists) throw new NotFoundError(`Course ${cmd.data.courseId} doesn't exist.`)
        if (state.courseCapacity.capacity === cmd.data.newCapacity)
            throw new ValidationError("New capacity is the same as the current capacity.")

        return new CourseCapacityWasChangedEvent({
            courseId: cmd.data.courseId,
            newCapacity: cmd.data.newCapacity
        })
    }
})
