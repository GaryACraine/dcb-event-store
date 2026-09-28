import { Pool, PoolClient } from "pg"
import { EventHandler } from "@dcb-es/event-store"
import { CourseTitleWasChangedEvent, CourseWasRegisteredEvent } from "./Events.js"

/*
    A second handler, where losing an entry is acceptable: a short audit line per course change. An entry longer than
    the column fails to insert, and the consumer runs this handler with `onError: "skip"`, so it logs a warning and
    carries on instead of blocking (phase 19).
*/

export const AUDIT_LOG_NAME = "CourseAuditLog"

export const installCourseAuditLog = async (client: Pool | PoolClient) => {
    await client.query(`
        CREATE TABLE IF NOT EXISTS course_audit (
            course_id TEXT NOT NULL,
            entry VARCHAR(40) NOT NULL
        );
    `)
}

export const CourseAuditLog = (
    client: PoolClient | Pool
): EventHandler<CourseWasRegisteredEvent | CourseTitleWasChangedEvent> => ({
    when: {
        courseWasRegistered: async ({ event: { data } }) => {
            await client.query("INSERT INTO course_audit (course_id, entry) VALUES ($1, $2)", [
                data.courseId,
                `registered as ${data.title}`
            ])
        },
        courseTitleWasChanged: async ({ event: { data } }) => {
            await client.query("INSERT INTO course_audit (course_id, entry) VALUES ($1, $2)", [
                data.courseId,
                `renamed to ${data.newTitle}`
            ])
        }
    }
})
