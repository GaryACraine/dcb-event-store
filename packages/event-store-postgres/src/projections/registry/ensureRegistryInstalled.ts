import { Pool, PoolClient } from "pg"

export async function ensureRegistryInstalled(client: Pool | PoolClient): Promise<void> {
    await client.query(`
        CREATE TABLE IF NOT EXISTS _projections (
            name         TEXT NOT NULL,
            version      INT NOT NULL DEFAULT 1,
            type         VARCHAR(1) NOT NULL,
            kind         TEXT NOT NULL,
            status       TEXT NOT NULL DEFAULT 'active',
            definition   JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
            PRIMARY KEY (name, version)
        )
    `)
}
