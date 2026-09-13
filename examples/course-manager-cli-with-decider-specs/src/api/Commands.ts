import { DcbCommand } from "@dcb-es/event-store"

export type RegisterCourse = DcbCommand<"registerCourse", { id: string; title: string; capacity: number }>
export type RegisterStudent = DcbCommand<"registerStudent", { id: string; name: string }>
export type UpdateCourseCapacity = DcbCommand<"updateCourseCapacity", { courseId: string; newCapacity: number }>
export type UpdateCourseTitle = DcbCommand<"updateCourseTitle", { courseId: string; newTitle: string }>
export type SubscribeStudentToCourse = DcbCommand<"subscribeStudentToCourse", { courseId: string; studentId: string }>
export type UnsubscribeStudentFromCourse = DcbCommand<
    "unsubscribeStudentFromCourse",
    { courseId: string; studentId: string }
>
