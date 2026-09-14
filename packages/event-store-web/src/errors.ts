import { DcbError } from "@dcb-es/event-store"

export class StaleETagError extends DcbError {
    constructor(message?: string) {
        super(message ?? "If-Match ETag is stale", "STALE_ETAG", 412)
    }
}

export class MissingETagError extends DcbError {
    constructor(message?: string) {
        super(message ?? "If-Match header is required", "MISSING_ETAG", 428)
    }
}
