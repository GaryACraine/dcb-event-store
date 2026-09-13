import { AppendCondition } from "./EventStore.js"
import { DcbError } from "./errors.js"

export class AppendConditionError extends DcbError {
    public readonly appendCondition: AppendCondition
    public readonly commandIndex?: number

    constructor(appendCondition: AppendCondition, commandIndex?: number) {
        const indexSuffix = commandIndex !== undefined ? ` (command ${commandIndex})` : ""
        super(
            `Expected Version fail: New events matching appendCondition found.${indexSuffix}`,
            "APPEND_CONDITION",
            409
        )
        this.appendCondition = appendCondition
        this.commandIndex = commandIndex
        Object.setPrototypeOf(this, AppendConditionError.prototype)
    }
}
