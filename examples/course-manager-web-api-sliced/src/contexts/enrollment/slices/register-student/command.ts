import { DcbCommand } from "@dcb-es/event-store"

export type RegisterStudent = DcbCommand<"registerStudent", { id: string; name: string }>
