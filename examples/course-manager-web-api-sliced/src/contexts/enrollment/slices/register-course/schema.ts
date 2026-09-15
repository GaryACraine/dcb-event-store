import { z } from "zod"
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi"

extendZodWithOpenApi(z)

export const RegisterCourseSchema = z
    .object({
        id: z.string().min(1).openapi({ example: "course-101", description: "Unique course identifier" }),
        title: z.string().min(1).openapi({ example: "Introduction to TypeScript", description: "Course title" }),
        capacity: z.number().int().min(1).openapi({ example: 30, description: "Maximum number of students" })
    })
    .openapi("RegisterCourseBody")
