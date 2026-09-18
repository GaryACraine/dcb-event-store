---
"@dcb-es/event-store-postgres": minor
---

phase-15: Simplify Projection `canHandle` from `Query` to `string[]`

The `Projection` interface now declares `canHandle: string[]` — a plain list of
event type names — instead of `canHandle: Query`. This removes the conflation
between DCB write-side append-condition semantics and read-side projection
subscriptions. No example or production projection used tag filters on
`canHandle`; projections answer "which event types do I process?", which is
correctly expressed as a `string[]`.

All factory functions (`rawSqlProjection`, `pongoProjection`,
`pongoDocumentProjection`), adapters (`projectionToProcessor`,
`rebuildProjection`), inline filtering (`PostgresEventStore`), and the
projection spec (`ProjectionSpec`) have been updated. Infrastructure that still
needs a `Query` (store subscriptions) now constructs one from
`canHandle` via `Query.fromItems([{ types: canHandle }])`.
