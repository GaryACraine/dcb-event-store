import { TaggedEvent, EventStore } from "../eventStore/EventStore.js"
import { SequencePosition } from "../eventStore/SequencePosition.js"
import { Command } from "../eventStore/Command.js"
import { EventHandlers, EventHandlerStates, buildDecisionModel } from "./buildDecisionModel.js"
import { ensureIsArray } from "../ensureIsArray.js"
import { AppendConditionError } from "../eventStore/AppendConditionError.js"
import { Backoff, backoffDelay, sleep } from "../backoff.js"
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

/** How often a decision is made again after a conflict, and how long it waits in between */
export interface ConflictRetry {
    /** Decisions made again after the first; default 3 */
    retries?: number
    /** The wait before each; default from 100 ms, doubling, at most 1 s */
    backoff?: Backoff
}

/** Emmett's numbers for a version conflict (3 retries from 100 ms), in this library's backoff */
export const ConflictRetryDefaults = { retries: 3, backoff: { initialMs: 100, maxMs: 1000 } } satisfies ConflictRetry

export interface HandleOptions {
    idempotencyKey?: string
    /**
     * Decide again when another append got there first (`AppendConditionError`): read the events again, decide again,
     * and append under the new condition. The second decision sees the winner's events, so a command that can no
     * longer hold is refused by its own decider, not by the conflict. `true` takes `ConflictRetryDefaults`; a number
     * sets `retries`. Off unless asked, as in Emmett (`retry: { onVersionConflict: true }`).
     */
    retry?: { onConflict: true | number | ConflictRetry }
}

function conflictRetry(retry: HandleOptions["retry"]): { retries: number; backoff: Backoff } {
    const onConflict = retry?.onConflict
    if (onConflict === undefined) return { retries: 0, backoff: ConflictRetryDefaults.backoff }
    if (onConflict === true) return ConflictRetryDefaults
    if (typeof onConflict === "number") return { ...ConflictRetryDefaults, retries: onConflict }
    return {
        retries: onConflict.retries ?? ConflictRetryDefaults.retries,
        backoff: { ...ConflictRetryDefaults.backoff, ...onConflict.backoff }
    }
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
 * instead of an invented event or a refusal; `events` says which it was. With `retry`, a decision whose append
 * condition failed is made again (`HandleOptions.retry`).
 */
export async function handleCommand<TCommand extends Command, THandlers extends EventHandlers>(
    eventStore: EventStore,
    d: Decider<TCommand, THandlers>,
    command: TCommand,
    options?: HandleOptions
): Promise<HandleResult> {
    const { retries, backoff } = conflictRetry(options?.retry)
    for (let attempt = 1; ; attempt++) {
        try {
            return await decideAndAppend(eventStore, d, command, options)
        } catch (error) {
            if (!isConflict(error) || attempt > retries) throw error
            await sleep(backoffDelay(attempt, backoff))
        }
    }
}

// By its code as well as its class: a second copy of this package (a linked app) throws its own AppendConditionError
const isConflict = (error: unknown): boolean =>
    error instanceof AppendConditionError || (error as { code?: unknown } | null)?.code === "APPEND_CONDITION"

async function decideAndAppend<TCommand extends Command, THandlers extends EventHandlers>(
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
