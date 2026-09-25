import { DcbError } from "@dcb-es/event-store"

export interface ProblemDetails {
    type?: string
    title?: string
    status: number
    detail?: string
    instance?: string
    [extension: string]: unknown
}

export type ErrorToProblemDetailsMapping = (
    error: unknown,
    request?: { url?: string; method?: string }
) => ProblemDetails | undefined

const httpStatusTitles: Record<number, string> = {
    400: "Bad Request",
    404: "Not Found",
    409: "Conflict",
    412: "Precondition Failed",
    422: "Unprocessable Entity",
    428: "Precondition Required",
    500: "Internal Server Error",
    504: "Gateway Timeout"
}

function titleForStatus(status: number): string {
    return httpStatusTitles[status] ?? "Error"
}

function detailFromError(error: unknown): string {
    if (error instanceof Error) {
        return error.message
    }
    return String(error)
}

export function toProblemDetails(
    error: unknown,
    request?: { url?: string; method?: string },
    mapError?: ErrorToProblemDetailsMapping
): ProblemDetails {
    if (mapError) {
        const custom = mapError(error, request)
        if (custom !== undefined) {
            return custom
        }
    }

    let status = 500
    let detail = detailFromError(error)

    if (error instanceof DcbError) {
        status = error.status
    } else if (
        error !== null &&
        typeof error === "object" &&
        "status" in error &&
        typeof (error as { status: unknown }).status === "number"
    ) {
        status = (error as { status: number }).status
    }

    const problem: ProblemDetails = {
        type: "about:blank",
        title: titleForStatus(status),
        status,
        detail
    }

    if (request?.url) {
        problem.instance = request.url
    }

    return problem
}
