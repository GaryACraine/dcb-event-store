---
"@dcb-es/event-store": minor
"@dcb-es/event-store-postgres": minor
"@dcb-es/event-store-web": patch
"@dcb-es/event-store-express": minor
---

Phase 18: read-your-writes across read models, listener hygiene, and graceful shutdown (Emmett PRs #405 and #406)

- **A processor's checkpoint means "has seen everything up to X"** (Emmett's meaning). `SubscribeOptions.onCaughtUp(position)` reports how far a subscription has seen when the events after the last one yielded didn't match its query (Postgres: the read barrier's high-water mark; memory: the last position). The processor stores it as its checkpoint, so `waitUntilProcessed` works for any position; before, a wait on a write the projection doesn't handle timed out.
- **No stray listeners.** Postgres `subscribe` holds one notification, error and abort listener for its life (it added two on every idle poll); `waitUntilProcessed` holds one for the wait (it added one every 100 ms). A NOTIFY during a read now wakes the next wait at once.
- **`WaitTimeoutError` moves to `@dcb-es/event-store`** as a `DcbError` (`WAIT_TIMEOUT`, 504); `@dcb-es/event-store-postgres` re-exports it. `toProblemDetails` maps it to 504.
- **`preferWait` answers 504 for a `WaitTimeoutError`**, matched by class or name. Breaking for custom wait functions: an error that only *mentions* "timeout" is now passed on (a 500); throw `WaitTimeoutError` instead. The library's own timeout ("Timeout: …") used to miss the old case-sensitive check.
- **`onShutdown(handler)`** in `@dcb-es/event-store-express`, from Emmett with PR #406: one process listener per signal, each handler run once per shutdown, a second signal exits. **`startAPI` no longer registers signal handlers** (breaking if you relied on it closing the server on SIGTERM); `stopAPI(server)` closes the server and ends open connections such as SSE feeds.
