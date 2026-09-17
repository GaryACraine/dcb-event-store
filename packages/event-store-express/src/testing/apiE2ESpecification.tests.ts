import { describe, it } from "vitest"
import type { EventStore } from "@dcb-es/event-store"
import { Tags, AnyEvent, Event, TaggedEvent, IllegalStateError, Query } from "@dcb-es/event-store"
import { on } from "../handler.js"
import { OK, Created, NoContent } from "../responses.js"
import type { WebApiSetup } from "../application.js"
import { ApiE2ESpecification } from "./apiE2ESpecification.js"
import { expectResponse, expectError } from "./apiSpecification.js"

const makeItemCreated = ({ id, name }: { id: string; name: string }): TaggedEvent<AnyEvent> => ({
    event: { type: "itemCreated", data: { id, name } } as AnyEvent,
    tags: Tags.fromObj({ itemId: id })
})

function configureApi(store: EventStore): WebApiSetup {
    return router => {
        router.post(
            "/items",
            on(async req => {
                const { id, name } = req.body as { id: string; name: string }
                const events: Event[] = []
                for await (const se of store.read(Query.all())) {
                    if (se.event.type === "itemCreated" && (se.event.data as { id: string }).id === id) {
                        events.push(se.event)
                    }
                }
                if (events.length > 0) throw new IllegalStateError(`Item ${id} already exists`)
                await store.append({ events: makeItemCreated({ id, name }) })
                return Created({ createdId: id })
            })
        )

        router.delete(
            "/items/:id",
            on(async req => {
                const { id } = req.params
                const events: Event[] = []
                for await (const se of store.read(Query.all())) {
                    if (se.event.type === "itemCreated" && (se.event.data as { id: string }).id === id) {
                        events.push(se.event)
                    }
                }
                if (events.length === 0) {
                    throw new (await import("@dcb-es/event-store")).NotFoundError(`Item ${id} not found`)
                }
                return NoContent()
            })
        )

        router.get(
            "/items",
            on(async () => {
                const items: { id: string; name: string }[] = []
                for await (const se of store.read(Query.all())) {
                    if (se.event.type === "itemCreated") {
                        items.push(se.event.data as { id: string; name: string })
                    }
                }
                return OK({ body: items })
            })
        )
    }
}

describe("ApiE2ESpecification", () => {
    it("builds state through prior HTTP requests and asserts the subsequent response", async () => {
        await ApiE2ESpecification.for({ configureApi })
            .existingRequests(agent => agent.post("/items").send({ id: "i1", name: "Item One" }))
            .when(agent => agent.post("/items").send({ id: "i1", name: "Item One" }))
            .then(expectError(422))
    })

    it("can chain multiple setup requests", async () => {
        await ApiE2ESpecification.for({ configureApi })
            .existingRequests(
                agent => agent.post("/items").send({ id: "a", name: "Alpha" }),
                agent => agent.post("/items").send({ id: "b", name: "Beta" })
            )
            .when(agent => agent.get("/items"))
            .then(expectResponse(200, { body: [{ id: "a" }, { id: "b" }] }))
    })

    it("can create then delete an item", async () => {
        await ApiE2ESpecification.for({ configureApi })
            .existingRequests(agent => agent.post("/items").send({ id: "del1", name: "To Delete" }))
            .when(agent => agent.delete("/items/del1"))
            .then(expectResponse(204))
    })

    it("starts with a fresh store per chain — no shared state", async () => {
        const spec = ApiE2ESpecification.for({ configureApi })

        await spec
            .existingRequests(agent => agent.post("/items").send({ id: "x", name: "X" }))
            .when(agent => agent.post("/items").send({ id: "x", name: "X" }))
            .then(expectError(422))

        // Second chain — x does not exist
        await spec.when(agent => agent.post("/items").send({ id: "x", name: "X" })).then(expectResponse(201))
    })

    it("supports when() without existingRequests", async () => {
        await ApiE2ESpecification.for({ configureApi })
            .when(agent => agent.post("/items").send({ id: "direct", name: "Direct" }))
            .then(expectResponse(201))
    })
})
