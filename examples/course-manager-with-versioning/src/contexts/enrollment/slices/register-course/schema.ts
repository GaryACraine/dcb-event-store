import { z } from "zod"
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi"

extendZodWithOpenApi(z)

export const RegisterCourseSchema = z
    .object({
        id: z.string().min(1).openapi({ example: "course-101", description: "Unique course identifier" }),
        name: z.string().min(1).openapi({ example: "Introduction to TypeScript", description: "Course name" }),
        description: z
            .string()
            .min(1)
            .openapi({ example: "A comprehensive course on TypeScript.", description: "Course description" }),
        capacity: z.number().int().min(1).openapi({ example: 30, description: "Maximum number of students" }),
        department: z.string().min(1).openapi({ example: "Engineering", description: "Department offering the course" })
    })
    .openapi("RegisterCourseBody")
