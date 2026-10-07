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
    /**
     * The events the command decides. An empty array decides nothing: the command's intent already holds (a repeat,
     * an idempotent no-op), so nothing is appended and nothing is refused. Refuse with an error only when the
     * intent can't hold.
     */
    decide: (command: TCommand, state: EventHandlerStates<THandlers>) => TaggedEvent | TaggedEvent[]
}

export interface HandleOptions {
    idempotencyKey?: string
}

/** What handling a command did */
export interface HandleResult {
    /**
     * Where the decided events were appended; when it decided nothing, the position its decision was read at (the
     * last event it read, or the initial position): what the caller's intent holds as of.
     */
    position: SequencePosition
    /** The events appended; empty when the command decided nothing */
    events: TaggedEvent[]
}

export function decider<TCommand extends Command, THandlers extends EventHandlers>(d: {
    handlers: (command: TCommand) => THandlers
    decide: (command: TCommand, state: EventHandlerStates<THandlers>) => TaggedEvent | TaggedEvent[]
}): Decider<TCommand, THandlers> {
    return d
}

/**
 * Decides the command against the events its handlers read, and appends what it decided under the decision's append
 * condition. A decision of no events appends nothing (as Emmett's command handler does), so a repeat can be a no-op
 * instead of an invented event or a refusal; `events` says which it was.
 */
export async function handleCommand<TCommand extends Command, THandlers extends EventHandlers>(
    eventStore: EventStore,
    d: Decider<TCommand, THandlers>,
    command: TCommand,
    options?: HandleOptions
): Promise<HandleResult> {
    const handlers = d.handlers(command)
    const { state, appendCondition } = await buildDecisionModel(eventStore, handlers)
    const events = ensureIsArray(d.decide(command, state))

    if (events.length === 0) {
        return { position: appendCondition.after ?? SequencePosition.initial(), events: [] }
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

    const position = await eventStore.append({
        events,
        condition: appendCondition
    })
    return { position, events }
}

/**
 * `handleCommand`, returning only the position: where the decided events were appended, or, when the command
 * decided nothing, the position its decision was read at.
 */
export async function handle<TCommand extends Command, THandlers extends EventHandlers>(
    eventStore: EventStore,
    d: Decider<TCommand, THandlers>,
    command: TCommand,
    options?: HandleOptions
): Promise<SequencePosition> {
    return (await handleCommand(eventStore, d, command, options)).position
}
