import { on, OK, withETag, preferWait, type WebApiSetup, type WaitFunction } from "@dcb-es/event-store-express"
import type { Pool } from "pg"
import type { SliceDependencies } from "../../../../shared/dependencies.js"
import { STUDENT_PROJECTION_NAME } from "./projection.js"
import type { StudentDoc } from "./projection.js"

export function configureStudentDetailsRoute(deps: SliceDependencies & { waitFn?: WaitFunction }): WebApiSetup {
    const { pool, waitFn } = deps

    const getBookmarkPosition = async (): Promise<string> => {
        const r = await pool.query<{ last_sequence_position: string }>(
            "SELECT last_sequence_position FROM _handler_bookmarks WHERE handler_id = $1",
            [STUDENT_PROJECTION_NAME]
        )
        return r.rows[0]?.last_sequence_position?.toString() ?? "0"
    }

    return router => {
        if (waitFn) {
            router.get("/students/:studentId", preferWait({ waitFn }))
        }

        router.get(
            "/students/:studentId",
            on(async req => {
                const studentId = req.params["studentId"] as string
                const result = await pool.query<{ data: StudentDoc }>("SELECT data FROM students WHERE _id = $1", [
                    studentId
                ])
                if (result.rows.length === 0) {
                    return res => res.status(404).json({ status: 404, title: "Not Found", detail: "Student not found" })
                }
                const doc = result.rows[0].data
                const bookmarkPosition = await getBookmarkPosition()
                return res => {
                    withETag(bookmarkPosition)(res)
                    OK({
                        body: {
                            id: doc.studentId,
                            name: doc.name,
                            studentNumber: doc.studentNumber,
                            subscribedCourses: doc.subscribedCourses
                        }
                    })(res)
                }
            })
        )
    }
}
