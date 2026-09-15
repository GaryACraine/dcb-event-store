import { z } from "zod"
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi"

extendZodWithOpenApi(z)

export const UpdateCourseCapacitySchema = z
    .object({
        newCapacity: z.number().int().min(1).openapi({ example: 50, description: "New maximum student capacity" })
    })
    .openapi("UpdateCourseCapacityBody")
