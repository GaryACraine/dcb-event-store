---
"@dcb-es/event-store-postgres": minor
"@dcb-es/event-store": minor
---

Background processors share two connections per consumer, whatever their number (phase 20, the eventmodelers kit's ADR-047).

- `NotificationListener`: one `LISTEN` connection per `PostgresEventStore` (`store.notificationListener`), shared by its subscriptions and, through `waitUntilProcessed`'s new `listener` option, by slow waits. If it's lost, subscriptions poll while it reconnects, and are woken when it's back.
- `LockHolder`: `createConsumer` holds all its processors' advisory locks on one session. If that connection is lost, every processor on it stops ("lost its lock") and the consumer starts it again on a new one. Before, nothing listened for the lock connection's `error`: a terminated lock connection was an uncaught exception, and the processor ran on unowned.
- `subscribe` reads a page of events (`SubscribeOptions.batchSize`, 100 by default; a processor passes its `batchSize`) and gives the connection back before yielding them. Before, the read held a connection and an open transaction while each event was handled, so processors handling events at once needed two connections each and could deadlock a pool. The processor's catch-up loop (`stopWhenCaughtUp`) reads in pages too.
- `acquireProcessorLock` takes an optional `LockHolder`, and its handle has a `lost` signal. `PostgresEventStoreOptions.notificationListener` shares a listener between stores.
