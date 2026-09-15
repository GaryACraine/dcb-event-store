---
"@dcb-es/event-store": patch
"@dcb-es/event-store-express": patch
---

phase-10.3: add Idempotency-Key header support for idempotent HTTP commands

- `handle()` in `@dcb-es/event-store` now accepts optional `HandleOptions` with an `idempotencyKey`
  field; when present, the key is stored as `DcbEvent.id` (`message_id` in Postgres). For commands
  that emit multiple events, per-event UUIDs are derived deterministically via UUID v5.
- New `getIdempotencyKey(req)` helper in `@dcb-es/event-store-express` reads the `Idempotency-Key`
  request header.
- `course-manager-postgres-web-api` example: all 5 write routes accept `Idempotency-Key`; a
  pre-check queries the events table by `message_id` so retried requests are short-circuited before
  the decision model runs, returning the same ETag without appending a duplicate event.
