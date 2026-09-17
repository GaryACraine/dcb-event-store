import { Command } from "@dcb-es/event-store"

export type RegisterCourse = Command<"registerCourse", { id: string; title: string; capacity: number }>
export type RegisterStudent = Command<"registerStudent", { id: string; name: string }>
export type UpdateCourseCapacity = Command<"updateCourseCapacity", { courseId: string; newCapacity: number }>
export type UpdateCourseTitle = Command<"updateCourseTitle", { courseId: string; newTitle: string }>
export type SubscribeStudentToCourse = Command<"subscribeStudentToCourse", { courseId: string; studentId: string }>
export type UnsubscribeStudentFromCourse = Command<
    "unsubscribeStudentFromCourse",
    { courseId: string; studentId: string }
>
