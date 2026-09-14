import { DcbEvent, AppendCondition } from "../eventStore/EventStore.js"
import { DcbCommand } from "../eventStore/DcbCommand.js"
import { MemoryEventStore } from "../eventStore/memoryEventStore/MemoryEventStore.js"
import { EventHandlers, EventHandlerStates, buildDecisionModel } from "../eventHandling/buildDecisionModel.js"
import { Decider } from "../eventHandling/Decider.js"
import { ensureIsArray } from "../ensureIsArray.js"
import { normalizeForComparison, deepEqual } from "./assertions.js"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ErrorConstructor = new (...args: any[]) => Error

export class DeciderSpecification<TCommand extends DcbCommand, THandlers extends EventHandlers> {
    private constructor(private readonly d: Decider<TCommand, THandlers>) {}

    static for<TCommand extends DcbCommand, THandlers extends EventHandlers>(
        d: Decider<TCommand, THandlers>
    ): DeciderSpecification<TCommand, THandlers> {
        return new DeciderSpecification(d)
    }

    given(...events: DcbEvent[]): GivenStage<TCommand, THandlers> {
        return new GivenStage(this.d, events)
    }
}

class GivenStage<TCommand extends DcbCommand, THandlers extends EventHandlers> {
    constructor(
        private readonly d: Decider<TCommand, THandlers>,
        private readonly givenEvents: DcbEvent[]
    ) {}

    when(command: TCommand): WhenStage<TCommand, THandlers> {
        return new WhenStage(this.d, this.givenEvents, command)
    }
}

class WhenStage<TCommand extends DcbCommand, THandlers extends EventHandlers> {
    private resultPromise: Promise<{
        events: DcbEvent[]
        appendCondition: AppendCondition
        error?: Error
    }>

    constructor(
        private readonly d: Decider<TCommand, THandlers>,
        private readonly givenEvents: DcbEvent[],
        private readonly command: TCommand
    ) {
        this.resultPromise = this.execute()
    }

    private async execute(): Promise<{
        events: DcbEvent[]
        appendCondition: AppendCondition
        error?: Error
    }> {
        const store = new MemoryEventStore()

        if (this.givenEvents.length > 0) {
            await store.append({ events: this.givenEvents })
        }

        const handlers = this.d.handlers(this.command)
        const { state, appendCondition } = await buildDecisionModel(store, handlers)

        try {
            const result = this.d.decide(this.command, state as EventHandlerStates<THandlers>)
            const events = ensureIsArray(result)
            return { events, appendCondition }
        } catch (error) {
            return { events: [], appendCondition, error: error as Error }
        }
    }

    async then(...expected: DcbEvent[]): Promise<void> {
        const result = await this.resultPromise

        if (result.error) {
            throw new Error(`Expected events but decide threw: ${result.error.message}`)
        }

        const actualNormalized = result.events.map(normalizeForComparison)
        const expectedNormalized = expected.map(normalizeForComparison)

        if (actualNormalized.length !== expectedNormalized.length) {
            throw new Error(
                `Expected ${expectedNormalized.length} event(s) but got ${actualNormalized.length}.\n` +
                    `Actual: ${JSON.stringify(actualNormalized, null, 2)}\n` +
                    `Expected: ${JSON.stringify(expectedNormalized, null, 2)}`
            )
        }

        for (let i = 0; i < actualNormalized.length; i++) {
            if (!deepEqual(actualNormalized[i], expectedNormalized[i])) {
                throw new Error(
                    `Event at index ${i} does not match.\n` +
                        `Actual: ${JSON.stringify(actualNormalized[i], null, 2)}\n` +
                        `Expected: ${JSON.stringify(expectedNormalized[i], null, 2)}`
                )
            }
        }
    }

    async thenThrows(errorType?: ErrorConstructor, predicate?: (error: Error) => boolean): Promise<void> {
        const result = await this.resultPromise
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const error: any = result.error

        if (error == null) {
            throw new Error("Expected decide to throw but it did not")
        }

        if (errorType != null && !(error instanceof errorType)) {
            throw new Error(
                `Expected error of type ${errorType.name} but got ${error.constructor.name}: ${error.message}`
            )
        }

        if (predicate != null && !predicate(error as Error)) {
            throw new Error(`Error predicate failed for error: ${error.message}`)
        }
    }

    async thenNothingHappened(): Promise<void> {
        const result = await this.resultPromise

        if (result.error) {
            throw new Error(`Expected no events but decide threw: ${result.error.message}`)
        }

        if (result.events.length > 0) {
            throw new Error(`Expected no events but got ${result.events.length}`)
        }
    }

    async thenCondition(assert: (condition: AppendCondition) => void): Promise<void> {
        const result = await this.resultPromise
        assert(result.appendCondition)
    }
}
