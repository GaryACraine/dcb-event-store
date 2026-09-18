import { Command } from "@dcb-es/event-store"

export type UpdateCourseCapacity = Command<"updateCourseCapacity", { courseId: string; newCapacity: number }>
