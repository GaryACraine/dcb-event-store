---
"@dcb-es/event-store-postgres": minor
---

Add Projection abstraction for formalising read model handlers (Phase 4)

- **`Projection`** interface: `name`, `canHandle` (DCB `Query` — types + optional tag filters), `handle` (batch), `init` (DDL), `truncate` (cleanup), `version` (for future registry).
- **`rawSqlProjection()`** factory: wraps a per-event `evolve` function into the batch-capable `Projection.handle` interface.
- **`projectionToProcessor()`** adapter: bridges `Projection` → `ConsumerProcessorConfig` for use with `createConsumer`. Passes the `canHandle` query directly to the processor, avoiding lossy round-tripping through handler `when` keys.
- **`ProjectionSpec`**: fluent given/when/then API for testing projections against real Postgres with automatic rollback isolation. Fabricates `SequencedEvent` objects, calls `init`/`handle`, runs user assertions, then rolls back.
- **Processor `query` option**: `ProcessorOptions` and `ConsumerProcessorConfig` accept an optional `query: Query` that bypasses handler introspection when provided.
