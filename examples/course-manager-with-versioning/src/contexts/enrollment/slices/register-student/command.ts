import { Command } from "@dcb-es/event-store"

export type RegisterStudent = Command<"registerStudent", { id: string; name: string }>
