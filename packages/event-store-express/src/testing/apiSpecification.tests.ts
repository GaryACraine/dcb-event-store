import { describe, it, expect } from "vitest"
import type { EventStore } from "@dcb-es/event-store"
import { Tags, DcbEvent, IllegalStateError } from "@dcb-es/event-store"
import { on } from "../handler.js"
import { OK, Created, NoContent } from "../responses.js"
import type { WebApiSetup } from "../application.js"
import { ApiSpecification, expectResponse, expectError } from "./apiSpecification.js"

// Minimal inline domain for testing

class ItemCreatedEvent implements DcbEvent {
    type: "itemCreated" = "itemCreated"
    tags: Tags
    data: { id: string; name: string }
    metadata: unknown = {}

    constructor({ id, name }: { id: string; name: string }) {
        this.tags = Tags.fromObj({ itemId: id })
        this.data = { id, name }
    }
}

function configureTestApi(store: EventStore): WebApiSetup {
    return router => {
        router.post(
            "/items",
            on(async req => {
                const { id, name } = req.body as { id: string; name: string }

                // Read events to check if item exists
                const existing: DcbEvent[] = []
                for await (const se of store.read({
                    isAll: false,
                    items: [{ types: ["itemCreated"], tags: Tags.fromObj({ itemId: id }) }]
                } as never)) {
                    existing.push(se.event)
                }

                if (existing.length > 0) {
                    throw new IllegalStateError(`Item ${id} already exists`)
                }

                await store.append({ events: new ItemCreatedEvent({ id, name }) })
                return Created({ createdId: id })
            })
        )

        router.get(
            "/items/:id",
            on(async req => {
                const { id } = req.params
                const events: DcbEvent[] = []
                for await (const se of store.read({
                    isAll: false,
                    items: [{ types: ["itemCreated"], tags: Tags.fromObj({ itemId: id }) }]
                } as never)) {
                    events.push(se.event)
                }
                if (events.length === 0) {
                    throw new (await import("@dcb-es/event-store")).NotFoundError(`Item ${id} not found`)
                }
                const item = events[0] as ItemCreatedEvent
                return OK({ body: { id: item.data.id, name: item.data.name } })
            })
        )

        router.delete(
            "/items/:id",
            on(async req => {
                const { id } = req.params
                if (!id) throw new IllegalStateError("no id")
                return NoContent()
            })
        )
    }
}

// Simpler API for event-focused tests that uses Query.all
import { Query } from "@dcb-es/event-store"

function configureSimpleApi(store: EventStore): WebApiSetup {
    return router => {
        router.post(
            "/things",
            on(async req => {
                const { id, name } = req.body as { id: string; name: string }
                const events: DcbEvent[] = []
                for await (const se of store.read(Query.all())) {
                    if (se.event.type === "itemCreated" && (se.event.data as { id: string }).id === id) {
                        events.push(se.event)
                    }
                }
                if (events.length > 0) throw new IllegalStateError(`Item ${id} already exists`)
                await store.append({ events: new ItemCreatedEvent({ id, name }) })
                return Created({ createdId: id })
            })
        )
    }
}

describe("ApiSpecification", () => {
    it("asserts response status", async () => {
        await ApiSpecification.for({ configureApi: configureTestApi })
            .when(agent => agent.get("/items/nonexistent"))
            .then(expectResponse(404))
    })

    it("asserts response body (partial match)", async () => {
        await ApiSpecification.for({ configureApi: configureTestApi })
            .when(agent => agent.post("/items").send({ id: "x1", name: "Widget" }))
            .then(expectResponse(201, { body: { id: "x1" } }))
    })

    it("asserts new events appended by request", async () => {
        await ApiSpecification.for({ configureApi: configureSimpleApi })
            .when(agent => agent.post("/things").send({ id: "t1", name: "Thing One" }))
            .then(expectResponse(201), new ItemCreatedEvent({ id: "t1", name: "Thing One" }))
    })

    it("seeded events affect decision outcome — duplicate rejected", async () => {
        await ApiSpecification.for({ configureApi: configureSimpleApi })
            .existingEvents(new ItemCreatedEvent({ id: "t1", name: "Thing One" }))
            .when(agent => agent.post("/things").send({ id: "t1", name: "Thing One" }))
            .then(expectResponse(422))
    })

    it("thenEvents asserts events without response check", async () => {
        await ApiSpecification.for({ configureApi: configureSimpleApi })
            .when(agent => agent.post("/things").send({ id: "t2", name: "Thing Two" }))
            .thenEvents(new ItemCreatedEvent({ id: "t2", name: "Thing Two" }))
    })

    it("thenNothingAppended passes when no events appended", async () => {
        await ApiSpecification.for({ configureApi: configureTestApi })
            .when(agent => agent.get("/items/nonexistent"))
            .thenNothingAppended(expectResponse(404))
    })

    it("thenNothingAppended fails when events were appended", async () => {
        await expect(
            ApiSpecification.for({ configureApi: configureSimpleApi })
                .when(agent => agent.post("/things").send({ id: "t3", name: "Thing Three" }))
                .thenNothingAppended()
        ).rejects.toThrow("Expected no new events")
    })

    it("expectError checks problem+json content-type and status", async () => {
        await ApiSpecification.for({ configureApi: configureSimpleApi })
            .existingEvents(new ItemCreatedEvent({ id: "dup", name: "Dup" }))
            .when(agent => agent.post("/things").send({ id: "dup", name: "Dup" }))
            .then(expectError(422, { title: "Unprocessable Entity" }))
    })

    it("creates a fresh store per chain — no shared state", async () => {
        const spec = ApiSpecification.for({ configureApi: configureSimpleApi })

        // First chain seeds t4 via existingEvents
        await spec
            .existingEvents(new ItemCreatedEvent({ id: "t4", name: "Thing Four" }))
            .when(agent => agent.post("/things").send({ id: "t4", name: "Thing Four" }))
            .then(expectResponse(422))

        // Second chain has a fresh store — t4 does not exist
        await spec.when(agent => agent.post("/things").send({ id: "t4", name: "Thing Four" })).then(expectResponse(201))
    })

    it("seeded events do not appear in newEvents assertions", async () => {
        await ApiSpecification.for({ configureApi: configureSimpleApi })
            .existingEvents(new ItemCreatedEvent({ id: "seed", name: "Seed" }))
            .when(agent => agent.post("/things").send({ id: "new", name: "New" }))
            .thenEvents(new ItemCreatedEvent({ id: "new", name: "New" }))
    })
})
