import { on, OK, withETag, preferWait, type WebApiSetup, type WaitFunction } from "@dcb-es/event-store-express"
import type { SliceDependencies } from "../../../../shared/dependencies.js"
import { COURSE_PROJECTION_NAME } from "./projection.js"
import type { CourseDoc } from "./projection.js"

export function configureCourseDetailsRoute(deps: SliceDependencies & { waitFn?: WaitFunction }): WebApiSetup {
    const { pool, waitFn } = deps

    const getBookmarkPosition = async (): Promise<string> => {
        const r = await pool.query<{ last_sequence_position: string }>(
            "SELECT last_sequence_position FROM _handler_bookmarks WHERE handler_id = $1",
            [COURSE_PROJECTION_NAME]
        )
        return r.rows[0]?.last_sequence_position?.toString() ?? "0"
    }

    return router => {
        if (waitFn) {
            router.get("/courses/:courseId", preferWait({ waitFn }))
        }

        router.get(
            "/courses/:courseId",
            on(async req => {
                const courseId = req.params["courseId"] as string
                const result = await pool.query<{ data: CourseDoc }>("SELECT data FROM courses WHERE _id = $1", [
                    courseId
                ])
                if (result.rows.length === 0) {
                    return res => res.status(404).json({ status: 404, title: "Not Found", detail: "Course not found" })
                }
                const doc = result.rows[0].data
                const bookmarkPosition = await getBookmarkPosition()
                return res => {
                    withETag(bookmarkPosition)(res)
                    OK({
                        body: {
                            id: doc.courseId,
                            title: doc.title,
                            capacity: doc.capacity,
                            subscribedStudents: doc.subscribedStudents
                        }
                    })(res)
                }
            })
        )
    }
}
