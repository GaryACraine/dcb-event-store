import {
    on,
    OK,
    withETag,
    preferWait,
    parsePageParams,
    type WebApiSetup,
    type WaitFunction
} from "@dcb-es/event-store-express"
import type { SliceDependencies } from "../../../../shared/dependencies.js"
import { COURSE_PROJECTION_NAME } from "../course-details/projection.js"
import type { CourseDoc } from "../course-details/projection.js"

export function configureCourseListRoute(deps: SliceDependencies & { waitFn?: WaitFunction }): WebApiSetup {
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
            router.get("/courses", preferWait({ waitFn }))
        }

        router.get(
            "/courses",
            on(async req => {
                const { limit } = parsePageParams(req)
                const cursor = typeof req.query["cursor"] === "string" ? req.query["cursor"] : undefined

                let result: { rows: { _id: string; data: CourseDoc }[] }
                if (cursor) {
                    result = await pool.query<{ _id: string; data: CourseDoc }>(
                        "SELECT _id, data FROM courses WHERE _id > $1 ORDER BY _id LIMIT $2",
                        [cursor, limit]
                    )
                } else {
                    result = await pool.query<{ _id: string; data: CourseDoc }>(
                        "SELECT _id, data FROM courses ORDER BY _id LIMIT $1",
                        [limit]
                    )
                }

                const courses = result.rows.map(row => ({
                    id: row.data.courseId,
                    title: row.data.title,
                    capacity: row.data.capacity,
                    subscribedStudents: row.data.subscribedStudents
                }))

                const nextCursor = result.rows.length === limit ? result.rows[result.rows.length - 1]._id : undefined

                const body: { data: typeof courses; cursor?: string } = {
                    data: courses,
                    ...(nextCursor && { cursor: nextCursor })
                }

                const bookmarkPosition = await getBookmarkPosition()
                return res => {
                    withETag(bookmarkPosition)(res)
                    OK({ body })(res)
                }
            })
        )
    }
}
