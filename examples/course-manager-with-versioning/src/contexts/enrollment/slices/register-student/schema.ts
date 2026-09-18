import { z } from "zod"
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi"

extendZodWithOpenApi(z)

export const RegisterStudentSchema = z
    .object({
        id: z.string().min(1).openapi({ example: "student-1", description: "Unique student identifier" }),
        name: z.string().min(1).openapi({ example: "Alice", description: "Student full name" })
    })
    .openapi("RegisterStudentBody")
