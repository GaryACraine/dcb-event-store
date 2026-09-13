# CLAUDE.md — dcb-event-store fork

Implementation of the Dynamic Consistency Boundary (DCB) pattern for
Node.js/TypeScript, based on Sara Pellegrini's design. This is a fork of
`kraken-tech/dcb-event-store` (BSD-3-Clause, copyright Kraken Technologies
Limited). We are backfilling production features, several of them adapted from
`event-driven-io/emmett`, which is vendored read-only at `../emmett` for
reference. The roadmap is in `PLAN.md`; work one phase at a time.

## Key concepts

- **EventStore** — interface for reading and appending events with
  consistency-boundary conditions (`append`, `read`, `subscribe`).
- **Tags** — key:value strings on events; the axis events are queried by.
- **Query** — which events to fetch: by event types and tag filters.
- **AppendCondition** — `failIfEventsMatch: Query` plus `after: SequencePosition`;
  the append fails if any matching event exists after that position.
- **Decision model** (`buildDecisionModel`) — folds events into state for a
  command and returns the `AppendCondition` that protects that decision.
- **Event handlers** — projections and process managers reacting to events
  via `runHandler`.
- **SequencePosition** — global ordering of events; the basis for conditions,
  bookmarks and read barriers.
- **Event identity** (`message_id`) — every stored event carries a UUID
  `message_id` (auto-generated or caller-supplied via `DcbEvent.id`). A unique
  index enforces deduplication: appending events with a previously-seen
  `message_id` is a silent no-op (`ON CONFLICT DO NOTHING`), making retries
  safe. `SequencedEvent` exposes `id` and `recordedAt` on the read side.
- **Event metadata columns** — the event table has four columns added in
  Phase 1 alongside `payload`: `message_id UUID`, `recorded_at TIMESTAMPTZ`,
  `schema_version TEXT` (default `'1'`), `metadata JSONB` (default `{}`).
  Schema migration is idempotent (`ADD COLUMN IF NOT EXISTS`).
- **DcbCommand** — typed command interface mirroring `DcbEvent` but without
  tags: `DcbCommand<Type, Data>`. Commands are plain type aliases and object
  literals, not classes.
- **Decider** — formalises the command-handling pattern: `handlers(cmd)`
  returns the `EventHandlerWithState` map, `decide(cmd, state)` produces
  events or throws. The `decider()` factory infers handler types; `handle()`
  orchestrates `buildDecisionModel` → `decide` → `append`.
- **Typed domain errors** — `DcbError` base class (extends `Error`, adds
  `code` and `status`). Subclasses: `NotFoundError` (404),
  `ValidationError` (400), `IllegalStateError` (422).
  `AppendConditionError` extends `DcbError` (status 409).
- **DeciderSpecification** — fluent given/when/then API for testing Deciders
  against a `MemoryEventStore`. Asserts emitted events (`.then`), errors
  (`.thenThrows`), empty results (`.thenNothingHappened`), and the append
  condition / consistency boundary (`.thenCondition`). Pure in-memory, no
  Postgres needed.

## Repo shape

- `packages/event-store` — `@dcb-es/event-store`: core types, `Query`, `Tags`,
  `buildDecisionModel`, in-memory store. Pure TypeScript, no Postgres.
- `packages/event-store-postgres` — `@dcb-es/event-store-postgres`: the store,
  lock strategy, COPY writer, handler runner.
- `packages/event-store-bench` — benchmark harness and scenarios.
- `packages/event-store-web`, `packages/event-store-express` (Phase 10) —
  framework-agnostic HTTP kit and the Express adapter. These never import
  store internals; they depend on the public `EventStore` interface only.
- `examples/*` — workspace packages; each is a variant of the previous one
  (see `PLAN.md` §0.6).
- pnpm workspaces (not Lerna/Yarn — older docs are wrong), vitest, ESLint +
  Prettier, testcontainers for Postgres. `pnpm test` runs all.

## Shared test infrastructure

- `test/vitest.globalSetup.ts` — starts and stops one testcontainers Postgres
  for the run and shares its URI via `process.env.__PG_CONNECTION_URI`.
- `test/testPgDbPool.ts` — creates an isolated database per test suite. Import
  it via the `@test` alias configured in each package's `vitest.config.ts`.
- New specs in `event-store-postgres` (and new packages that hit Postgres)
  must use this setup rather than starting their own container: copy the
  `globalSetup` and `@test` alias lines from
  `packages/event-store-postgres/vitest.config.ts`.
- Build before testing a package that depends on another
  (`pnpm -r run build`); vitest resolves workspace packages from `dist`.

## Invariants — do not break these

1. **Lock strategy is load-bearing.** `eventStore/lockStrategy.ts`,
   `eventStore/advisoryLocks.ts` and the `dcb_append` plpgsql function in
   `ensureInstalled.ts` implement DCB consistency via transaction-scoped
   advisory locks keyed on hashed `(type, tag)` pairs. Any change here must be
   accompanied by passing `advisoryLocks.tests.ts`,
   `concurrentCommitGap.tests.ts`, `PostgresEventStore.tests.ts` and a run of
   the `contention` and `overlap-consistency` bench scenarios with numbers
   recorded in the PR.
2. **The read barrier stays.** `read()` takes a brief shared barrier lock and
   snapshots `pg_sequence_last_value` as an upper bound. This is what makes plain
   `sequence_position` checkpoints safe. Never remove it, and never introduce
   the Emmett `(transaction_id, global_position)` composite checkpoint — DCB
   does not need it.
3. **Advisory lock key space.** New advisory locks (projection registry,
   processor instance locks) MUST use a distinct hash namespace prefix so they
   cannot collide with boundary lock keys. Document the namespace in
   `advisoryLocks.ts`.
4. **`payload` stays TEXT.** The COPY writer depends on it and the bench
   package was tuned for it. The Phase 1 columns (`message_id UUID`,
   `recorded_at TIMESTAMPTZ`, `schema_version TEXT`, `metadata JSONB`) sit
   alongside `payload`, never inside it. Any future columns follow the same
   rule. JSONB belongs in read models (Pongo), not on the event table.
5. **`message_id` uniqueness is load-bearing.** The `message_id_idx` unique
   index powers idempotent appends (`ON CONFLICT (message_id) DO NOTHING`).
   Do not remove, make nullable, or change to a non-unique index. The
   `dcb_append` function returns the existing `sequence_position` when all
   rows are duplicates, so callers see a valid position on replay.
6. **Anything that widens the append transaction extends lock hold time.**
   Inline projections and before-commit hooks run inside the same transaction
   as `dcb_append`; that directly trades against write concurrency. Benchmark
   `contention` with and without the feature enabled and record the delta.
7. **Poolers.** Advisory locks require session-mode connections. Do not add
   code paths that assume a transaction-mode pooler (PgBouncer, Supavisor,
   RDS Proxy) unless using `rowLocks()`.
8. **Do not touch `packages/event-store-bench` scenarios** except to add new
   ones. Existing scenarios are the regression baseline.

## Branching rules — mandatory

`main` is protected. Never commit to it, never push to it, never merge into
it locally. All work goes through a pull request.

- **Start every session by checking the branch.** Run `git branch --show-current`.
  If it prints `main`, create the phase branch before touching any file:
  `git checkout -b phase-N/<short-slug>` (e.g. `phase-1/event-identity`).
  If you are on a phase branch, continue there.
- **Branch from a fresh `main`.** `git fetch origin && git checkout -b <name>
  origin/main`. Rebase onto `origin/main` before opening the PR; never merge
  `main` into the branch.
- **One phase, one branch.** If a phase needs to be split, use
  `phase-N.M/<slug>` branches, each merged to `main` in order via its own PR.
  Do not stack unmerged branches on top of each other.
- **Spikes and experiments** go on `spike/<slug>` and are never merged; delete
  them when done. Copy anything worth keeping into a phase branch by hand.
- **Commit often, small, with tests.** Every commit must leave the package
  compiling. Prefix messages with the phase: `phase-1: add message_id column`.
- **Before opening a PR**, all of these must be true and stated in the PR
  description:
  1. `pnpm -r run build` clean
  2. `pnpm lint` clean
  3. `pnpm test` green (all packages, in Docker)
  4. Bench numbers recorded if the phase touches append/read/locks
  5. New `examples/<name>` package with tests green and `docs/examples.md` updated
  6. `PLAN.md` §12 status row updated on the branch
  7. A changeset added
- **Open the PR with `gh pr create`** targeting `main`, titled `Phase N: <name>`,
  body containing the checklist above with results. Do not merge it yourself;
  the human reviews and merges.
- **Never** `git push --force` to any branch you did not create in this
  session, and never to `main` under any circumstances.
- If tests fail and you cannot fix them in the session, leave the branch
  pushed with a `WIP:` prefixed final commit and say so; do not open a PR.

## How to work a phase

- Read the phase in `PLAN.md`, then the referenced Emmett files under
  `../emmett/src/packages/...` before designing anything. Emmett is a
  reference, not a source to copy: its semantics are stream-based; ours are
  tag/boundary-based. Translate, don't transplant.
- Spec first. Every feature lands with a vitest spec in the same package,
  written before the implementation, exercising the behaviour against a real
  Postgres container where the feature touches the database.
- One phase = one branch = one PR. Keep PRs reviewable; split a phase if it
  grows past ~600 lines of non-test diff.
- Keep the license header and `LICENSE.md` intact. Add a `NOTICE` entry for
  any code adapted from Emmett (MIT) with attribution.
- Every feature phase ships a **new example** under `examples/` that is a
  variant of the closest existing example, showing the feature from a user's
  perspective. See `PLAN.md` §0.6 for the naming, base example, and doc
  requirements. Examples are workspace packages, so their tests run in CI.
  Never modify an existing example to demonstrate a new feature; copy and
  extend, so earlier examples stay valid for earlier concepts.
- Do not change the public `EventStore` interface in
  `packages/event-store/src/eventStore/EventStore.ts` without a plan entry that
  says so.

## Commands

```
pnpm install
pnpm -r run build
pnpm test                                   # all packages (needs Docker)
pnpm --filter @dcb-es/event-store-postgres test
pnpm --filter @dcb-es/event-store-bench test
pnpm lint && pnpm lint-fix
```

Bench scenarios live in `packages/event-store-bench/src/scenarios`; see
`registry.ts` for how they are invoked.

## Definition of done for any phase

- Spec written first and passing.
- Existing test suite green.
- Relevant bench scenario run if the phase touches append, read, or locks;
  before/after numbers in the PR description.
- New example package under `examples/` with its own tests green, and a
  matching section in `docs/examples.md` (what it adds, how it differs).
- `PLAN.md` phase status updated.
- Changeset added (`pnpm changeset`).
