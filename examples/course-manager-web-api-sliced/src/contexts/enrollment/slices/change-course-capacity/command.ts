import { DcbCommand } from "@dcb-es/event-store"

export type UpdateCourseCapacity = DcbCommand<"updateCourseCapacity", { courseId: string; newCapacity: number }>
