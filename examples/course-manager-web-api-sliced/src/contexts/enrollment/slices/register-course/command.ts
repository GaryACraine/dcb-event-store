import { Command } from "@dcb-es/event-store"

export type RegisterCourse = Command<"registerCourse", { id: string; title: string; capacity: number }>
