import { DcbCommand } from "@dcb-es/event-store"

export type SubscribeStudentToCourse = DcbCommand<"subscribeStudentToCourse", { courseId: string; studentId: string }>
