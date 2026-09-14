import supertest from "supertest"
import type { Response } from "supertest"
import type { ErrorToProblemDetailsMapping } from "@dcb-es/event-store-web"
import type { EventStore } from "@dcb-es/event-store"
import { MemoryEventStore } from "@dcb-es/event-store"
import { getApplication, type WebApiSetup } from "../application.js"
import type { ApiSpecificationOptions, ResponseAssert, TestRequest } from "./apiSpecification.js"

export { type ApiSpecificationOptions, type ResponseAssert, type TestRequest }

export interface ApiE2ESpecificationOptions {
    configureApi: (eventStore: EventStore) => WebApiSetup
    mapError?: ErrorToProblemDetailsMapping
}

export class ApiE2ESpecification {
    private constructor(private readonly options: ApiE2ESpecificationOptions) {}

    static for(options: ApiE2ESpecificationOptions): ApiE2ESpecification {
        return new ApiE2ESpecification(options)
    }

    existingRequests(...requests: TestRequest[]): E2EGivenStage {
        return new E2EGivenStage(this.options, requests)
    }

    when(request: TestRequest): E2EWhenStage {
        return new E2EGivenStage(this.options, []).when(request)
    }
}

class E2EGivenStage {
    constructor(
        private readonly options: ApiE2ESpecificationOptions,
        private readonly priorRequests: TestRequest[]
    ) {}

    when(request: TestRequest): E2EWhenStage {
        return new E2EWhenStage(this.options, this.priorRequests, request)
    }
}

class E2EWhenStage {
    private readonly resultPromise: Promise<Response>

    constructor(
        private readonly options: ApiE2ESpecificationOptions,
        private readonly priorRequests: TestRequest[],
        private readonly request: TestRequest
    ) {
        this.resultPromise = this.execute()
    }

    private async execute(): Promise<Response> {
        const store = new MemoryEventStore()

        const app = getApplication({
            apis: [this.options.configureApi(store)],
            mapError: this.options.mapError
        })

        const agent = supertest.agent(app)

        for (const prior of this.priorRequests) {
            await prior(agent)
        }

        return await this.request(agent)
    }

    async then(responseAssert: ResponseAssert): Promise<void> {
        const response = await this.resultPromise
        responseAssert(response)
    }
}
