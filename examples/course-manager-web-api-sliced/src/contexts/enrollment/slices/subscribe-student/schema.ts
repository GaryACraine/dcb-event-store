import { z } from "zod"
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi"

extendZodWithOpenApi(z)

export const SubscribeStudentSchema = z
    .object({
        studentId: z.string().min(1).openapi({ example: "student-1", description: "ID of the student to subscribe" })
    })
    .openapi("SubscribeStudentBody")
