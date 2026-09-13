---
"@dcb-es/event-store-postgres": minor
---

Add inline projections and onBeforeCommit hook to PostgresEventStore. Projections passed via the `inlineProjections` option run inside the append transaction, guaranteeing the read model is consistent the instant `append` returns. The `onBeforeCommit` hook runs after projections but before COMMIT. When neither option is configured, the existing autocommit path is preserved with zero overhead.
