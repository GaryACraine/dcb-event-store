import { describe, it, expect } from "vitest"
import {
    DcbError,
    NotFoundError,
    ValidationError,
    IllegalStateError,
    WaitTimeoutError,
    AppendConditionError,
    Query
} from "@dcb-es/event-store"
import { toProblemDetails } from "./problemDetails.js"
import { StaleETagError, MissingETagError } from "./errors.js"

describe("toProblemDetails", () => {
    it("maps NotFoundError to 404", () => {
        const error = new NotFoundError("Course not found")
        const problem = toProblemDetails(error)

        expect(problem.status).toBe(404)
        expect(problem.title).toBe("Not Found")
        expect(problem.detail).toBe("Course not found")
        expect(problem.type).toBe("about:blank")
    })

    it("maps ValidationError to 400", () => {
        const error = new ValidationError("Name is required")
        const problem = toProblemDetails(error)

        expect(problem.status).toBe(400)
        expect(problem.title).toBe("Bad Request")
        expect(problem.detail).toBe("Name is required")
    })

    it("maps IllegalStateError to 422", () => {
        const error = new IllegalStateError("Course is already full")
        const problem = toProblemDetails(error)

        expect(problem.status).toBe(422)
        expect(problem.title).toBe("Unprocessable Entity")
        expect(problem.detail).toBe("Course is already full")
    })

    it("maps WaitTimeoutError to 504 (phase 18)", () => {
        const problem = toProblemDetails(new WaitTimeoutError("CourseProjection", "7", 5000))

        expect(problem.status).toBe(504)
        expect(problem.title).toBe("Gateway Timeout")
        expect(problem.detail).toBe('Timeout: handler "CourseProjection" did not reach position 7 within 5000ms')
    })

    it("maps AppendConditionError to 409", () => {
        const error = new AppendConditionError({
            failIfEventsMatch: Query.fromItems([{ types: ["TestEvent"] }]),
            after: 0n
        })
        const problem = toProblemDetails(error)

        expect(problem.status).toBe(409)
        expect(problem.title).toBe("Conflict")
        expect(problem.detail).toContain("Expected Version fail")
    })

    it("maps StaleETagError to 412", () => {
        const error = new StaleETagError()
        const problem = toProblemDetails(error)

        expect(problem.status).toBe(412)
        expect(problem.title).toBe("Precondition Failed")
        expect(problem.detail).toBe("If-Match ETag is stale")
    })

    it("maps MissingETagError to 428", () => {
        const error = new MissingETagError()
        const problem = toProblemDetails(error)

        expect(problem.status).toBe(428)
        expect(problem.title).toBe("Precondition Required")
        expect(problem.detail).toBe("If-Match header is required")
    })

    it("maps custom DcbError subclass with status 503 to 503", () => {
        class ServiceUnavailableError extends DcbError {
            constructor() {
                super("Service is down", "SERVICE_UNAVAILABLE", 503)
            }
        }
        const error = new ServiceUnavailableError()
        const problem = toProblemDetails(error)

        expect(problem.status).toBe(503)
        expect(problem.title).toBe("Error")
        expect(problem.detail).toBe("Service is down")
    })

    it("maps plain Error to 500", () => {
        const error = new Error("Something went wrong")
        const problem = toProblemDetails(error)

        expect(problem.status).toBe(500)
        expect(problem.title).toBe("Internal Server Error")
        expect(problem.detail).toBe("Something went wrong")
    })

    it("maps string thrown value to 500", () => {
        const problem = toProblemDetails("unexpected failure")

        expect(problem.status).toBe(500)
        expect(problem.title).toBe("Internal Server Error")
        expect(problem.detail).toBe("unexpected failure")
    })

    it("uses user mapError override when it returns a value", () => {
        const error = new NotFoundError("Course not found")
        const problem = toProblemDetails(error, undefined, () => ({
            type: "https://example.com/not-found",
            title: "Custom Not Found",
            status: 404,
            detail: "Custom detail"
        }))

        expect(problem.status).toBe(404)
        expect(problem.title).toBe("Custom Not Found")
        expect(problem.type).toBe("https://example.com/not-found")
        expect(problem.detail).toBe("Custom detail")
    })

    it("falls through to default when mapError returns undefined", () => {
        const error = new ValidationError("Bad input")
        const problem = toProblemDetails(error, undefined, () => undefined)

        expect(problem.status).toBe(400)
        expect(problem.title).toBe("Bad Request")
        expect(problem.detail).toBe("Bad input")
    })

    it("populates instance from request.url", () => {
        const error = new NotFoundError("Not found")
        const problem = toProblemDetails(error, {
            url: "/api/courses/123",
            method: "GET"
        })

        expect(problem.instance).toBe("/api/courses/123")
    })
})
