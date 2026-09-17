import { DefaultRecord } from "./types.js"

export type Event<
    EventType extends string = string,
    EventData = unknown,
    EventMetaData extends DefaultRecord | undefined = undefined
> = Readonly<
    EventMetaData extends undefined
        ? {
              type: EventType
              data: Readonly<EventData>
              metadata?: undefined
          }
        : {
              type: EventType
              data: EventData
              metadata: EventMetaData
          }
> & { readonly kind?: "Event" }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyEvent = Event<any, any, any>

export type EventTypeOf<T extends Event> = T["type"]
export type EventDataOf<T extends Event> = T["data"]
export type EventMetaDataOf<T extends Event> = T extends { metadata: infer M } ? M : undefined

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const event = <EventType extends Event<string, any, any>>(
    ...args: [EventMetaDataOf<EventType>] extends [undefined]
        ? [type: EventTypeOf<EventType>, data: EventDataOf<EventType>]
        : [type: EventTypeOf<EventType>, data: EventDataOf<EventType>, metadata: EventMetaDataOf<EventType>]
): EventType => {
    const [type, data, metadata] = args

    return metadata !== undefined
        ? ({ type, data, metadata, kind: "Event" } as EventType)
        : ({ type, data, kind: "Event" } as EventType)
}
