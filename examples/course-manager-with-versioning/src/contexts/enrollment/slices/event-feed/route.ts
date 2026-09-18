import { sseEventFeed, type WebApiSetup } from "@dcb-es/event-store-express"
import type { EventStore } from "@dcb-es/event-store"

export function configureEventFeedRoute(store: EventStore): WebApiSetup {
    return router => {
        router.get("/events", sseEventFeed(store))
    }
}
