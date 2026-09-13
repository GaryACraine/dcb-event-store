---
"@dcb-es/event-store-postgres": minor
---

Add production consumer with processor lock, CAS checkpoints, and start-position policies (Phase 3)

- **`createProcessor`**: hardened event handler with session-scoped advisory lock (`P:` namespace), CAS-versioned checkpoints (`version` column on bookmark table), and configurable start-position policies (`BEGINNING`, `CURRENT`). Replaces the simple `runHandler` poll loop.
- **`createConsumer`**: wraps one or more processors with shared lifecycle. `stop()` aborts all processors and resolves when all are done.
- **Bookmark table migration**: adds `version BIGINT`, `instance_id TEXT`, and `last_updated TIMESTAMPTZ` columns (idempotent, backward-compatible).
- **Processor lock**: `processorLockKey()` in the `P:` advisory lock namespace prevents two instances of the same handler from running concurrently.
- **CAS checkpoint**: `storeCheckpoint()` uses `WHERE version = $expected` as defense-in-depth against double-processing.
- **`runHandler`**: refactored to a thin backward-compatible wrapper around `createProcessor`.
- **`HandlerCatchup`**: removed (deprecated since Phase 1).
