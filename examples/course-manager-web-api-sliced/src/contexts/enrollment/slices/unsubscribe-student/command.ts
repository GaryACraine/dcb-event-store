import { DcbCommand } from "@dcb-es/event-store"

export type UnsubscribeStudentFromCourse = DcbCommand<
    "unsubscribeStudentFromCourse",
    { courseId: string; studentId: string }
>
