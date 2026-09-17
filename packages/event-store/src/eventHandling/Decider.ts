import { TaggedEvent, EventStore } from "../eventStore/EventStore.js"
import { SequencePosition } from "../eventStore/SequencePosition.js"
import { Command } from "../eventStore/Command.js"
import { EventHandlers, EventHandlerStates, buildDecisionModel } from "./buildDecisionModel.js"
import { ensureIsArray } from "../ensureIsArray.js"
import { v5 as uuidv5 } from "uuid"

// Fixed namespace UUID for deterministic multi-event idempotency key derivation
const IDEMPOTENCY_NAMESPACE = "6ba7b810-9dad-11d1-80b4-00c04fd430c8"

export interface Decider<TCommand extends Command, THandlers extends EventHandlers> {
    handlers: (command: TCommand) => THandlers
    decide: (command: TCommand, state: EventHandlerStates<THandlers>) => TaggedEvent | TaggedEvent[]
}

export interface HandleOptions {
    idempotencyKey?: string
}

export function decider<TCommand extends Command, THandlers extends EventHandlers>(d: {
    handlers: (command: TCommand) => THandlers
    decide: (command: TCommand, state: EventHandlerStates<THandlers>) => TaggedEvent | TaggedEvent[]
}): Decider<TCommand, THandlers> {
    return d
}

export async function handle<TCommand extends Command, THandlers extends EventHandlers>(
    eventStore: EventStore,
    d: Decider<TCommand, THandlers>,
    command: TCommand,
    options?: HandleOptions
): Promise<SequencePosition> {
    const handlers = d.handlers(command)
    const { state, appendCondition } = await buildDecisionModel(eventStore, handlers)
    const events = ensureIsArray(d.decide(command, state))

    if (events.length === 0) {
        throw new Error("Decider must return at least one event")
    }

    if (options?.idempotencyKey) {
        if (events.length === 1) {
            events[0].id = options.idempotencyKey
        } else {
            events.forEach((event, i) => {
                event.id = uuidv5(`${options.idempotencyKey}:${i}`, IDEMPOTENCY_NAMESPACE)
            })
        }
    }

    return eventStore.append({
        events,
        condition: appendCondition
    })
}
