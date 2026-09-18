import { EventHandlerWithState, Tags } from "@dcb-es/event-store"
import { StudentWasRegistered } from "../../Events.js"

export const StudentAlreadyRegistered = (studentId: string): EventHandlerWithState<StudentWasRegistered, boolean> => ({
    tagFilter: Tags.fromObj({ studentId }),
    init: false,
    when: {
        studentWasRegistered: () => true
    }
})

export const NextStudentNumber = (): EventHandlerWithState<StudentWasRegistered, number> => ({
    tagFilter: Tags.fromObj({ studentNumberIndex: "global" }),
    init: 1,
    onlyLastEvent: true,
    when: {
        studentWasRegistered: ({ event }) => event.data.studentNumber + 1
    }
})
