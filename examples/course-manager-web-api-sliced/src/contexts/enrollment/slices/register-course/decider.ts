import { decider, IllegalStateError } from "@dcb-es/event-store"
import { courseWasRegistered } from "../../Events.js"
import { CourseExists } from "./decisionModels.js"
import type { RegisterCourse } from "./command.js"

export const registerCourse = decider<RegisterCourse, { courseExists: ReturnType<typeof CourseExists> }>({
    handlers: cmd => ({
        courseExists: CourseExists(cmd.data.id)
    }),
    decide: (cmd, state) => {
        if (state.courseExists) throw new IllegalStateError(`Course with id ${cmd.data.id} already exists`)

        return courseWasRegistered({
            courseId: cmd.data.id,
            title: cmd.data.title,
            capacity: cmd.data.capacity
        })
    }
})
