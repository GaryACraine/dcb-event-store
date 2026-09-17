export type DefaultRecord<T = unknown> = Record<string, T>

export type DefaultCommandMetadata = { now: Date }

export type DcbCommand<
    CommandType extends string = string,
    CommandData = unknown,
    CommandMetaData extends Record<string, unknown> | undefined = undefined
> = Readonly<
    CommandMetaData extends undefined
        ? {
              type: CommandType
              data: Readonly<CommandData>
              metadata?: DefaultCommandMetadata | undefined
          }
        : {
              type: CommandType
              data: CommandData
              metadata: CommandMetaData
          }
> & { readonly kind?: "Command" }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyCommand = DcbCommand<string, any, any>

export type CommandTypeOf<T extends DcbCommand> = T["type"]
export type CommandDataOf<T extends DcbCommand> = T["data"]
export type CommandMetaDataOf<T extends DcbCommand> = T extends {
    metadata: infer M
}
    ? M
    : undefined

export type CreateCommandType<
    CommandType extends string,
    CommandData,
    CommandMetaData extends Record<string, unknown> | undefined = undefined
> = Readonly<
    CommandMetaData extends undefined
        ? {
              type: CommandType
              data: CommandData
              metadata?: DefaultCommandMetadata | undefined
          }
        : {
              type: CommandType
              data: CommandData
              metadata: CommandMetaData
          }
> & { readonly kind?: "Command" }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const command = <CommandType extends DcbCommand<string, any, any>>(
    ...args: CommandMetaDataOf<CommandType> extends undefined
        ? [
              type: CommandTypeOf<CommandType>,
              data: CommandDataOf<CommandType>,
              metadata?: DefaultCommandMetadata | undefined
          ]
        : [type: CommandTypeOf<CommandType>, data: CommandDataOf<CommandType>, metadata: CommandMetaDataOf<CommandType>]
): CommandType => {
    const [type, data, metadata] = args

    return metadata !== undefined
        ? ({ type, data, metadata, kind: "Command" } as CommandType)
        : ({ type, data, kind: "Command" } as CommandType)
}
