---
"@dcb-es/event-store-express": minor
"@dcb-es/event-store": patch
---

Add `ApiSpecification` and `ApiE2ESpecification` HTTP-level test harnesses to `@dcb-es/event-store-express`. `ApiSpecification` provides a fluent given/when/then DSL that seeds a `MemoryEventStore`, fires HTTP requests via supertest, and asserts both the response and newly appended events. `ApiE2ESpecification` builds state through prior HTTP requests instead of event seeding. Helpers `expectResponse` and `expectError` simplify common assertions.

Extract shared assertion utilities (`normalizeForComparison`, `deepEqual`, `assertMatches`, `assertNewEvents`) from `DeciderSpecification` into a separate `assertions.ts` module in `@dcb-es/event-store` and re-export them from the package root.
