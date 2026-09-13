import { DcbEvent, EventStore } from "../eventStore/EventStore.js"
import { SequencePosition } from "../eventStore/SequencePosition.js"
import { DcbCommand } from "../eventStore/DcbCommand.js"
import { EventHandlers, EventHandlerStates, buildDecisionModel } from "./buildDecisionModel.js"
import { ensureIsArray } from "../ensureIsArray.js"

export interface Decider<TCommand extends DcbCommand, THandlers extends EventHandlers> {
    handlers: (command: TCommand) => THandlers
    decide: (command: TCommand, state: EventHandlerStates<THandlers>) => DcbEvent | DcbEvent[]
}

export function decider<TCommand extends DcbCommand, THandlers extends EventHandlers>(d: {
    handlers: (command: TCommand) => THandlers
    decide: (command: TCommand, state: EventHandlerStates<THandlers>) => DcbEvent | DcbEvent[]
}): Decider<TCommand, THandlers> {
    return d
}

export async function handle<TCommand extends DcbCommand, THandlers extends EventHandlers>(
    eventStore: EventStore,
    d: Decider<TCommand, THandlers>,
    command: TCommand
): Promise<SequencePosition> {
    const handlers = d.handlers(command)
    const { state, appendCondition } = await buildDecisionModel(eventStore, handlers)
    const events = ensureIsArray(d.decide(command, state))

    if (events.length === 0) {
        throw new Error("Decider must return at least one event")
    }

    return eventStore.append({
        events,
        condition: appendCondition
    })
}
