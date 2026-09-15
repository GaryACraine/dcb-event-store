import { DcbCommand } from "@dcb-es/event-store"

export type RegisterCourse = DcbCommand<"registerCourse", { id: string; title: string; capacity: number }>
