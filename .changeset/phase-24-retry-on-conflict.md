---
"@dcb-es/event-store": minor
"@dcb-es/event-store-postgres": patch
---

Decide again after a conflict (phase 24, the eventmodelers kit's ADR-067).

- `handleCommand()` and `handle()` take `retry: { onConflict: true | number | { retries, backoff } }`. When another append got there first (`AppendConditionError`), the command is read and decided again, so a command that can no longer hold is refused by its own decider rather than by the conflict (Emmett's `retry: { onVersionConflict }`). Off unless asked; `true` is 3 retries from 100 ms (`ConflictRetryDefaults`).
- `Backoff`, `backoffDelay`, `sleep` and `errorMessage` move to `@dcb-es/event-store`; `@dcb-es/event-store-postgres` re-exports them.
