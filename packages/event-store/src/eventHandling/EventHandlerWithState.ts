import { Event } from "../eventStore/Event.js"
import { SequencedEvent } from "../eventStore/EventStore.js"
import { Tags } from "../eventStore/Tags.js"

export interface EventHandlerWithState<TEvents extends Event, TState, TTags extends Tags = Tags> {
    tagFilter?: Partial<TTags>
    onlyLastEvent?: boolean
    init: TState
    when: {
        [E in TEvents as E["type"]]?: (
            sequencedEvent: SequencedEvent<Extract<TEvents, { type: E["type"] }>>,
            state: TState
        ) => TState | Promise<TState>
    }
}
