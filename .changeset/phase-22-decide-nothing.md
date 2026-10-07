---
"@dcb-es/event-store": minor
---

A decider may decide nothing (phase 22, the eventmodelers kit's ADR-050).

- `handle()` accepted only a decision of at least one event ("Decider must return at least one event"), although `DeciderSpecification.thenNothingHappened()` tests a decider that returns `[]`. Now a decision of no events appends nothing and throws nothing, as Emmett's command handler does: a repeat, or a command whose intent already holds, is a no-op instead of an invented event or a refusal.
- `handle()` keeps its signature. With nothing decided it returns the position the decision was read at (the last event it read, or the initial position).
- New `handleCommand()` returns `{ position, events }`, so a caller (an HTTP route) can tell a change recorded from nothing new.
