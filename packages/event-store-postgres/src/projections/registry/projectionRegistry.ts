import { PoolClient } from "pg"
import { projectionLockKey } from "../../eventStore/advisoryLocks.js"

export type ProjectionType = "a" | "i"
export type ProjectionStatus = "active" | "inactive"

export interface RegisterProjectionOptions {
    name: string
    version: number
    type: ProjectionType
    kind: string
    status: ProjectionStatus
    definition: object
}

export async function registerProjection(
    client: PoolClient,
    options: RegisterProjectionOptions
): Promise<{ registered: boolean }> {
    const key = projectionLockKey(options.name, options.version)
    const lockResult = await client.query<{ pg_try_advisory_xact_lock: boolean }>(
        "SELECT pg_try_advisory_xact_lock($1)",
        [key.toString()]
    )
    const acquired = lockResult.rows[0].pg_try_advisory_xact_lock

    await client.query(
        `INSERT INTO _projections (name, version, type, kind, status, definition)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (name, version) DO UPDATE
         SET definition = EXCLUDED.definition,
             type = EXCLUDED.type,
             kind = EXCLUDED.kind,
             updated_at = now()`,
        [options.name, options.version, options.type, options.kind, options.status, JSON.stringify(options.definition)]
    )

    return { registered: acquired }
}

export async function readProjectionStatus(
    client: PoolClient,
    options: { name: string; version: number }
): Promise<ProjectionStatus | null> {
    const result = await client.query<{ status: string }>(
        "SELECT status FROM _projections WHERE name = $1 AND version = $2",
        [options.name, options.version]
    )
    if (result.rows.length === 0) return null
    return result.rows[0].status as ProjectionStatus
}

export async function setProjectionStatus(
    client: PoolClient,
    options: { name: string; version: number; status: ProjectionStatus }
): Promise<{ updated: boolean }> {
    const result = await client.query(
        "UPDATE _projections SET status = $1, updated_at = now() WHERE name = $2 AND version = $3",
        [options.status, options.name, options.version]
    )
    return { updated: (result.rowCount ?? 0) > 0 }
}

export function serializeCanHandle(eventTypes: string[]): object {
    return { types: eventTypes }
}
