import { Command } from "@dcb-es/event-store"

export type RegisterCourse = Command<
    "registerCourse",
    { id: string; name: string; description: string; capacity: number; department: string }
>
