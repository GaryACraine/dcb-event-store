import { Pool } from "pg"

export const ensureHandlersInstalled = async (pool: Pool, handlerIds: string[], tableName: string) => {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS ${tableName} (
            handler_id TEXT PRIMARY KEY,
            last_sequence_position BIGINT
        );`)

    // Phase 3: add columns for processor hardening (idempotent)
    await pool.query(`
        ALTER TABLE ${tableName} ADD COLUMN IF NOT EXISTS version BIGINT NOT NULL DEFAULT 1;
        ALTER TABLE ${tableName} ADD COLUMN IF NOT EXISTS instance_id TEXT;
        ALTER TABLE ${tableName} ADD COLUMN IF NOT EXISTS last_updated TIMESTAMPTZ NOT NULL DEFAULT now();
    `)

    // Phase 19: the event a processor is blocked on, for anyone to see (idempotent)
    await pool.query(`
        ALTER TABLE ${tableName} ADD COLUMN IF NOT EXISTS blocked_error TEXT;
        ALTER TABLE ${tableName} ADD COLUMN IF NOT EXISTS blocked_position BIGINT;
        ALTER TABLE ${tableName} ADD COLUMN IF NOT EXISTS blocked_attempts INT NOT NULL DEFAULT 0;
        ALTER TABLE ${tableName} ADD COLUMN IF NOT EXISTS blocked_since TIMESTAMPTZ;
    `)

    await registerHandlers(pool, handlerIds, tableName)
}

export const registerHandlers = async (pool: Pool, handlerIds: string[], tableName: string) => {
    await pool.query(
        `
        INSERT INTO ${tableName} (handler_id, last_sequence_position)
        SELECT handler_id, 0
        FROM unnest($1::text[]) handler_id
        ON CONFLICT (handler_id) DO NOTHING
    `,
        [handlerIds]
    )
}
