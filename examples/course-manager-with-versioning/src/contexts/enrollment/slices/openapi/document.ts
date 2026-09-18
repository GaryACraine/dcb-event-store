import { OpenAPIRegistry, OpenApiGeneratorV31 } from "@asteasolutions/zod-to-openapi"
import { z } from "zod"
import { RegisterCourseSchema } from "../register-course/schema.js"
import { RegisterStudentSchema } from "../register-student/schema.js"
import { UpdateCourseCapacitySchema } from "../change-course-capacity/schema.js"
import { SubscribeStudentSchema } from "../subscribe-student/schema.js"

const ProblemDetailsSchema = z
    .object({
        status: z.number().int().openapi({ example: 400 }),
        title: z.string().openapi({ example: "Bad Request" }),
        detail: z.string().openapi({ example: "Validation failed" }),
        type: z.string().url().optional().openapi({ example: "about:blank" }),
        instance: z.string().optional()
    })
    .openapi("ProblemDetails")

const IdempotencyKeyHeader = z.string().uuid().optional().openapi({
    description: "Client-generated UUID for idempotent requests."
})

const ETagResponseHeader = z.string().openapi({
    example: '"5"',
    description: "Sequence position of the last appended event."
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

    registry.registerPath({
        method: "post",
        path: "/courses",
        summary: "Register a new course (V3 shape)",
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
            422: problemResponse("Course already exists")
        }
    })

    registry.registerPath({
        method: "post",
        path: "/students",
        summary: "Register a new student",
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

    registry.registerPath({
        method: "put",
        path: "/courses/{courseId}/capacity",
        summary: "Update course capacity",
        request: {
            params: z.object({ courseId: z.string() }),
            headers: z.object({ "Idempotency-Key": IdempotencyKeyHeader }),
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
            404: problemResponse("Course not found")
        }
    })

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
            404: problemResponse("Course not found"),
            422: problemResponse("Course is full or student already subscribed")
        }
    })

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

    const generator = new OpenApiGeneratorV31(registry.definitions)
    return generator.generateDocument({
        openapi: "3.1.0",
        info: {
            title: "Course Manager API (Event Schema Evolution)",
            version: "1.0.0",
            description:
                "DCB Event Store example — event schema evolution with V1/V2/V3 courseWasRegistered types, plain switch and versionedHandler() patterns."
        },
        servers: [{ url: "/" }]
    })
}
