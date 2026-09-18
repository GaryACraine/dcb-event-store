---
"@dcb-es/event-store": minor
---

Add `versionedHandler()` utility and `VersionHandlers` type for event schema evolution. Dispatches to version-specific handler functions based on `schemaVersion` on `SequencedEvent`, defaulting to `"1"` when `schemaVersion` is absent. Throws an informative error for unrecognised versions unless a `fallback` handler is provided.
