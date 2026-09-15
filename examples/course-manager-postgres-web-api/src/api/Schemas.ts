import { z } from "zod"
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi"

// Extend zod with .openapi() support for schema documentation
extendZodWithOpenApi(z)

export const RegisterCourseSchema = z
    .object({
        id: z.string().min(1).openapi({ example: "course-101", description: "Unique course identifier" }),
        title: z.string().min(1).openapi({ example: "Introduction to TypeScript", description: "Course title" }),
        capacity: z.number().int().min(1).openapi({ example: 30, description: "Maximum number of students" })
    })
    .openapi("RegisterCourseBody")

export const RegisterStudentSchema = z
    .object({
        id: z.string().min(1).openapi({ example: "student-1", description: "Unique student identifier" }),
        name: z.string().min(1).openapi({ example: "Alice", description: "Student full name" })
    })
    .openapi("RegisterStudentBody")

export const UpdateCourseCapacitySchema = z
    .object({
        newCapacity: z.number().int().min(1).openapi({ example: 50, description: "New maximum student capacity" })
    })
    .openapi("UpdateCourseCapacityBody")

export const SubscribeStudentSchema = z
    .object({
        studentId: z.string().min(1).openapi({ example: "student-1", description: "ID of the student to subscribe" })
    })
    .openapi("SubscribeStudentBody")
