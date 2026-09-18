import type { EventStore } from "@dcb-es/event-store"
import type { Pool } from "pg"

export interface SliceDependencies {
    store: EventStore
    pool: Pool
}
