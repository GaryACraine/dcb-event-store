---
"@dcb-es/event-store": minor
"@dcb-es/event-store-postgres": minor
---

Add event identity and metadata columns (Phase 1)

Every stored event now carries a `message_id` (UUID), `recorded_at` (timestamptz), `schema_version` (text), and `metadata` (JSONB) alongside the existing `payload` TEXT column.

- **Idempotent appends**: supply an `id` on `DcbEvent` to deduplicate retries via `ON CONFLICT (message_id) DO NOTHING`. Both the function and COPY append paths handle duplicates correctly.
- **Server timestamps**: `recorded_at` is set by Postgres `DEFAULT now()`, monotonic within a transaction.
- **Schema versioning**: optional `schemaVersion` on `DcbEvent`, defaults to `'1'`, stored in a dedicated column for future migration support.
- **Queryable metadata**: the existing `metadata` field is now also written to a JSONB column, queryable with standard Postgres JSON operators.
- **Read-side enrichment**: `SequencedEvent` gains `id: string` and `recordedAt: Date`.
- **Memory store parity**: `MemoryEventStore` mirrors all idempotency and identity semantics.
- Schema migration is idempotent (`ADD COLUMN IF NOT EXISTS`), safe for existing deployments.
