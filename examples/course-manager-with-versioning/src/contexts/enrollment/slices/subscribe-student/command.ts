import { Command } from "@dcb-es/event-store"

export type SubscribeStudentToCourse = Command<"subscribeStudentToCourse", { courseId: string; studentId: string }>
