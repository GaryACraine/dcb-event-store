---
"@dcb-es/event-store-postgres": minor
---

Concurrency governors, as in Marten's async daemon (phase 21, the eventmodelers kit's ADR-047): the connections processors borrow at once no longer grow with their number.

- `PostgresEventStoreOptions.maxConcurrentSubscriptionReads` (default 4): a store's subscriptions take turns at reading. `read()` isn't capped.
- `ConsumerOptions.maxConcurrentHandling` (default 4): a consumer's processors take turns at handling an event (its transaction) or moving a checkpoint. A blocked processor's wait for its retry holds no turn. `ProcessorOptions.handlingSlots` takes a shared `Semaphore` (exported).
- 30 processors handling a burst borrowed 42 connections at once uncapped, 14 capped. A pool of 2 + the caps + 1 can't deadlock. `Infinity` turns a cap off.
