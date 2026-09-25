export class DcbError extends Error {
    public readonly code: string
    public readonly status: number

    constructor(message: string, code: string, status: number) {
        super(message)
        this.code = code
        this.status = status
        this.name = this.constructor.name
        Object.setPrototypeOf(this, new.target.prototype)
    }
}

export class NotFoundError extends DcbError {
    constructor(message: string) {
        super(message, "NOT_FOUND", 404)
    }
}

export class ValidationError extends DcbError {
    constructor(message: string) {
        super(message, "VALIDATION_ERROR", 400)
    }
}

export class IllegalStateError extends DcbError {
    constructor(message: string) {
        super(message, "ILLEGAL_STATE", 422)
    }
}

/**
 * A wait for a handler to reach a position ran out of time (`waitUntilProcessed`). A 504: the request was fine, the
 * read model didn't catch up in time. In core so an HTTP layer can recognise it without depending on Postgres.
 */
export class WaitTimeoutError extends DcbError {
    constructor(handlerName: string, position: string, timeoutMs: number) {
        super(
            `Timeout: handler "${handlerName}" did not reach position ${position} within ${timeoutMs}ms`,
            "WAIT_TIMEOUT",
            504
        )
    }
}
