import { Command } from "@dcb-es/event-store"

export type UnsubscribeStudentFromCourse = Command<
    "unsubscribeStudentFromCourse",
    { courseId: string; studentId: string }
>
