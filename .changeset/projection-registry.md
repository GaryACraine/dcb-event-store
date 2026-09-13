---
"@dcb-es/event-store-postgres": minor
---

Add projection registry, projection locking, and rebuild tooling. A `_projections` table tracks every projection by (name, version) with type, kind, status, and serialised query definition. Projection factories auto-register during init; inline projections are re-registered with type 'i' during ensureInstalled. Shared/exclusive advisory locks (R: namespace) coordinate handlers with rebuilders. `rebuildProjection()` orchestrates deactivate → truncate → replay → reactivate. Processors gain a `stopWhenCaughtUp` option for clean "process everything then stop" semantics.
