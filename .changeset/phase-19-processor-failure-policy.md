---
"@dcb-es/event-store": minor
"@dcb-es/event-store-postgres": minor
---

Phase 19: the processor failure policy (fail fast by default, opt-in skip, a consumer never loses a processor)

- **A handler that throws no longer ends its processor.** `onError` on `createProcessor`, `createConsumer` processors and `projectionToProcessor`: `"retry"` (the default, after Axon 5) rolls back, logs, backs off (`backoff: { initialMs, maxMs }`, 1 s doubling to 60 s) and handles the same event again, blocking only that processor; `"skip"` (Emmett's) logs a warning and moves past it; `createProcessor` also has `"stop"`, the old behaviour, kept by `rebuildProjection` and `runHandler`. A function `(error, event) => action` decides per error. **Breaking** for code that relied on a processor's promise rejecting on a handler error: pass `onError: "stop"`.
- **A visible blocked status.** `RunningProcessor.status()` and `RunningConsumer.status()`; the bookmark table gains `blocked_error`, `blocked_position`, `blocked_attempts` and `blocked_since` (added by `ensureHandlersInstalled`, cleared by the next checkpoint), read with `readProcessorStatuses(pool)`.
- **`createConsumer` never loses a processor**: one that ends with an error (its lock held elsewhere, a lost connection) is started again after the backoff until the consumer stops. Its processors' promises settle only on stop.
- **Handlers are told when they're rebuilding**: `handlerFactory(client, { rebuilding })` and `ProjectionContext.rebuilding` (set by `rebuildProjection`).
- A `logger` option (`console` by default) for retry, skip and restart messages.
- New example `course-manager-cli-with-failure-policy`.
