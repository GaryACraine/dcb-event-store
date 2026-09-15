import { OpenAPIRegistry, OpenApiGeneratorV31 } from "@asteasolutions/zod-to-openapi"
import { z } from "zod"
import {
    RegisterCourseSchema,
    RegisterStudentSchema,
    UpdateCourseCapacitySchema,
    SubscribeStudentSchema
} from "./Schemas.js"

const ProblemDetailsSchema = z
    .object({
        status: z.number().int().openapi({ example: 400 }),
        title: z.string().openapi({ example: "Bad Request" }),
        detail: z.string().openapi({ example: "Validation failed: capacity: Number must be greater than 0" }),
        type: z.string().url().optional().openapi({ example: "about:blank" }),
        instance: z.string().optional()
    })
    .openapi("ProblemDetails")

const IdempotencyKeyHeader = z.string().uuid().optional().openapi({
    description:
        "Client-generated UUID. Replayed requests with the same key return the original response without appending a duplicate event."
})

const ETagResponseHeader = z.string().openapi({
    example: '"5"',
    description: "Sequence position of the last appended event, usable as If-None-Match on reads."
})

const IfMatchRequestHeader = z.string().optional().openapi({
    example: '"5"',
    description: "ETag of the resource version the client last observed. Returns 412 if stale."
})

const IfNoneMatchRequestHeader = z.string().optional().openapi({
    example: '"3"',
    description:
        "Sequence position returned by a prior write. The Prefer: wait middleware blocks until the read model has processed this position."
})

const PreferWaitHeader = z.string().optional().openapi({
    example: "wait=5",
    description:
        "Blocks the read until the projection has caught up to the position in If-None-Match. Responds 504 if the timeout elapses."
})

function problemResponse(description: string) {
    return {
        description,
        content: {
            "application/problem+json": {
                schema: ProblemDetailsSchema
            }
        }
    }
}

export function buildOpenApiDocument(): object {
    const registry = new OpenAPIRegistry()

    registry.register("ProblemDetails", ProblemDetailsSchema)
    registry.register("RegisterCourseBody", RegisterCourseSchema)
    registry.register("RegisterStudentBody", RegisterStudentSchema)
    registry.register("UpdateCourseCapacityBody", UpdateCourseCapacitySchema)
    registry.register("SubscribeStudentBody", SubscribeStudentSchema)

    // POST /courses
    registry.registerPath({
        method: "post",
        path: "/courses",
        summary: "Register a new course",
        description: "Creates a course. Idempotent when an Idempotency-Key is supplied.",
        request: {
            headers: z.object({ "Idempotency-Key": IdempotencyKeyHeader }),
            body: {
                content: { "application/json": { schema: RegisterCourseSchema } },
                required: true
            }
        },
        responses: {
            201: {
                description: "Course registered",
                headers: z.object({ ETag: ETagResponseHeader }),
                content: { "application/json": { schema: z.object({ id: z.string() }) } }
            },
            400: problemResponse("Request body failed validation"),
            422: problemResponse("Course already exists or other domain rule violated")
        }
    })

    // POST /students
    registry.registerPath({
        method: "post",
        path: "/students",
        summary: "Register a new student",
        description: "Creates a student. Idempotent when an Idempotency-Key is supplied.",
        request: {
            headers: z.object({ "Idempotency-Key": IdempotencyKeyHeader }),
            body: {
                content: { "application/json": { schema: RegisterStudentSchema } },
                required: true
            }
        },
        responses: {
            201: {
                description: "Student registered",
                headers: z.object({ ETag: ETagResponseHeader }),
                content: { "application/json": { schema: z.object({ id: z.string() }) } }
            },
            400: problemResponse("Request body failed validation"),
            422: problemResponse("Student already exists")
        }
    })

    // PUT /courses/:courseId/capacity
    registry.registerPath({
        method: "put",
        path: "/courses/{courseId}/capacity",
        summary: "Update course capacity",
        request: {
            params: z.object({ courseId: z.string() }),
            headers: z.object({
                "Idempotency-Key": IdempotencyKeyHeader,
                "If-Match": IfMatchRequestHeader
            }),
            body: {
                content: { "application/json": { schema: UpdateCourseCapacitySchema } },
                required: true
            }
        },
        responses: {
            204: {
                description: "Capacity updated",
                headers: z.object({ ETag: ETagResponseHeader })
            },
            400: problemResponse("Request body failed validation"),
            404: problemResponse("Course not found"),
            412: problemResponse("ETag mismatch — client's version is stale")
        }
    })

    // POST /courses/:courseId/subscriptions
    registry.registerPath({
        method: "post",
        path: "/courses/{courseId}/subscriptions",
        summary: "Subscribe a student to a course",
        request: {
            params: z.object({ courseId: z.string() }),
            headers: z.object({ "Idempotency-Key": IdempotencyKeyHeader }),
            body: {
                content: { "application/json": { schema: SubscribeStudentSchema } },
                required: true
            }
        },
        responses: {
            201: {
                description: "Student subscribed",
                headers: z.object({ ETag: ETagResponseHeader })
            },
            400: problemResponse("Request body failed validation"),
            404: problemResponse("Course or student not found"),
            422: problemResponse("Course is full or student already subscribed")
        }
    })

    // DELETE /courses/:courseId/subscriptions/:studentId
    registry.registerPath({
        method: "delete",
        path: "/courses/{courseId}/subscriptions/{studentId}",
        summary: "Unsubscribe a student from a course",
        request: {
            params: z.object({ courseId: z.string(), studentId: z.string() }),
            headers: z.object({ "Idempotency-Key": IdempotencyKeyHeader })
        },
        responses: {
            204: {
                description: "Student unsubscribed",
                headers: z.object({ ETag: ETagResponseHeader })
            },
            404: problemResponse("Course or subscription not found")
        }
    })

    // GET /courses
    registry.registerPath({
        method: "get",
        path: "/courses",
        summary: "List courses (keyset-paginated)",
        request: {
            query: z.object({
                limit: z.string().optional().openapi({ example: "20", description: "Page size (max 200)" }),
                cursor: z.string().optional().openapi({ description: "Last _id from previous page" })
            }),
            headers: z.object({
                "If-None-Match": IfNoneMatchRequestHeader,
                Prefer: PreferWaitHeader
            })
        },
        responses: {
            200: {
                description: "Course list",
                headers: z.object({ ETag: ETagResponseHeader }),
                content: {
                    "application/json": {
                        schema: z.object({
                            data: z.array(
                                z.object({
                                    id: z.string(),
                                    title: z.string(),
                                    capacity: z.number().int(),
                                    subscribedStudents: z.array(z.unknown())
                                })
                            ),
                            cursor: z.string().optional()
                        })
                    }
                }
            },
            504: problemResponse("Prefer: wait timeout — projection did not catch up in time")
        }
    })

    // GET /courses/:courseId
    registry.registerPath({
        method: "get",
        path: "/courses/{courseId}",
        summary: "Get a single course",
        request: {
            params: z.object({ courseId: z.string() }),
            headers: z.object({
                "If-None-Match": IfNoneMatchRequestHeader,
                Prefer: PreferWaitHeader
            })
        },
        responses: {
            200: {
                description: "Course document",
                headers: z.object({ ETag: ETagResponseHeader }),
                content: {
                    "application/json": {
                        schema: z.object({
                            id: z.string(),
                            title: z.string(),
                            capacity: z.number().int(),
                            subscribedStudents: z.array(z.unknown())
                        })
                    }
                }
            },
            404: problemResponse("Course not found"),
            504: problemResponse("Prefer: wait timeout")
        }
    })

    // GET /students/:studentId
    registry.registerPath({
        method: "get",
        path: "/students/{studentId}",
        summary: "Get a single student",
        request: {
            params: z.object({ studentId: z.string() }),
            headers: z.object({
                "If-None-Match": IfNoneMatchRequestHeader,
                Prefer: PreferWaitHeader
            })
        },
        responses: {
            200: {
                description: "Student document",
                headers: z.object({ ETag: ETagResponseHeader }),
                content: {
                    "application/json": {
                        schema: z.object({
                            id: z.string(),
                            name: z.string(),
                            studentNumber: z.number().int(),
                            subscribedCourses: z.array(z.unknown())
                        })
                    }
                }
            },
            404: problemResponse("Student not found"),
            504: problemResponse("Prefer: wait timeout")
        }
    })

    // GET /events
    registry.registerPath({
        method: "get",
        path: "/events",
        summary: "Stream events via Server-Sent Events",
        description:
            "Streams all events from the event store. Reconnect by passing `Last-Event-ID`. Filter with `?types=` and `?tags=`.",
        request: {
            query: z.object({
                after: z.string().optional().openapi({ description: "Start streaming from this sequence position" }),
                types: z.string().optional().openapi({
                    example: "courseWasRegistered,studentWasRegistered",
                    description: "Comma-separated event type filter"
                }),
                tags: z.string().optional().openapi({ description: "Comma-separated tag filter" })
            }),
            headers: z.object({
                "Last-Event-ID": z
                    .string()
                    .optional()
                    .openapi({ description: "Reconnection cursor — resume from this position" })
            })
        },
        responses: {
            200: {
                description: "text/event-stream — one SSE event per stored event",
                content: { "text/event-stream": { schema: z.string() } }
            }
        }
    })

    const generator = new OpenApiGeneratorV31(registry.definitions)
    return generator.generateDocument({
        openapi: "3.1.0",
        info: {
            title: "Course Manager API",
            version: "1.0.0",
            description:
                "DCB Event Store example — commands over HTTP with ETags, idempotency keys, read-model queries, and an SSE event feed."
        },
        servers: [{ url: "/" }]
    })
}
