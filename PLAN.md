# PLAN.md — Production hardening of the dcb-event-store fork

## 0. Setup

### 0.1 Directory layout

Use a sibling layout so Claude Code can read the reference implementation
without it polluting the fork:

```
~/src/
├── dcb-event-store/      # your fork (this repo)
│   ├── CLAUDE.md
│   ├── PLAN.md           # this file
│   └── packages/...
└── emmett/               # read-only reference clone
```

### 0.2 Clone commands

```bash
cd ~/src

# Your fork. Note the upstream has moved to the kraken-tech org;
# github.com/PaulGrimshaw/dcb-event-store redirects there.
git clone git@github.com:<you>/dcb-event-store.git
cd dcb-event-store
git remote add upstream https://github.com/kraken-tech/dcb-event-store.git
git fetch upstream
pnpm install
pnpm -r run build
pnpm test          # requires Docker for testcontainers

# Reference clone, shallow, never edited
cd ~/src
git clone --depth 1 https://github.com/event-driven-io/emmett.git
```

Pongo (JSONB document API used in Phase 5) is a separate repo and an npm
package: `@event-driven-io/pongo`. Clone `https://github.com/event-driven-io/Pongo`
alongside if you want to read its transaction handling; the npm package is
enough to build against.

### 0.3 Where these files go

- `CLAUDE.md` → repo root of the fork. Claude Code reads it automatically.
- `PLAN.md` → repo root of the fork. Commit both on `main` before starting
  Phase 1 so every branch carries them.
- Add a `NOTICE` file at the repo root before the first phase that adapts
  Emmett code (Phase 2 at the latest).

### 0.4 Branching strategy and protecting `main`

`main` only ever contains merged, reviewed, tested phases. Work is partitioned
into one branch per phase and reaches `main` only through a pull request.

**One-time repository setup (do this before Phase 1):**

```bash
# Enforce it server-side so an agent cannot bypass it even by accident.
gh api -X PUT repos/<you>/dcb-event-store/branches/main/protection \
  -f required_status_checks='{"strict":true,"contexts":["test"]}' \
  -f enforce_admins=true \
  -f required_pull_request_reviews='{"required_approving_review_count":0}' \
  -f restrictions=null
```

Add a CI workflow at `.github/workflows/test.yml` that runs
`pnpm install && pnpm -r run build && pnpm lint && pnpm test` on every pull
request (the job must be named `test` to match the protection rule). Tests
need Docker; the default GitHub Ubuntu runner has it.

**Branch model:**

| Branch | Purpose | Lifetime | Merges to |
|---|---|---|---|
| `main` | Reviewed, tested phases only | permanent | — |
| `phase-N/<slug>` | All work for phase N | until PR merged | `main` via PR |
| `phase-N.M/<slug>` | A slice of a phase that grew too large | until PR merged | `main` via PR, in order |
| `spike/<slug>` | Throwaway experiments | delete when done | never |

Rules the agent follows (also in `CLAUDE.md`): branch from `origin/main`,
rebase onto it before the PR, one PR per branch, PR only when the seven-item
checklist in `CLAUDE.md` passes, human merges. No stacked unmerged branches;
if Phase 3 needs Phase 2, Phase 2 is merged first.

**Local safety net (optional but cheap):** a pre-commit hook that refuses
commits on `main`. The repo already uses husky; add to `.husky/pre-commit`:

```bash
if [ "$(git branch --show-current)" = "main" ]; then
  echo "Refusing to commit on main. Create a phase branch." >&2
  exit 1
fi
```

### 0.5 Working a phase with Claude Code

```
git fetch origin && git checkout -b phase-N/<slug> origin/main
claude
> Read CLAUDE.md and PLAN.md. We are starting Phase N. Enter plan mode,
> read every file listed under "Reference" and "Touches" for that phase,
> and propose the spec file contents before writing any implementation.
```

Approve the plan, let it write the spec, run the spec (it should fail), then
implement. Finish with the phase's "Done when" list. One phase per branch.

### 0.6 Examples — one per feature phase

The upstream repo teaches by variant examples: `course-manager-cli` is the
base, `course-manager-cli-with-readmodel` copies it and adds one concept, and
`docs/examples.md` documents each with "What it adds" and "How it differs"
(including a comparison table). Every feature phase continues that chain.

Rules:

- **Copy, don't modify.** Start from the base example named below, copy the
  directory, rename the package to `@dcb-es/examples-<name>`, and add only
  what the phase introduces. Existing examples must keep working unchanged so
  each one remains a clean illustration of one concept.
- **Same domain.** Stay with course/student subscriptions so a reader can
  diff examples and see exactly what the feature changes.
- **Tests are mandatory.** Each example has `vitest` tests like the existing
  ones (`src/api/Api.tests.ts` at minimum) and is a workspace package, so
  `pnpm test` and CI run them.
- **Document it.** Add a section to `docs/examples.md` in the existing
  shape: location, one-paragraph summary, "What it adds", entry-point wiring,
  the new concept explained with code references, and a "How it differs
  from <base>" table.
- **Keep it small.** An example demonstrates the feature; it is not a second
  test suite. If the feature is internal only (Phase 9 migrations), the
  example may be a short script rather than a CLI variant.

| Phase | Example name | Base example | What it shows |
|---|---|---|---|
| 1 | `course-manager-cli-with-idempotent-commands` | `course-manager-cli` | Client-supplied message ids; re-sending a command is a no-op; querying metadata |
| 2 | `course-manager-cli-with-decider-specs` | `course-manager-cli` | Replaces ad-hoc tests with `DeciderSpecification`, including boundary assertions |
| 3 | `course-manager-cli-with-consumer` | `course-manager-cli-with-readmodel` | Hardened consumer: two instances started, batch size, `startFrom`, graceful stop |
| 4 | `course-manager-cli-with-projections` | `course-manager-cli-with-readmodel` | Read model rewritten as a `Projection` with tag-based `canHandle`, tested with `ProjectionSpec` |
| 5 | `course-manager-cli-with-pongo` | `course-manager-cli-with-projections` | Course and student documents in Pongo/JSONB instead of three relational tables |
| 6 | `course-manager-cli-with-inline-projection` | `course-manager-cli-with-pongo` | Seat-count read model updated inside the append transaction; `waitUntilProcessed` removed because it is no longer needed |
| 7 | `course-manager-cli-with-rebuild` | `course-manager-cli-with-pongo` | Bump a projection version, run the rebuild while commands continue, swap |
| 8 | `course-manager-cli-with-otel` | `course-manager-cli-with-projections` | Console span exporter showing append, read and projection spans |
| 9 | `migrations-script` | — | Script applying migrations to an existing v1 schema |
| 10 | `course-manager-web-api` | `course-manager-cli-with-projections` | The course manager as an HTTP API: commands with ETags and idempotency keys, read-model queries, an SSE event feed, `ApiSpecification` tests, OpenAPI document; README with a curl walkthrough |
| 11 | `course-manager-web-api-sliced` | `course-manager-web-api` | Vertical slice architecture: bounded contexts, global tag constants, one directory per slice, independent projections with private lookup collections |

### 0.7 Reference path shorthand

- `DCB:` = `packages/event-store-postgres/src/` unless prefixed `core/`, which
  is `packages/event-store/src/`.
- `EMT:` = `../emmett/src/packages/emmett-postgresql/src/eventStore/` unless
  prefixed `core/`, which is `../emmett/src/packages/emmett/src/`.

---

## 1. Ordering and rationale

| Phase | Feature | Grade | Touches locks? |
|---|---|---|---|
| 1 | Event identity and metadata columns | Medium | No (append function only, after lock) |
| 2 | `DeciderSpecification` given/when/then | Easy | No |
| 3 | Consumer hardening (batching, instance locks, versioned checkpoints) | Medium | New namespace |
| 4 | Projection abstraction (shared by inline and async) | Medium | No |
| 5 | Pongo JSONB read models | Easy–Medium | No |
| 6 | Inline projections and before-commit hooks | Medium | Extends hold time |
| 7 | Projection registry and rebuild tooling | Medium–Hard | New namespace |
| 8 | OpenTelemetry | Easy–Medium | No |
| 9 | Versioned schema migrations | Medium | No |
| 10 | Web API (HTTP kit, Express adapter, ETags, ApiSpecification) | Medium | No |

Phases 1–3 close the biggest production gaps and touch nothing risky. 4 is a
prerequisite for 5, 6 and 7. 6 is deliberately after 5 so inline projections
have a real consumer to test against. 7 is last of the projection work because
it needs versioning from 3 and the abstraction from 4. Skip 8 and 9 until you
need them; they are independent of everything else. Phase 10 depends only on
Phases 1 and 2 (message ids for idempotency keys, `wrapEventStore` for
`ApiSpecification`) and on Phase 4 for its read-side endpoints; it can be
started any time after Phase 2 and is a good candidate to run in parallel with
Phases 3–7 on its own branch because it touches no store internals.

Not planned: multi-tenant LIST partitioning (Hard; conflicts with the global
sequence and lock key derivation), archiving, workflows (see §11).

---

## 2. Phase 1 — Event identity and metadata columns

**Goal.** Every stored event has a client-supplied or generated `message_id`,
a server timestamp, a schema version, and queryable JSONB metadata, without
changing the TEXT payload or the lock path.

**Reference.**
- `EMT: schema/tables.ts` — column set and index choices
- `EMT: schema/appendToStream.ts` — how ids/versions are passed as arrays
- `EMT: schema/appendToStream.int.spec.ts`

**Touches.**
- `DCB: eventStore/ensureInstalled.ts` — table, indexes, `dcb_append`
- `DCB: eventStore/copyWriter.ts` — COPY column list
- `DCB: eventStore/readSql.ts`, `queries.ts` — projection of new columns
- `DCB: core/eventStore/EventStore.ts` — `DcbEvent` gains optional `id`,
  `schemaVersion`; `SequencedEvent` gains `recordedAt`
- `DCB: core/eventStore/memoryEventStore/*` — mirror in memory store

**Schema delta.**
```sql
ALTER TABLE <events> ADD COLUMN message_id  UUID NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE <events> ADD COLUMN recorded_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE <events> ADD COLUMN schema_version TEXT NOT NULL DEFAULT '1';
ALTER TABLE <events> ADD COLUMN metadata JSONB NOT NULL DEFAULT '{}';
CREATE UNIQUE INDEX <events>_message_id_idx ON <events>(message_id);
```
Keep `payload TEXT` as `{data, metadata}` for one release for backward
compatibility, then stop writing metadata into payload in a follow-up.

**Design notes.**
- Idempotent append: inside `dcb_append`, after locks are held and the
  condition has passed, `INSERT ... ON CONFLICT (message_id) DO NOTHING` and
  return the existing position when zero rows were inserted. Because this
  runs after the lock, two concurrent appends with the same id serialise
  correctly. The COPY path cannot do `ON CONFLICT`; detect duplicates
  before COPY with a single `SELECT message_id ... WHERE message_id = ANY($1)`
  inside the same transaction.
- Do NOT put `metadata` in the lock key derivation.

**Spec.** `DCB: eventStore/eventIdentity.tests.ts`
- appends with explicit ids; duplicates return same position, insert nothing
- generated ids are unique across a COPY batch
- `recorded_at` is monotonic non-decreasing in sequence order within one txn
- metadata round-trips as JSONB and is queryable with `->>`

**Done when.** Spec green, existing suite green, `raw-throughput` and
`bulk-import` bench within 5% of baseline (COPY path).

---

## 3. Phase 2 — `DeciderSpecification`

**Goal.** Given/when/then testing for decision models, asserting both the
emitted events and the append condition (consistency boundary). Pure core
package, no Postgres.

**Reference.**
- `EMT: core/testing/deciderSpecification.ts`
- `EMT: core/testing/deciderSpecification.unit.spec.ts`
- `EMT: core/testing/deciderSpecification.async.unit.spec.ts`
- `EMT: core/testing/assertions.ts`
- `EMT: core/testing/wrapEventStore.ts` — store spy, worth porting too

**Touches.**
- new `DCB: core/testing/` directory, exported from `@dcb-es/event-store`
- reads `DCB: core/eventHandling/buildDecisionModel.ts` and
  `DCB: core/eventStore/memoryEventStore/`

**Design notes.**
- Shape: `DeciderSpecification.for(handler)` → `.given(events)` →
  `.when(command)` → `.then(events)` / `.thenThrows(...)` /
  `.thenCondition(query, after?)`. The last one is the DCB addition: assert the
  `AppendCondition` the handler produced, not just the events.
- Run `given` through the in-memory store so `buildDecisionModel` is exercised
  for real rather than stubbed.
- Deep-equality that ignores `id`/`recordedAt` from Phase 1 by default.

**Spec.** `DCB: core/testing/deciderSpecification.tests.ts` — port Emmett's
unit spec cases, add three boundary-assertion cases using the existing
`buildDecisionModel.tests.handlers.ts` fixtures.

**Done when.** Spec green; `docs/examples.md` gains a testing section;
`CLAUDE.md` updated with new key concepts (DcbCommand, Decider, typed errors,
DeciderSpecification).

---

## 4. Phase 3 — Consumer hardening

**Goal.** Turn `runHandler` into a production consumer: batch pulling,
processor instance identity, lock heartbeat/release, versioned checkpoints
(required for rebuilds), start-position policies, stop conditions, and a
clean lifecycle (`start`/`stop`/abort). Keep `sequence_position` checkpoints.

**Reference.**
- `EMT: consumers/postgreSQLEventStoreConsumer.ts`
- `EMT: consumers/postgreSQLProcessor.ts`
- `EMT: consumers/messageSource/postgreSQLMessageSource.ts`
- `EMT: schema/processors/processorsLocks.ts` — advisory processor locks
- `EMT: schema/storeProcessorCheckpoint.ts` — CAS with version column
- `EMT: schema/readProcessorCheckpoint.ts`
- `EMT: core/processors/processors.ts`, `processorLock.ts`,
  `processorStartPositions.ts`, `checkpoints.ts`
- Specs: `EMT: consumers/postgreSQLEventStoreConsumer.*.int.spec.ts`,
  `postgreSQLProcessor.pool.int.spec.ts`,
  `postgreSQLProcessor.transactions.int.spec.ts`,
  `projections/locks/postgreSQLProcessorLock.int.spec.ts`

**Touches.**
- `DCB: eventHandling/runHandler.ts` (refactor into `consumer.ts` +
  `processor.ts`; keep `runHandler` as a thin compat wrapper)
- `DCB: eventHandling/ensureHandlersInstalled.ts` — bookmark table gains
  `version BIGINT NOT NULL DEFAULT 1`, `instance_id TEXT`, `last_updated`
- `DCB: eventHandling/HandlerCatchup.ts` — delete (deprecated)
- `DCB: eventStore/advisoryLocks.ts` — add `processorLockKey(id)` in a new
  namespace (see CLAUDE.md invariant 3)

**Postgres / locking / transaction differences to handle.**
- Emmett checkpoints are `(transaction_id, global_position)` strings; drop
  that entirely. The DCB read barrier makes `sequence_position` sufficient.
- Emmett takes a processor advisory lock per instance and releases explicitly
  (`pg_advisory_unlock`, session-scoped). DCB currently uses
  `FOR UPDATE NOWAIT` on the bookmark row per batch. Keep the row lock for the
  per-batch commit (it is transaction-scoped and self-cleaning) and add the
  session-scoped processor lock only for instance ownership, released on
  `stop()`. Document that the session lock requires a session-mode connection.
- Checkpoint update becomes a CAS: `WHERE handler = $1 AND position = $expected
  AND version = $v`. Zero rows → another instance moved it → this instance
  must re-read and either continue or exit.

**Spec.** Port the Emmett consumer specs, translated:
- two instances, one handler: exactly one processes; the other exits or waits
  per policy
- batch of N events processed in ≤ ceil(N/batchSize) transactions
- crash mid-batch (throw) → bookmark unchanged, redelivered on restart
- `startFrom: 'BEGINNING' | 'CURRENT' | position`
- `stopAfter(position)` and `stopWhen(predicate)` for tests
- version mismatch after external bump → instance stops cleanly

**Done when.** Specs green; `runHandler.tests.ts` still green through the
compat wrapper; a new bench scenario `consumer-throughput.ts` added (do not
modify existing scenarios).

---

## 5. Phase 4 — Projection abstraction

**Goal.** One `Projection` type usable by both async consumers (Phase 3) and
inline execution (Phase 6): `canHandle` (by event type and/or tag query),
`handle(events, context)` where `context.client` is the transaction's
`PoolClient`, and a `name` + `version` for the registry (Phase 7).

**Reference.**
- `EMT: projections/postgreSQLProjection.ts`
- `EMT: projections/postgresProjectionSpec.ts` — the given/when/then for
  projections; port this too
- `EMT: core/projections/index.ts`
- Specs: `EMT: projections/postgreSQLProjection.canHandle.int.spec.ts`,
  `postgreSQLRawSQLProjection.single.int.spec.ts`,
  `postgresProjection.single.int.spec.ts`, `postgresProjection.multi.int.spec.ts`

**Touches.**
- new `DCB: projections/projection.ts`, `projections/rawSqlProjection.ts`,
  `projections/projectionSpec.ts`
- `DCB: eventHandling/consumer.ts` (Phase 3) — accept `Projection[]`

**Design notes.**
- `canHandle` should accept a DCB `Query` so a projection can subscribe by
  tag, not just type. That is the DCB-native improvement over Emmett.
- `ProjectionSpec`: `.for(projection).withEvents(...).when(...).then(assertOnDb)`
  runs the projection inside a transaction that is rolled back at the end, so
  specs are isolated without table truncation.

**Spec.** `DCB: projections/projection.tests.ts`, `projectionSpec.tests.ts`.

**Done when.** A raw-SQL projection runs via the async consumer end-to-end.

---

## 6. Phase 5 — Pongo JSONB read models

**Goal.** Document-style read models in JSONB with a Mongo-like API, running
inside the consumer's transaction so read-model writes and bookmark advance
commit atomically.

**Reference.**
- `EMT: projections/pongo/pongoProjections.ts` — note how `context.session.
  connection` is passed to `pongoClient({ connectionOptions: { connection } })`
- `EMT: projections/pongo/pongoProjectionSpec.ts`
- Specs: `pongoProjection.transaction.int.spec.ts`,
  `postgreSQLPongoProjection.schema.int.spec.ts`

**Touches.**
- new `DCB: projections/pongo/` (peer dep on `@event-driven-io/pongo`)
- `DCB: projections/projection.ts` — expose the `PoolClient` in a form Pongo's
  connection option accepts (Pongo wraps `pg` via dumbo; passing the raw
  client works — verify against the pinned version and pin it)

**Postgres / transaction notes.**
- Pongo must NOT open its own connection or transaction here. Verify with a
  spec that a throw in the handler rolls back the Pongo write (Emmett's
  `pongoProjection.transaction.int.spec.ts` is exactly this test).
- Pongo creates collections lazily; run schema creation eagerly at consumer
  start so DDL never happens inside the event-handling transaction.

**Spec.** Port the two Emmett specs; add one that projects by tag query
(from Phase 4) into a Pongo document keyed on the tag value.

**Done when.** Specs green; `docs/examples.md` example 2 rewritten to use a
Pongo read model.

---

## 7. Phase 6 — Inline projections and before-commit hooks

**Goal.** Optional projections that run inside the append transaction, and an
`onBeforeCommit` hook, for read models that must be consistent with the write.

**Reference.**
- `EMT: postgreSQLEventStore.ts` — search `inlineProjections` and
  `onBeforeCommitHook`; note how the hook runs after append but before commit
- Specs: `EMT: postgreSQLEventStore.*.int.spec.ts` covering inline projections;
  `projections/pongo/pongoProjection.transaction.int.spec.ts`

**Touches.**
- `DCB: eventStore/PostgresEventStore.ts` — `appendViaFunction` currently
  calls `dcb_append` via `pool.query` (autocommit). With inline projections
  configured, route through `withTransaction`: `BEGIN`, call `dcb_append`,
  run projections with the same client using the returned positions, run
  hook, `COMMIT`. `appendViaCopy` already uses `withTransaction`; add the
  projection step after `copyEventsToTable`.
- `PostgresEventStoreOptions` gains `inlineProjections?: Projection[]` and
  `onBeforeCommit?: (ctx) => Promise<void>`.

**Locking / transaction consequences — read before designing.**
- `dcb_append` takes `pg_advisory_xact_lock` on boundary keys. Those locks are
  now held until the client-side `COMMIT`, i.e. for the duration of the
  projection code. This is the one phase that directly reduces write
  concurrency on overlapping boundaries. Mitigations: keep inline projections
  to single-statement upserts; forbid network calls in the hook; document it.
- A projection throw must roll back the append. Spec it.
- The `hwmCache` and `pg_notify` in `notifyAndReturnPosition` must run after
  the projections succeed, not before.
- When no inline projections are configured, the existing autocommit path
  must be used unchanged so the default performance profile is untouched.

**Spec.** `DCB: eventStore/inlineProjections.tests.ts`
- inline projection sees the events appended in the same call, with positions
- throw in projection → no events persisted, no notify
- hook runs once per append, after projections
- default path (no projections) still uses the single-statement append

**Done when.** Specs green; `contention` and `overlap-consistency` bench run
with (a) no inline projections, (b) one trivial upsert projection; both sets
of numbers in the PR. Regression on (a) must be ~0.

---

## 8. Phase 7 — Projection registry and rebuild tooling

**Goal.** Register projections with name + version, detect version changes,
rebuild a projection from position 0 while handlers are temporarily skipped,
then resume. Both inline and async projections participate in the registry.
Handlers and rebuilders coordinate through a shared/exclusive advisory lock.

**Reference.**
- `EMT: projections/postgreSQLProjection.ts` — `init()` wrapping to call
  `registerProjection()` before user DDL (lines 163–183)
- `EMT: projections/management/projectionManagement.ts`
- `EMT: schema/projections/registerProjection.ts`,
  `projectionsLocks.ts` — exclusive vs shared advisory lock usage
- `EMT: projections/locks/tryAcquireProjectionLock.ts`,
  `postgreSQLProjectionLock.ts`
- `EMT: consumers/rebuildPostgreSQLProjections.ts`
- `EMT: postgreSQLEventStore.ts` — `handleProjections()` shared lock per
  projection per handle call (inline path)
- Emmett projections guide — "Version Your Projections" and "Rebuild From
  Events" sections
- Specs: `projections/management/projectionRegistration.int.spec.ts`,
  `projections/locks/postgreSQLProjectionLock.int.spec.ts`,
  `consumers/rebuildPostgreSQLProjections.{unit,int,e2e}.spec.ts`

**Registry schema.**

```sql
CREATE TABLE IF NOT EXISTS _projections (
    name           TEXT NOT NULL,
    version        INT NOT NULL DEFAULT 1,
    type           VARCHAR(1) NOT NULL,    -- 'i' (inline) or 'a' (async)
    kind           TEXT NOT NULL,           -- 'raw-sql', 'pongo', etc.
    status         TEXT NOT NULL DEFAULT 'active',  -- 'active' | 'inactive'
    definition     JSONB NOT NULL DEFAULT '{}'::jsonb,  -- canHandle, metadata
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (name, version)
)
```

Each projection factory sets `kind` automatically (`rawSqlProjection` →
`'raw-sql'`, `pongoProjection` → `'pongo'`, `pongoDocumentProjection` →
`'pongo-document'`). `definition` stores the projection's serialised
`canHandle` query and any metadata — useful for operational inspection
(what event types does this projection handle?) without needing the code.

The only difference from Emmett is no `partition` column (no
multi-tenancy — §11), so the primary key is `(name, version)` not
`(name, partition, version)`.

**Registration.**

Both inline and async projections are registered in the `_projections`
table. Registration is triggered during `projection.init()` — the
projection factories (`rawSqlProjection`, `pongoProjection`, etc.) wrap
the user's `init` to call `registerProjection()` first, following
Emmett's pattern (`postgreSQLProjection.ts:163-183`). Inline projections
register with `type = 'i'`, async with `type = 'a'`.

`Projection.version` remains optional (default `1`). The registry uses
`projection.version ?? 1`. This avoids a breaking change to the
`Projection` interface — all existing projections (Phases 4–6) work
without modification. When version changes, a new row is created in
the registry with the new version number.

**Locking.**

**Lock key format:** `R:<projectionName>:<version>`, hashed via
`fnv1a64` to a bigint, matching the existing namespace convention
(`L:`, `T:`, `G`, `P:`). DCB has no multi-tenancy/partition concept,
so the partition segment from Emmett is dropped. Add
`projectionLockKey(name, version)` in `advisoryLocks.ts`. The lock
is **transaction-scoped** (`pg_try_advisory_xact_lock_shared` for
handlers, `pg_advisory_xact_lock` for rebuild), matching the boundary
lock pattern.

During event handling, `runInlineProjections()` acquires a
**transaction-scoped shared** projection lock per projection before
calling `handle`. If the lock cannot be acquired (a rebuild holds the
exclusive lock) or the projection's status is not `active`, the
projection is **skipped** for that append. This follows Emmett's
`handleProjections()` pattern. The brief skip window is acceptable
because the rebuild will replay all events through the projection from
position 0, filling any gaps.

The same shared lock pattern applies to the async processor path —
`projectionToProcessor` wraps the handler to acquire the shared lock
before processing.

Rebuild reads via the normal `read()` path, so the barrier already
protects it from the commit gap; no special handling.

**Rebuild mechanism.**

Rebuild uses `rebuildProjection()`, a factory that creates a consumer
with `truncateOnStart: true` and a `stopAfter` condition that triggers
when no more events are available (add a `stopWhenCaughtUp` option to
`createConsumer`). The rebuild flow:

1. Acquire **exclusive** `R:<name>:<version>` lock (blocks handlers
   from acquiring the shared lock)
2. Set registry status to `inactive`
3. Call `projection.truncate()` to clear the read model
4. Replay all events from position 0 through the projection's
   `handle`, using the existing `read()` path (barrier-protected)
5. Set registry status to `active`, update version
6. Release exclusive lock

For **zero-downtime blue-green rebuilds** (Emmett's recommended
approach): deploy a new projection version (e.g., version 2) writing
to a new collection/table (name suffixed with `_v2`). Let it catch up.
Once current, switch queries to the new collection. Remove the old
projection. This is the pattern documented in Emmett's projections
guide (§ "Version Your Projections" and § "Rebuild From Events").

**Touches.**
- new `DCB: projections/registry/` with the `_projections` table and
  `registerProjection()`, `getProjectionStatus()`, `setProjectionStatus()`
- `DCB: projections/rawSqlProjection.ts` — wrap `init` to call
  `registerProjection()` before user DDL (Emmett pattern)
- `DCB: projections/pongo/pongoProjection.ts` — same init wrapping
- `DCB: eventStore/PostgresEventStore.ts` — add shared lock acquisition
  in `runInlineProjections()` before each `handle` call; skip projection
  if lock not acquired or status not active
- `DCB: eventStore/advisoryLocks.ts` — `projectionLockKey(name, version)`
  in the `R:` namespace
- `DCB: eventHandling/consumer.ts` — consult registry on start; refuse to
  run a projection whose registered version is newer than the code's;
  `projectionToProcessor` wraps handler to acquire shared lock

**Spec.** Port the three Emmett rebuild specs (unit, int, e2e) and the
registration spec. Add:
- registry CRUD operations
- version mismatch rejection
- rebuild with concurrent appends; final state equals a fresh from-zero
  projection
- inline projection skipped during rebuild window (shared lock blocked by
  exclusive)

**Done when.**
- Specs green: registry CRUD, version mismatch rejection, rebuild
  with concurrent appends, rebuild final state = from-zero projection,
  inline projection skipped during rebuild window
- Existing test suite green
- New example: `course-manager-cli-with-rebuild` based on
  `course-manager-cli-with-pongo`
- `docs/examples.md` updated
- `PLAN.md` §12 status updated
- Changeset added
- `CLAUDE.md` key concepts updated (projection registry, rebuild,
  projection lock namespace `R:`)

---

## 9. Phase 8 — OpenTelemetry (optional)

**Reference.** `EMT: core/observability/*`, `EMT: core/otel.ts`,
`otel-node.ts`. Add spans at `append`, `read`, consumer batch, projection
`handle`. Attributes: event count, boundary key count, lock wait time (expose
from `dcb_append` via `RETURNING` or `clock_timestamp()` deltas). No schema
changes. Peer-dependency on `@opentelemetry/api` only.

## 10. Phase 9 — Versioned schema migrations (optional)

**Reference.** `EMT: schema/migrations/0_42_0/`, the `TODO` blue-green
comments in `storeProcessorCheckpoint.ts` (a cautionary example of what
happens without a migration story from day one). Replace `ensureInstalled`'s
idempotent DDL with a `_schema_version` table and ordered migration files;
Phase 1 becomes migration 0001.

---

## 10a. Phase 10 — Web API

**Goal.** Let a user expose a DCB event-sourced application over HTTP with the
same ergonomics Emmett gives Express users: a thin handler model, typed
errors mapped to RFC 9457 problem details, ETag-based client concurrency,
idempotent commands, a given/when/then `ApiSpecification`, and a runnable
example. Framework-agnostic core with an Express adapter first (Fastify/Hono
can follow the same pattern later).

**Reference (Emmett).**
- `../emmett/src/packages/emmett-expressjs/src/application.ts` —
  `getApplication`, `registerWebApi`, `startAPI`, middleware wiring
- `.../etag.ts` — `toWeakETag`, `getETagValueFromIfMatch`, `setETag`, header names
- `.../handler.ts`, `responses.ts` — `on(handler)`, `OK/Created/Accepted/NoContent`,
  `sendProblem`, `ResponseFromEvents`
- `.../middlewares/problemDetailsMiddleware.ts`, `traceIdMiddleware.ts`
- `.../testing/apiSpecification.ts`, `apiE2ESpecification.ts`
- `.../e2e/commandHandler/api.ts` and `etagConcurrency.int.spec.ts` — the
  canonical If-Match → 412 flow
- Specs total ~1,700 lines; almost all are framework-level and port with
  light changes. The only DCB-specific rewrite is ETag semantics (below).

**New packages.**
- `packages/event-store-web` (`@dcb-es/event-store-web`): framework-agnostic.
  Errors, problem-details mapping, ETag helpers, idempotency helpers, response
  types, `ApiSpecification` core.
- `packages/event-store-express` (`@dcb-es/event-store-express`): Express
  adapter — application factory, middlewares, `on()` handler wrapper,
  `startAPI`, health endpoints, supertest-based `ApiSpecification` binding.

### 10.1 Typed errors and problem details (Easy)

The examples currently `throw new Error("Course ... doesn't exist")`, which
can only ever be a 500. Add to `@dcb-es/event-store`:

```ts
class DcbError extends Error { code: string; status: number }
class NotFoundError    extends DcbError  // 404
class ValidationError  extends DcbError  // 400
class IllegalStateError extends DcbError // 422 (invariant violated)
```
and make `AppendConditionError` carry `status = 409`. `event-store-web`
provides `toProblemDetails(error, request)` producing an RFC 9457 document
(`type`, `title`, `status`, `detail`, `instance`, plus `traceId`), with a
user-supplied `mapError` override exactly as Emmett has. Status mapping:

| Condition | Status | Source |
|---|---|---|
| Body fails validation | 400 | `ValidationError` |
| Resource absent | 404 | `NotFoundError` |
| Domain invariant | 422 | `IllegalStateError` |
| Server-side boundary conflict during append | 409 | `AppendConditionError` |
| Client's `If-Match` stale | 412 | `StaleETagError` (new, web package) |
| `If-Match` required but absent | 428 | `MissingETagError` (new, web package) |
| Anything else | 500 | default |

Spec: port `mapError.int.spec.ts` and `responses.*.spec.ts`.

### 10.2 ETags with DCB semantics (Medium — the one real design task)

In Emmett an ETag is the stream version and becomes `expectedStreamVersion`.
DCB has no stream version. What it has is `buildDecisionModel`'s
`appendCondition.after`: the position of the last event that matched the
command's decision-model queries. That is the correct ETag for a DCB resource,
with two rules:

1. **Define one "version query" per resource**, the union of the decision
   models that describe it (for a course: `CourseExists`, `CourseCapacity`,
   `CourseTitle`, `CourseSubscriptions`). `GET /courses/:id` builds that model
   and returns `ETag: W/"<after>"`. Different commands on the same resource
   must derive their ETag from the same version query, or clients see the
   version jump around. Provide `resourceVersion(eventStore, handlers)` in the
   web package that returns `{ state, version }`.
2. **`If-Match` is a client-intent guard, not the correctness guard.** On a
   command, the server still builds its own decision model and appends with
   the server-derived condition; that is what protects the boundary (Promise
   A). `If-Match` is compared against the freshly built model's `after`: if
   they differ, the client decided on stale state → 412 before any append is
   attempted. If they match, proceed; a concurrent writer racing in between
   still produces a 409 from the append. Document both codes in the example
   README so users understand 412 = "you were stale", 409 = "you lost a race".

Responses to successful commands set `ETag: W/"<position returned by append>"`
so the client can chain requests. Reuse Emmett's weak-ETag helpers verbatim;
they are format-only. Whether `If-Match` is required or optional is a per-route
option (`{ concurrency: 'required' | 'optional' | 'ignore' }`).

Spec: port `etagConcurrency.int.spec.ts` as a DCB flow: create course → GET
returns ETag → change capacity with matching If-Match → 204 + new ETag →
replay stale If-Match → 412 → concurrent conflicting append → 409.

### 10.3 Idempotent commands (Easy, depends on Phase 1)

Accept `Idempotency-Key` on command routes and pass it through as the event
`message_id` (or as the key from which per-event ids are derived for
multi-event commands). A retried POST with the same key returns the same
`ETag`/`Location` and appends nothing. This is the HTTP-facing reason Phase 1
exists. Spec: retry the same POST twice, assert one event and identical
headers.

### 10.4 Handler model, application factory, lifecycle (Easy)

Port `on()`, the response helpers and `getApplication`/`registerWebApi`
almost as-is. Add what Emmett leaves to the user:

- `startAPI` with **graceful shutdown**: on SIGTERM stop accepting, drain
  in-flight requests, `AbortController.abort()` any consumers started with
  the app, close the pool.
- `GET /health/live` (process up) and `GET /health/ready` (one `SELECT 1`
  against the pool, plus each registered consumer's lag = hwm − bookmark
  below a configurable threshold). Fargate/ALB health checks need this.
- Trace-id middleware (`x-request-id` in/out) that Phase 8 can bind to OTel.
- Disable Express's default weak ETag on JSON bodies (Emmett does this too)
  so our ETags are the only ones.
- JSON body limit, CORS and helmet as opt-in options, not defaults.

### 10.5 `ApiSpecification` and `ApiE2ESpecification` (Easy–Medium)

Port both. `given` changes from `existingStream(name, events)` to
`existingEvents(events)` (events carry their own tags in DCB). `then` accepts
a response assertion, `expectNewEvents([...])`, or both, using the
`wrapEventStore` spy from Phase 2 against the in-memory store.
`ApiE2ESpecification` runs the same DSL against a real Postgres via
testcontainers. Spec: port `apiSpecification.int.spec.ts` and
`apiE2ESpecification.int.spec.ts`.

### 10.6 Read side (Medium, depends on Phase 4)

- Query endpoints over projections/Pongo read models with pagination
  (`limit`/`cursor`), returning `ETag` = the projection's bookmark position so
  clients can detect staleness.
- **Read-your-writes options**, documented as a choice rather than a default:
  (a) command responds `202 Accepted` + `Location` and the client polls the
  read endpoint until its `ETag` ≥ the command's returned position; (b) the
  read endpoint accepts `Prefer: wait=<ms>` and blocks until the bookmark
  reaches `If-None-Match`'s position or times out; (c) inline projection
  (Phase 6) for the few reads that must be strongly consistent. Implement (a)
  and (c) in the example; implement (b) as a helper since it is what
  `waitUntilProcessed` already does, just exposed over HTTP.
- **Event feed** `GET /events?after=<pos>&types=..&tags=..` as Server-Sent
  Events over `eventStore.subscribe(query, { after })`, with `Last-Event-ID`
  = sequence position for reconnects. This is a DCB-native feature Emmett
  does not have and is useful for live UIs and for downstream integrators.

### 10.7 Validation and OpenAPI (Easy)

Validate request bodies with `zod` at the route (peer dependency); a failure
becomes a 400 problem document listing issues. Generate an OpenAPI 3.1
document from the same schemas (`@asteasolutions/zod-to-openapi` or similar)
and serve it at `GET /openapi.json`; include `ETag`, `If-Match`,
`Idempotency-Key` and problem-details responses in the generated spec so
clients get the concurrency contract for free.

**Touches.** No store internals. `packages/event-store` gains the error
classes only. Examples: new `course-manager-web-api` (see §0.6).

**Done when.** All ported specs green; example package tests green including
the ETag flow and idempotent retry; `GET /openapi.json` validates; README
walkthrough reproduces create → read → update-with-ETag → stale-412 → SSE
feed using `curl`.

**Explicitly out of scope** (note in README as extension points):
authentication/authorization (provide a middleware slot only), rate limiting,
multi-tenancy, GraphQL, WebSockets (SSE covers the live-feed need).

---

## 10b. Phase 10 — Sub-phase breakdown

Phase 10 is split into sub-phases, each a separate branch and PR. Phases 8
and 9 are deferred; work proceeds directly from Phase 7 to Phase 10.

| Sub-phase | Branch | Deliverable | Depends on |
|-----------|--------|-------------|------------|
| 10.1 | `phase-10.1/web-api-scaffolding` | Package scaffolding (`event-store-web`, `event-store-express`) + RFC 9457 problem details mapping + `StaleETagError`/`MissingETagError` | — |
| 10.4 | `phase-10.4/handler-model` | `on()` handler wrapper, response helpers (`OK`/`Created`/`NoContent`), `getApplication`, `startAPI` with graceful shutdown, health endpoints, trace-id middleware | 10.1 |
| 10.3 | `phase-10.3/idempotent-commands` | `Idempotency-Key` header → `DcbEvent.id` mapping, UUID v5 derivation for multi-event commands | 10.4 |
| 10.5 | `phase-10.5/api-specification` | Given/when/then API test harness with `MemoryEventStore`, `existingEvents()`, `expectNewEvents()`. Example package: `course-manager-web-api` | 10.4 |
| 10.6 | `phase-10.6/read-side` | SSE event feed via `subscribe()`, query endpoint helpers, `Prefer: wait=<ms>` | 10.4 |
| 10.7 | `phase-10.7/validation-openapi` | Zod request body validation, OpenAPI 3.1 generation, `GET /openapi.json` | 10.4 |
| 10.2 | `phase-10.2/etag-semantics` | ETags with DCB semantics: `resourceVersion()`, `If-Match` as client-intent guard (412) vs append condition (409), concurrency modes | 10.4, 10.5 |

> **Skipped.** DCB's `appendCondition` already provides stronger correctness guarantees
> than If-Match optimistic concurrency. The If-Match write-side guard adds complexity
> (artificial version-query convention, `resourceVersion()`) for no correctness benefit.
> The read-side ETag use cases (response ETags, `Prefer: wait`, `If-None-Match`) are
> complete as of phase 10.6.

---

## 11. Workflows — analysis, not a phase yet

Emmett's `Workflow<Input, State, Output>` (`EMT: core/workflows/workflow.ts`,
`workflowProcessor.ts`, `testing/workflowSpecification.ts`) is a process
manager: `decide(message, state)` → commands (`Sent`) / events (`Published`) /
`Scheduled`; `evolve` folds the workflow's own stream, which acts as its
inbox/outbox. It is the least mature part of Emmett
(`unsupportedWorkflowProcessor.ts` exists; scheduling is declared, not
delivered).

Fit for DCB: good, arguably better than streams. A workflow instance is a
tag; inputs and outputs are events carrying that tag; the append condition
expresses "no output already produced for input X" without a separate stream.
Build it on Phase 3's consumer plus `buildDecisionModel`. Output dispatch
(at-least-once to idempotent command handlers — Phase 1 message ids make
receivers idempotent) is the hard part and is hard everywhere.

Revisit after Phase 5. Port `workflowSpecification.ts` at that point; it is
pure and would be Easy.

---

## 11a. Phase 11 — Vertical slice architecture

**Goal.** A new `course-manager-web-api-sliced` example that restructures the
Phase 10 web API from a flat `api/` directory into a vertical slice
architecture with bounded contexts, shared global tags, and fully independent
projections. No library changes — this is purely an example-level
architectural pattern.

**Example name:** `course-manager-web-api-sliced`
**Base example:** `course-manager-web-api`

| Phase | Example name | Base example | What it shows |
|---|---|---|---|
| 11 | `course-manager-web-api-sliced` | `course-manager-web-api` | Vertical slice architecture, bounded contexts, global tag constants, independent projections with private lookup collections |

### 11.1 Directory structure — contexts and slices

The flat `src/api/` directory from Phase 10 is replaced by a hierarchy that
mirrors bounded contexts and individual slices:

```
src/
├── contexts/
│   └── enrollment/           # bounded context
│       ├── Events.ts         # all domain events for this context
│       └── slices/
│           ├── register-course/      # write slice
│           │   ├── command.ts        # DcbCommand type alias
│           │   ├── decider.ts        # decider (handlers + decide)
│           │   ├── decisionModels.ts # EventHandlerWithState factories
│           │   ├── schema.ts         # Zod validation + OpenAPI metadata
│           │   ├── route.ts          # Express route (configureXxxRoute)
│           │   └── route.tests.ts    # ApiSpecification + E2E tests
│           ├── register-student/     # write slice
│           ├── subscribe-student/    # write slice
│           ├── unsubscribe-student/  # write slice
│           ├── change-course-capacity/ # write slice
│           ├── course-details/       # read slice (projection + route)
│           │   ├── projection.ts     # pongoProjection
│           │   ├── route.ts
│           │   └── route.tests.ts
│           ├── student-details/      # read slice
│           ├── course-list/          # read slice (shares projection)
│           ├── event-feed/           # infrastructure slice (SSE)
│           └── openapi/              # infrastructure slice
├── shared/
│   ├── Tags.ts               # global tag key constants
│   ├── dependencies.ts       # SliceDependencies interface
│   └── idempotency.ts        # shared idempotency-key lookup
├── index.ts                  # composition root
└── scenario.tests.ts         # full lifecycle E2E test
```

Each slice is self-contained: its command type, decision models, decider,
validation schema, route, and tests live together. A slice can be added or
removed by adding/removing its directory and one line in the composition root
(`index.ts`).

### 11.2 Global tag constants

Tag keys (`courseId`, `studentId`, `studentNumberIndex`) are defined once in
`src/shared/Tags.ts` as string constants. Events and decision models import
these constants rather than using magic strings. This ensures tag keys are
consistent across contexts and enables safe rename-refactoring.

### 11.3 Context-level events

Domain events are grouped by bounded context (`contexts/enrollment/Events.ts`),
not scattered across slices. Multiple slices within the same context import
from the shared Events file. This reflects the fact that events are the
context's public contract — write slices produce them, read slices and other
contexts consume them.

### 11.4 Independent projections

The Phase 10 example had two Pongo projections (`CourseDetailsProjection` and
`StudentDetailsProjection`) that cross-read each other's collections: the
course projection looked up the `students` collection to denormalise student
names, and the student projection looked up the `courses` collection for
course titles. This created temporal coupling — tests had to
`waitUntilProcessed` on the *other* projection before issuing a subscription
command, and the two projections could not be deployed, rebuilt, or removed
independently.

The fix follows the principle that **each projection owns all the data it
needs**. Each projection subscribes to the events that carry the data it
requires and maintains its own private lookup collection:

- `CourseDetailsProjection` now also handles `studentWasRegistered` and
  stores student data in a private `_course_projection_students` collection.
  On `studentWasSubscribed`, it reads from its own lookup — never from the
  `students` collection owned by the student projection.

- `StudentDetailsProjection` now also handles `courseWasRegistered`,
  `courseTitleWasChanged`, and `courseCapacityWasChanged`, storing course
  data in a private `_student_projection_courses` collection. On
  `studentWasSubscribed`, it reads from its own lookup — never from the
  `courses` collection owned by the course projection.

Each projection can be added, removed, rebuilt, or run at a different
processing speed without affecting the other. The `truncate` function cleans
up the private lookup tables alongside the primary collection. Each slice's
tests only set up their own projection — no imports or dependencies on the
other projection's consumer.

### 11.5 Composition root

`src/index.ts` is the only file that knows about all slices. It wires
dependencies, starts projections, and registers routes. Adding a new slice
means adding its `configureXxxRoute(deps)` call here and nothing else.

**Touches.** No library packages changed. Example-only.

**Done when.** All 27 tests green (9 test files); scenario lifecycle test
passes end-to-end including subscription with denormalised student/course
data; projections are independently testable with no cross-projection waits.

---

## 11b. Phase 12 — Command type standardization

**Goal.** Update `DcbCommand` in `@dcb-es/event-store` to adopt standard command typing (matching Emmett's command typing structure). This includes defining `DcbCommand` with `Readonly<...>`, optional `metadata` (defaulting to `{ now: Date }`), optional nominal `kind?: 'Command'`, helper types (`CommandTypeOf`, `CommandDataOf`, `CommandMetaDataOf`), and providing the `command(...)` builder factory function.

**Package affected.** `@dcb-es/event-store`

| Phase | Description |
|---|---|
| 12 | Standardize `DcbCommand` definition, metadata support, and helper functions |

### 12.1 Changes to `DcbCommand.ts`

- Redefine `DcbCommand` type with optional `metadata` property and `Readonly` constraint.
- Add utility types `CommandTypeOf<T>`, `CommandDataOf<T>`, and `CommandMetaDataOf<T>`.
- Add `command(...)` factory function for creating typed command instances with automatic inference.
- Re-export factory function and utility types from `packages/event-store/index.ts`.

### 12.2 Compatibility & Verification

- Ensure `Decider`, `deciderSpecification`, and existing examples/tests compiled against `DcbCommand` continue to work without breaking changes.
- Add tests in `packages/event-store` specifically for `DcbCommand`, helper types, and the `command(...)` builder function.

---

## 12. Status

| Phase | Branch | Status | Bench delta |
|---|---|---|---|
| 1 | `phase-1/event-identity` | complete | bench green, no regression |
| 2 | `phase-2/decider-specification` | complete | N/A (pure core, no append/read/lock changes) |
| 3 | `phase-3/consumer-hardening` | complete | N/A (processor lock is session-scoped, not in append/read hot path) |
| 4 | `phase-4/projection-abstraction` | complete | N/A (no append/read/lock changes) |
| 5 | `phase-5/pongo-projections` | complete | N/A (no append/read/lock changes) |
| 6 | `phase-6/inline-projections` | complete | bench pending — no append/read path changes when no inline projections configured |
| 7 | `phase-7/projection-registry` | complete | N/A (no append/read hot-path changes; shared lock in projection handlers is xact-scoped, not in write path) |
| 8 | | not started | |
| 9 | | not started | |
| 10.1 | `phase-10.1/web-api-scaffolding` | complete | N/A (no append/read/lock changes) |
| 10.4 | `phase-10.4/handler-model` | complete | N/A (no append/read/lock changes) |
| 10.5 | `phase-10.5/api-specification` | complete | N/A (no append/read/lock changes) |
| 10.6 | `phase-10.6/read-side` | complete | N/A (no append/read/lock changes) |
| 10.3 | `phase-10.3/idempotent-commands` | complete | N/A (no append/read/lock changes) |
| 10.7 | `phase-10.7/validation-openapi` | complete | N/A (no append/read/lock changes) |
| 10.2 | `phase-10.2/etag-semantics` | skipped — out of scope | N/A |
| 11 | `phase-11/web-api-sliced` | in progress | N/A (no append/read/lock changes) |
| 12 | `phase-12/command-type-standard` | complete | N/A (pure core type and utility update) |

## 13. Known issues

### 13.1 IDE `@test` path alias not resolved in VS Code

**Status:** resolved (merged to main via `chore/fix-test-rootdir`)

Two root causes were found and fixed:

1. **TS6059 `rootDir` violation** — TypeScript inferred `rootDir` from each
   package's `include` patterns (e.g. `./src/**/*`), scoping it to the package
   directory. The `@test/*` alias resolves to `../../test/`, outside that root,
   so the language server raised TS6059. Fix: add `"rootDir": "../.."` to each
   affected `tsconfig.json` (`noEmit: true`, IDE/test config) and override with
   `"rootDir": "."` in each `tsconfig.build.json` so build output paths are
   unchanged. Applied across 8 examples + `event-store-postgres` +
   `event-store-bench`.

2. **Phantom `@types/pg` from a parent-directory project** — a separate project
   at `/Users/.../Projects/` has its own `node_modules/@types/pg@8.23.1`.
   TypeScript walks up the directory tree and picks it up, conflicting with the
   project's `@types/pg@8.20.0` (in the pnpm store), producing TS2322. Fix:
   hoist `@types/pg@8.20.0` to the workspace root `devDependencies` so
   TypeScript finds the correct version at `node_modules/@types/pg` before
   walking up.
