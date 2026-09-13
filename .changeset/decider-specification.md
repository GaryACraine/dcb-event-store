---
"@dcb-es/event-store": minor
---

Add Decider type, DcbCommand, typed domain errors, and DeciderSpecification

- `DcbCommand<Type, Data>` — typed command interface mirroring DcbEvent
- `Decider` interface and `decider()` factory for formalised command handling
- `handle(store, decider, command)` — orchestrates buildDecisionModel, decide, and append
- `DcbError` base class with `NotFoundError` (404), `ValidationError` (400), `IllegalStateError` (422)
- `AppendConditionError` now extends `DcbError` (status 409)
- `DeciderSpecification` — fluent given/when/then testing API with `.then()`, `.thenThrows()`, `.thenNothingHappened()`, and `.thenCondition()` for boundary assertions
- `EventHandlers` and `EventHandlerStates` types exported from buildDecisionModel
