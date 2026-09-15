---
"@dcb-es/event-store-express": patch
---

Add `validateBody` middleware helper to `@dcb-es/event-store-express`. Validates `req.body` against a Zod schema; on failure calls `next(new ValidationError(...))` so the existing problem-details middleware renders a RFC 9457 `400 Bad Request`. `zod` is added as an optional peer dependency so users who don't use `validateBody` don't pay the install cost.

The `course-manager-postgres-web-api` example gains Zod request-body validation on all write routes, a `GET /openapi.json` endpoint serving an OpenAPI 3.1.0 document (generated via `@asteasolutions/zod-to-openapi`) that documents all routes including `ETag`, `If-Match`, `If-None-Match`, `Prefer: wait`, and `Idempotency-Key` headers, and validation test cases covering missing fields, out-of-range values, and wrong types.
