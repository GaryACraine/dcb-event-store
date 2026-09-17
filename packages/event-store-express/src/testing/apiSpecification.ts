import supertest from "supertest"
import type { Response, Test } from "supertest"
import type { Agent as TestAgent } from "supertest"
import type { ErrorToProblemDetailsMapping, ProblemDetails } from "@dcb-es/event-store-web"
import type { TaggedEvent, EventStore, SequencedEvent } from "@dcb-es/event-store"
import { MemoryEventStore, Query, streamAllEventsToArray, assertNewEvents, assertMatches } from "@dcb-es/event-store"
import { getApplication, type WebApiSetup } from "../application.js"

export type TestRequest = (agent: TestAgent) => Test

export type ResponseAssert = (response: Response) => void

export interface ApiSpecificationOptions {
    configureApi: (eventStore: EventStore) => WebApiSetup
    mapError?: ErrorToProblemDetailsMapping
}

export class ApiSpecification {
    private constructor(private readonly options: ApiSpecificationOptions) {}

    static for(options: ApiSpecificationOptions): ApiSpecification {
        return new ApiSpecification(options)
    }

    existingEvents(...events: TaggedEvent[]): GivenStage {
        return new GivenStage(this.options, events)
    }

    when(request: TestRequest): WhenStage {
        return new GivenStage(this.options, []).when(request)
    }
}

class GivenStage {
    constructor(
        private readonly options: ApiSpecificationOptions,
        private readonly givenEvents: TaggedEvent[]
    ) {}

    when(request: TestRequest): WhenStage {
        return new WhenStage(this.options, this.givenEvents, request)
    }
}

class WhenStage {
    private readonly resultPromise: Promise<{
        response: Response
        newEvents: SequencedEvent[]
    }>

    constructor(
        private readonly options: ApiSpecificationOptions,
        private readonly givenEvents: TaggedEvent[],
        private readonly request: TestRequest
    ) {
        this.resultPromise = this.execute()
    }

    private async execute(): Promise<{ response: Response; newEvents: SequencedEvent[] }> {
        const store = new MemoryEventStore()

        let givenPosition = undefined
        if (this.givenEvents.length > 0) {
            givenPosition = await store.append({ events: this.givenEvents })
        }

        const app = getApplication({
            apis: [this.options.configureApi(store)],
            mapError: this.options.mapError
        })

        const agent = supertest(app)
        const response = await this.request(agent)

        const newEvents = await streamAllEventsToArray(
            store.read(Query.all(), givenPosition ? { after: givenPosition } : undefined)
        )

        return { response, newEvents }
    }

    async then(responseAssert: ResponseAssert, ...expectedEvents: TaggedEvent[]): Promise<void> {
        const { response, newEvents } = await this.resultPromise
        responseAssert(response)
        if (expectedEvents.length > 0) {
            assertNewEvents(newEvents, expectedEvents)
        }
    }

    async thenEvents(...expectedEvents: TaggedEvent[]): Promise<void> {
        const { newEvents } = await this.resultPromise
        assertNewEvents(newEvents, expectedEvents)
    }

    async thenNothingAppended(responseAssert?: ResponseAssert): Promise<void> {
        const { response, newEvents } = await this.resultPromise
        if (responseAssert) responseAssert(response)
        if (newEvents.length > 0) {
            throw new Error(
                `Expected no new events but got ${newEvents.length}: ${JSON.stringify(newEvents.map(e => e.event.type))}`
            )
        }
    }
}

export function expectResponse(
    status: number,
    options?: { body?: Record<string, unknown>; headers?: Record<string, string> }
): ResponseAssert {
    return (response: Response) => {
        if (response.status !== status) {
            throw new Error(
                `Expected status ${status} but got ${response.status}.\nBody: ${JSON.stringify(response.body, null, 2)}`
            )
        }
        if (options?.body) {
            assertMatches(response.body, options.body)
        }
        if (options?.headers) {
            for (const [key, value] of Object.entries(options.headers)) {
                const actual = response.headers[key.toLowerCase()]
                if (actual !== value) {
                    throw new Error(`Expected header "${key}" to be "${value}" but got "${actual}"`)
                }
            }
        }
    }
}

export function expectError(status: number, problem?: Partial<ProblemDetails>): ResponseAssert {
    return (response: Response) => {
        if (response.status !== status) {
            throw new Error(
                `Expected status ${status} but got ${response.status}.\nBody: ${JSON.stringify(response.body, null, 2)}`
            )
        }
        const contentType = response.headers["content-type"] ?? ""
        if (!contentType.includes("application/problem+json")) {
            throw new Error(`Expected content-type to include "application/problem+json" but got "${contentType}"`)
        }
        if (problem) {
            assertMatches(response.body, problem)
        }
    }
}
