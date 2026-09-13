export interface DcbCommand<Type extends string = string, Data = unknown> {
    type: Type
    data: Data
}
