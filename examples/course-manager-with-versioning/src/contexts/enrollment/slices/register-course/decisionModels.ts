import { EventHandlerWithState, Tags } from "@dcb-es/event-store"
import { CourseWasRegisteredEvent } from "../../Events.js"

/**
 * CourseExists — no versioning needed.
 * All versions of courseWasRegistered mean the course exists. The handler
 * ignores the data entirely, so schema evolution is irrelevant here.
 */
export const CourseExists = (courseId: string): EventHandlerWithState<CourseWasRegisteredEvent, boolean> => ({
    tagFilter: Tags.fromObj({ courseId }),
    init: false,
    when: {
        courseWasRegistered: () => true
    }
})
