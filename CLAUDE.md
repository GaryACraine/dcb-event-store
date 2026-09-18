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
- **Event type architecture** (Phase 13) — events use a three-layer type
  system that cleanly separates domain facts from infrastructure concerns:
  - **`Event<Type, Data, MetaData>`** — pure domain payload. Contains only
    `type` (literal string), `data` (the business fact), and optionally
    `metadata`. Domain events are defined as type aliases:
    `type CourseWasRegistered = Event<"courseWasRegistered", { courseId: string; title: string }>`.
    No tags, no position, no identity — those are infrastructure.
  - **`TaggedEvent<E>`** — write envelope: `{ event: E, tags, id?, schemaVersion? }`.
    Wraps an `Event` with the tags needed for DCB consistency boundaries and
    optional caller-supplied identity for idempotent appends. This is what
    `append()` accepts.
  - **`SequencedEvent<E>`** — read envelope: `{ event: E, tags, position, id, recordedAt, schemaVersion? }`.
    What `read()` and `subscribe()` yield. Adds the server-assigned sequence
    position, recorded timestamp, and guaranteed identity.
  Events are defined as type aliases with companion factory functions (not
  classes): `export const courseWasRegistered = (data): TaggedEvent<CourseWasRegistered> => ({ event: { type: "courseWasRegistered", data }, tags: Tags.fromObj({ courseId: data.courseId }) })`.
  Utility types `EventTypeOf<E>`, `EventDataOf<E>`, `EventMetaDataOf<E>`
  extract parts of an event type for compile-time inference. `AnyEvent`
  (`Event<any, any, any>`) is the escape hatch for generic/test code.
  *Benefits:*
  (a) Domain events are free of infrastructure — `Events.ts` files contain
  pure type aliases describing business facts; tags and identity are added
  at the boundary by the factory function.
  (b) Type-safe discrimination — literal `type` strings enable TypeScript's
  discriminated union narrowing in `EventHandlerWithState.when` handlers.
  (c) Clean metadata handling — `Event<Type, Data>` has `metadata?: undefined`
  (cannot accidentally pass metadata); `Event<Type, Data, Meta>` requires it.
  The conditional type enforces this at compile time.
  (d) Symmetry with commands — `Event<Type, Data, MetaData>` mirrors
  `Command<Type, Data, MetaData>` from Phase 12, creating a consistent pair
  of domain message types with identical structure and utility types.
  (e) No class overhead — factory functions eliminate `new`, prototype chains,
  and `implements` boilerplate. More composable, more tree-shakeable.
  (f) Three layers enforce the right access pattern — decision model handlers
  destructure `{ event }` from `SequencedEvent` to access `event.data`,
  keeping the domain logic unaware of position or identity. Tags live on the
  envelope where they belong (on the write and read wrappers, not on the
  domain fact itself).
- **Event identity** (`message_id`) — every stored event carries a UUID
  `message_id` (auto-generated or caller-supplied via `TaggedEvent.id`). A
  unique index enforces deduplication: appending events with a previously-seen
  `message_id` is a silent no-op (`ON CONFLICT DO NOTHING`), making retries
  safe. `SequencedEvent` exposes `id` and `recordedAt` on the read side.
- **Event metadata columns** — the event table has four columns added in
  Phase 1 alongside `payload`: `message_id UUID`, `recorded_at TIMESTAMPTZ`,
  `schema_version TEXT` (default `'1'`), `metadata JSONB` (default `{}`).
  Schema migration is idempotent (`ADD COLUMN IF NOT EXISTS`).
- **Command type** — `Command<Type, Data, MetaData>` mirrors the `Event`
  type structure. Commands are plain type aliases and object literals, not
  classes.
  *Note:* As of Phase 12, we adopted Emmett's object outlining for commands (`Command` type structure from `../emmett/src/packages/emmett/src/typing/command.ts`).
  *Benefits:* Provides standardization, improved type-safe inference via utility types (`CommandTypeOf`, `CommandDataOf`, `CommandMetaDataOf`), and a factory builder (`command()`) for streamlined instantiation.
  *Impact:* Minimal to zero refactoring required downstream because existing object literal assignments remain fully supported, ensuring complete backwards compatibility with existing example slices and test specifications.
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
- **Processor** (`createProcessor`) — production event handler with
  session-scoped instance lock, CAS-versioned checkpoints, and
  start-position policies (`BEGINNING`, `CURRENT`). `runHandler` is a thin
  backward-compatible wrapper. The processor lock uses the `P:` advisory
  lock namespace (distinct from boundary locks per invariant 3).
- **Consumer** (`createConsumer`) — wraps one or more processors with shared
  lifecycle. `stop()` aborts all processors and resolves when all are done.
- **Projection** — formalises read model handlers: `name`, `canHandle: string[]`
  (a plain list of event type names this projection processes),
  `handle(events, context)` where `context.client` is the transaction's
  `PoolClient`, `init` for DDL, `truncate` for cleanup, and `version` for the
  registry. Tag-based filtering is an append-condition concern handled at the
  boundary level, not a projection concern.
- **`rawSqlProjection()`** — factory that wraps a per-event `evolve(event,
  client)` function into the batch-capable `Projection.handle` interface.
  Keeps user code simple (handle one event at a time) while the `Projection`
  interface supports batch processing for future inline projections.
- **`projectionToProcessor()`** — adapter bridging `Projection` →
  `ConsumerProcessorConfig` for use with `createConsumer`. Constructs
  `Query.fromItems([{ types: projection.canHandle }])` for the processor's
  `query` option, so the store subscription receives only the relevant event
  types.
- **ProjectionSpec** — fluent given/when/then API for testing projections
  against real Postgres with automatic rollback isolation. Fabricates
  `SequencedEvent` objects from `TaggedEvent` inputs, calls `init` and `handle`,
  runs user assertions, then rolls back the transaction so tests are isolated
  without table truncation.
- **`pongoProjection()`** — factory for Pongo JSONB read models. The handler
  receives a `PongoProjectionContext` with a `pongo: PongoClient` that shares
  the processor's `PoolClient` transaction via dumbo's
  `pgAmbientPoolClientPool`, so projection writes and bookmark advances commit
  atomically. `init` and `truncate` also receive a transaction-scoped Pongo
  client. Requires optional peer deps `@event-driven-io/pongo` and
  `@event-driven-io/dumbo`.
- **`pongoDocumentProjection()`** — convenience factory for the common
  one-document-per-entity pattern. Groups events by a caller-supplied
  `getDocumentId`, loads the existing document, folds events through `evolve`,
  and upserts (or deletes if `evolve` returns `null`). Built on top of
  `pongoProjection()`.
- **Inline projections** (`inlineProjections` option) — projections that run
  inside the `append` transaction itself, before COMMIT. The read model is
  consistent the instant `append` returns; no `waitUntilProcessed`, no
  consumer, no bookmark table. Trade-off: advisory locks are held for the
  duration of the projection code, reducing write concurrency on overlapping
  boundaries (Invariant 6). When no inline projections are configured, the
  default autocommit path is preserved with zero overhead. Inline projections
  use client-side pre-generated `message_id` UUIDs to read back appended
  events within the transaction (querying by `message_id = ANY($ids)` rather
  than a position range). This eliminates a race condition where concurrent
  non-overlapping writers under READ COMMITTED isolation could commit events
  into the position range between the HWM snapshot and the INSERT, causing
  projections to process foreign events. The COPY writer (`copyWriter.ts`)
  already uses the same client-side UUID pattern.
- **`onBeforeCommit` hook** — optional callback that runs inside the append
  transaction after inline projections but before COMMIT. Receives the newly
  appended `SequencedEvent[]` and the transaction `PoolClient`. A throw rolls
  back both events and projection writes.
- **Projection Registry** (`_projections` table) — tracks every projection
  by `(name, version)` with columns `type` (`'a'` async, `'i'` inline),
  `kind` (factory origin: `'raw-sql'`, `'pongo'`, `'pongo-document'`),
  `status` (`'active'` / `'inactive'`), and `definition` (serialised
  `canHandle` event type list). Factories auto-register during `init()`;
  `PostgresEventStore.ensureInstalled()` re-registers inline projections
  with `type = 'i'`.
- **Projection Lock** (`R:` namespace) — xact-scoped advisory locks
  coordinating handlers with rebuilders. Handlers take shared locks
  (`tryAcquireSharedProjectionLock`) before processing; rebuilders take
  exclusive locks (`acquireExclusiveProjectionLock`) to block all handlers.
  The `R:` namespace is distinct from `L:`, `T:`, `G`, and `P:` per
  invariant 3.
- **`rebuildProjection()`** — truncate-and-replay orchestration.
  Deactivates the projection (exclusive lock + status `'inactive'` +
  truncate + bookmark reset), replays all events with a `stopWhenCaughtUp`
  consumer, then reactivates (exclusive lock + status `'active'`). Both
  inline and async handlers skip the projection while it is inactive.
- **ProblemDetails** — RFC 9457 `application/problem+json` response format.
  `toProblemDetails()` maps any error (DcbError subclasses, plain Errors,
  non-Error values) to a typed `ProblemDetails` object with `status`, `title`,
  `detail`, `type`, and `instance`. User code can supply a custom
  `ErrorToProblemDetailsMapping` that takes precedence over the default.
- **Web-specific errors** — `StaleETagError` (412, `STALE_ETAG`) and
  `MissingETagError` (428, `MISSING_ETAG`) extend `DcbError`. Defined in
  `event-store-web`; the ETag middleware that throws them ships in Phase 10.2.
- **`on()` handler wrapper** — wraps an `HttpHandler` (sync or async function
  returning an `HttpResponse` callback) into Express middleware with
  try/catch → `next(error)` for Express 4 compatibility. Defined in
  `event-store-express`.
- **Response helpers** — `OK()`, `Created()`, `Accepted()`, `NoContent()`
  return `HttpResponse` callbacks that set status, Location header, and JSON
  body. `send()` and `sendProblem()` are lower-level utilities. Defined in
  `event-store-express`.
- **Application factory** — `getApplication(options)` creates an Express app
  with JSON parsing, URL encoding, trace-ID middleware, health endpoints
  (`/health/live`, `/health/ready`), user API routes, and problem details
  error handling. `startAPI(app)` creates an HTTP server with SIGTERM/SIGINT
  graceful shutdown. Defined in `event-store-express`.
- **Trace-ID middleware** — reads `x-request-id` from the incoming request;
  if present, echoes it on the response; if absent, generates a UUID v4
  via `crypto.randomUUID()`. Always on by default, opt-out via
  `disableTraceIdMiddleware`. Defined in `event-store-express`.
- **`ApiSpecification`** — fluent given/when/then DSL for testing Express API
  routes against a `MemoryEventStore`. `ApiSpecification.for({ configureApi })`
  → `.existingEvents(...events)` → `.when(request)` → `.then(responseAssert,
  ...expectedEvents)`. Each chain creates a fresh store and app for isolation.
  New events are detected by recording the store position after seeding and
  reading all events after that position post-request. Helpers:
  `expectResponse(status, { body?, headers? })`, `expectError(status,
  problem?)`. Also exposes `thenEvents()` (events-only) and
  `thenNothingAppended()`. Defined in `event-store-express`.
- **`ApiE2ESpecification`** — same factory pattern but builds state through
  prior HTTP requests rather than event seeding. `.existingRequests(...requests)`
  runs setup requests before the `.when()` request. Response-only assertions (no
  event spy). Defined in `event-store-express`.
- **SSE event feed** (`sseEventFeed`) — Express middleware that streams events
  from `eventStore.subscribe()` as `text/event-stream`. Supports `Last-Event-ID`
  reconnection, `?after=` cursor, `?types=` and `?tags=` filters, and periodic
  heartbeat comments (`: heartbeat`). Uses `AbortController` tied to
  `req.on('close')` so subscriptions are always cleaned up on client disconnect.
  Defined in `event-store-express`.
- **Query helpers** (`withETag`, `parsePageParams`) — `withETag(position)` sets
  `ETag: "<position>"` on the response for cache-friendly reads.
  `parsePageParams(req)` reads `?after=` and `?limit=` (default 50, max 200) for
  cursor-based pagination. Both defined in `event-store-express`.
- **`Prefer: wait` middleware** (`preferWait`) — reads `Prefer: wait=<seconds>`
  and `If-None-Match: "<position>"` headers; calls an injected `waitFn` before
  passing to the next handler; sets `Preference-Applied: wait` on success;
  returns 504 problem details on timeout. Framework-agnostic: the example wires
  `waitUntilProcessed` from `event-store-postgres` as the `waitFn`, achieving
  read-your-writes semantics over HTTP without polling.

- **Vertical slice architecture** (Phase 11) — the recommended structure for
  web API examples. Code is organised as `contexts/<name>/slices/<slice>/`,
  where each slice directory contains its command type, decision models,
  decider, Zod schema, route, and tests. Write slices produce events; read
  slices project them; infrastructure slices (SSE feed, OpenAPI) stand alone.
  The composition root (`index.ts`) is the only file that knows all slices.
  Context-level `Events.ts` files define the domain events shared across
  slices. Global tag key constants live in `shared/Tags.ts`.
- **Independent projections** — each projection must own all data it needs
  to build its read model. Projections must never cross-read another
  projection's collections (no temporal coupling, no ordering dependency
  between projections). When a projection needs denormalised data from
  another aggregate's events, it subscribes to those events in its own
  `canHandle` query and maintains a private lookup collection (prefixed
  `_<projection>_<entity>`, e.g. `_course_projection_students`). The
  private lookup is populated by handling the relevant events (e.g.
  `studentWasRegistered`) and is truncated alongside the primary collection
  in `truncate`. This ensures projections can be independently deployed,
  rebuilt, or removed without breaking others.

## Repo shape

- `packages/event-store` — `@dcb-es/event-store`: core types, `Query`, `Tags`,
  `buildDecisionModel`, in-memory store. Pure TypeScript, no Postgres.
- `packages/event-store-postgres` — `@dcb-es/event-store-postgres`: the store,
  lock strategy, COPY writer, handler runner.
- `packages/event-store-bench` — benchmark harness and scenarios.
- `packages/event-store-web` — `@dcb-es/event-store-web`: framework-agnostic
  HTTP utilities. RFC 9457 problem details mapping, web-specific error classes.
  Depends only on `@dcb-es/event-store` for error classes.
- `packages/event-store-express` — `@dcb-es/event-store-express`: Express
  adapter. `on()` handler wrapper, response helpers, application factory with
  lifecycle, trace-ID and problem details middleware. Express is a peer dependency.
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
