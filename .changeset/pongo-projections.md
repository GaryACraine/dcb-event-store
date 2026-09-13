---
"@dcb-es/event-store-postgres": minor
---

Add Pongo JSONB read model projections (Phase 5)

- **`pongoProjection()`** factory: creates projections that write to Pongo JSONB document collections. The handler receives a `PongoProjectionContext` with a `pongo: PongoClient` that shares the processor's `PoolClient` transaction via dumbo's `pgAmbientPoolClientPool`, ensuring projection writes and bookmark advances commit atomically.
- **`pongoDocumentProjection()`** convenience factory: for the common one-document-per-entity pattern. Groups events by `getDocumentId`, loads the existing document, folds events through `evolve`, and upserts (or deletes if `evolve` returns `null`).
- Optional peer dependencies on `@event-driven-io/pongo` and `@event-driven-io/dumbo`.
