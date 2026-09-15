import { EventHandlerWithState, Tags } from "@dcb-es/event-store"
import { CourseWasRegisteredEvent } from "../../Events.js"

export const CourseExists = (courseId: string): EventHandlerWithState<CourseWasRegisteredEvent, boolean> => ({
    tagFilter: Tags.fromObj({ courseId }),
    init: false,
    when: {
        courseWasRegistered: () => true
    }
})
