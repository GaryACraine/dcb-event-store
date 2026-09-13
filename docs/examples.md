# Examples

The repository includes CLI applications that implement the [course subscriptions](https://dcb.events/examples/course-subscriptions/) example from dcb.events. All manage the same domain -- courses, students, and subscriptions -- but differ in which features they demonstrate.

| Example | Reads from | Key concepts |
|---------|-----------|--------------|
| `course-manager-cli` | Event stream (on-the-fly) | Core DCB pattern, decision models, command handling |
| `course-manager-cli-with-decider-specs` | In-memory (no Postgres) | `Decider` type, `DcbCommand`, `DeciderSpecification`, typed domain errors |
| `course-manager-cli-with-idempotent-commands` | Event stream (on-the-fly) | Idempotent appends via `message_id`, metadata, `recordedAt` |
| `course-manager-cli-with-readmodel` | PostgreSQL read model | Projections, `runHandler`, `waitUntilProcessed` |
| `course-manager-cli-with-consumer` | PostgreSQL read model | `createConsumer`, processor lock, CAS checkpoints, `startFrom`, graceful `stop()` |
| `course-manager-cli-with-projections` | PostgreSQL read model | `Projection`, `rawSqlProjection`, `projectionToProcessor`, `ProjectionSpec` |
| `course-manager-cli-with-pongo` | Pongo JSONB documents | `pongoProjection`, Pongo collections, JSONB document read models |
| `course-manager-cli-with-inline-projection` | Pongo JSONB documents | `inlineProjections`, atomic read model updates, no consumer/waitUntilProcessed |

Most examples require a running PostgreSQL instance and use [`PostgresEventStore`](postgres/postgres-event-store.md) as the write-side store. The `course-manager-cli-with-decider-specs` example is the exception -- it runs entirely in-memory using `MemoryEventStore` and needs no Docker or Postgres.

---

## course-manager-cli

**Location:** [`examples/course-manager-cli/`](../examples/course-manager-cli/)

This example demonstrates the core DCB pattern with no read model. Every command derives its state on-the-fly from the event stream using `buildDecisionModel`, validates business rules against that state, and appends events with the returned append condition. There is no separate query side -- the event stream is the only source of truth for both reads and writes.

### Events

Six event types model the domain. Each implements [`DcbEvent`](core/event-store-interface.md#dcbevent) with a literal `type`, typed `data` payload, and [`Tags`](core/tags-and-queries.md#tags) referencing the domain concepts involved in the event.

| Event | Tags | Data |
|-------|------|------|
| `courseWasRegistered` | `courseId` | `courseId`, `title`, `capacity` |
| `courseCapacityWasChanged` | `courseId` | `courseId`, `newCapacity` |
| `courseTitleWasChanged` | `courseId` | `courseId`, `newTitle` |
| `studentWasRegistered` | `studentId`, `studentNumberIndex=global` | `studentId`, `name`, `studentNumber` |
| `studentWasSubscribed` | `studentId`, `courseId` | `courseId`, `studentId` |
| `studentWasUnsubscribed` | `studentId`, `courseId` | `courseId`, `studentId` |

Tag selection is deliberate. `studentWasSubscribed` carries both `courseId` and `studentId` because it participates in two distinct consistency boundaries: course capacity enforcement and per-student subscription limits. The `studentNumberIndex=global` tag on `studentWasRegistered` exists to give the `NextStudentNumber` decision model a tag to scope its query on -- without it, there would be no tag to lock against for globally-sequenced student numbers.

### Decision models

Each decision model is a factory function returning an [`EventHandlerWithState`](core/decision-models.md#eventhandlerwithstate). It declares which event types it handles, a `tagFilter` scoping it to a specific entity instance, an initial state, and reducer functions in `when` that fold events into accumulated state.

| Model | Scoped by | State | Description |
|-------|-----------|-------|-------------|
| `CourseExists` | `courseId` | `boolean` | Has the course been registered? |
| `CourseCapacity` | `courseId` | `{ subscriberCount, capacity }` | Tracks capacity and current subscriber count across four event types |
| `CourseTitle` | `courseId` | `string` | Current title (registration + changes) |
| `StudentAlreadyRegistered` | `studentId` | `boolean` | Has the student been registered? |
| `StudentAlreadySubscribed` | `courseId + studentId` | `boolean` | Is this student subscribed to this course? |
| `StudentSubscriptions` | `studentId` | `{ subscriptionCount }` | Total courses this student is subscribed to |
| `NextStudentNumber` | `studentNumberIndex=global` | `number` | Next sequential student number |

For the full implementation, see [`examples/course-manager-cli/src/api/DecisionModels.ts`](../examples/course-manager-cli/src/api/DecisionModels.ts). For how `EventHandlerWithState` works, see [Decision Models](core/decision-models.md).

### Command handling

Every command follows the same three-step pattern:

1. **Build decision model** -- call `buildDecisionModel` with the event store and a map of named decision models. This issues a single combined query against the event store, routes matching events to each handler, and returns the accumulated `state` and an `appendCondition`.

2. **Validate** -- check business rules against the derived state. If any rule is violated, throw an error.

3. **Append** -- persist the new event(s) with the `appendCondition`. The store atomically rejects the append if any events matching the combined query were added since the state was read.

The `subscribeStudentToCourse` command (see [`Api.ts`](../examples/course-manager-cli/src/api/Api.ts)) is the most illustrative because it composes four decision models spanning two entity instances (a course and a student) into a single dynamic consistency boundary. It calls `buildDecisionModel` with `CourseExists`, `CourseCapacity`, `StudentAlreadySubscribed`, and `StudentSubscriptions`, validates four business rules against the derived state, then appends with the returned `appendCondition`.

The four decision models produce a consistency boundary that covers:

- Events tagged with `courseId` (course existence, capacity, and subscription counts for that course)
- Events tagged with both `courseId` and `studentId` (whether this student is already subscribed to this course)
- Events tagged with `studentId` (total subscription count for the student across all courses)

If a concurrent process appends any event matching this combined query -- another student subscribing to the same course, or the same student subscribing to a different course -- the append fails and the caller retries from step 1. This is query-based optimistic locking in action: no aggregates, no sagas, and no eventual consistency compromise.

### CLI

The interactive CLI uses `inquirer` to present a menu of operations:

- Register course / Register student
- Update course capacity / Update course title
- Subscribe / Unsubscribe student from course
- Exit

Each menu action prompts for the relevant inputs (course ID, student ID, etc.) and calls the corresponding `Api` method. Errors from business rule violations are caught and displayed in the terminal.

---

## course-manager-cli-with-readmodel

**Location:** [`examples/course-manager-cli-with-readmodel/`](../examples/course-manager-cli-with-readmodel/)

This example extends the basic CLI with a PostgreSQL read model. The write side is identical -- the same events, decision models, and `buildDecisionModel` command handling pattern. The difference is on the read side: instead of deriving state from the event stream on every query, a background projection handler maintains denormalized tables that the CLI reads from directly.

### What it adds

- A **projection handler** (`PostgresCourseSubscriptionsProjection`) that reacts to events and writes to three PostgreSQL tables
- A **read model repository** (`PostgresCourseSubscriptionsRepository`) providing CRUD queries against those tables
- The **write-then-wait pattern** using `waitUntilProcessed` to guarantee read-your-writes consistency
- Background handler lifecycle management with `runHandler` and `AbortController`

### Entry point wiring

The [`index.ts`](../examples/course-manager-cli-with-readmodel/index.ts) entry point wires everything together. Three setup steps happen before the CLI starts:

1. `eventStore.ensureInstalled()` -- creates the events table (idempotent)
2. `ensureHandlersInstalled(pool, [PROJECTION_NAME], "_handler_bookmarks")` -- creates the bookmark table and registers the handler with a starting position of 0
3. `installPostgresCourseSubscriptionsRepository(pool)` -- creates the three read model tables (`courses`, `students`, `subscriptions`)

`runHandler` starts a subscribe-based loop in the background. It uses the event store's `subscribe()` method (backed by `pg_notify`) to receive events as they are appended, processes each one in its own transaction, and atomically advances the handler's bookmark. The `AbortController` provides clean shutdown -- aborting the signal causes the handler to finish its current event and resolve its promise.

### Projection handler

`PostgresCourseSubscriptionsProjection` is an [`EventHandler`](core/decision-models.md#eventhandler) that handles all six event types, translating each into a repository write (INSERT, UPDATE, or DELETE against the read model tables). The `handlerFactory` callback in `runHandler` receives a `PoolClient` already inside a transaction, so the projection writes and bookmark advance are atomic -- if either fails, neither commits.

See [`PostgresCourseSubscriptionsProjection.ts`](../examples/course-manager-cli-with-readmodel/src/api/PostgresCourseSubscriptionsProjection.ts) for the full implementation.

### Read model repository

The repository is a plain CRUD layer over three PostgreSQL tables:

| Table | Columns | Purpose |
|-------|---------|---------|
| `courses` | `id`, `title`, `capacity` | Course registrations and updates |
| `students` | `id`, `name`, `student_number` | Student registrations |
| `subscriptions` | `course_id`, `student_id` | Active course-student subscriptions |

The repository exposes two query methods used by the CLI:

- `findCourseById(courseId)` -- returns the course with its subscribed students (joined through `subscriptions`)
- `findStudentById(studentId)` -- returns the student with their subscribed courses

And write methods called by the projection handler: `registerCourse`, `registerStudent`, `updateCourseCapacity`, `updateCourseTitle`, `subscribeStudentToCourse`, `unsubscribeStudentFromCourse`.

This repository has nothing to do with event sourcing itself -- it is a conventional repository pattern with SQL queries, used here to demonstrate how a projection handler might persist denormalized state to a database.

### Write-then-wait pattern

The key difference from the basic example is what happens after `append`. In the basic example, the command is done after the append succeeds. In this example, every command captures the returned `SequencePosition` and calls `waitUntilProcessed` before returning. See [`Api.ts`](../examples/course-manager-cli-with-readmodel/src/api/Api.ts) for the implementation.

The flow is:

1. `append` returns the `SequencePosition` of the newly written event(s)
2. `waitUntilProcessed` polls the handler's bookmark row, then falls back to `LISTEN`/`NOTIFY` if needed, waiting until the bookmark reaches or passes that position
3. Only then does the command return, guaranteeing that subsequent reads from the read model will reflect the just-appended event

This gives the CLI read-your-writes consistency without coupling the write path to the projection. The projection runs independently in the background; `waitUntilProcessed` is just a synchronization point that blocks the caller until the projection has caught up to a known position. The default timeout is 5 seconds.

### How it differs from the basic example

The **write side is identical** -- same events, same decision models, same `buildDecisionModel` pattern. The differences are all on the read side:

| Aspect | Basic example | Read model example |
|--------|--------------|-------------------|
| Read path | Derives state from event stream on every command | Queries denormalized PostgreSQL tables |
| Query operations | Not available | `findCourseById`, `findStudentById` return rich objects with joins |
| Background work | None | `runHandler` runs a projection handler continuously |
| After append | Done | Waits for projection via `waitUntilProcessed` |
| CLI menu | Write operations only | Adds "Find course" and "Find student" |
| Lifecycle | Start store, run CLI | Start store, install handlers, install read model tables, start handler, run CLI, shut down handler |

The basic example is appropriate when all interactions are commands that need only the state derivable from decision models. The read model example is appropriate when you need rich query capabilities -- listing, searching, joining -- that would be expensive or awkward to derive from the event stream on every request.

---

## course-manager-cli-with-idempotent-commands

**Location:** [`examples/course-manager-cli-with-idempotent-commands/`](../examples/course-manager-cli-with-idempotent-commands/)

This example extends the basic CLI with client-supplied idempotency keys. The write side is the same domain -- courses, students, and subscriptions -- but every command accepts an optional `idempotencyKey` parameter that is passed through as the event's `id` (the `message_id` column in Postgres). Resending a command with the same key is a no-op at the store level: the event is not duplicated, and the original position is returned.

### What it adds

- An **`idempotencyKey` parameter** on every command in `Api.ts`
- Event classes gain a public `id?: string` field, set from the idempotency key
- Tests demonstrating: same key twice = one event stored, metadata round-trip, `recordedAt` on read

### Entry point wiring

Identical to the basic example. The idempotency feature requires no additional setup -- it is built into `PostgresEventStore.append()` via the `message_id` unique index.

### How idempotency works

When `idempotencyKey` is provided, the `Api` sets `event.id = idempotencyKey` before calling `eventStore.append()`. The store passes this as the `message_id` to Postgres, which uses `INSERT ... ON CONFLICT (message_id) DO NOTHING`. If the event already exists, the store returns the existing event's position without inserting a duplicate.

Note that idempotency operates at the **store level**, not the application level. On retry, `buildDecisionModel` still runs and may throw a domain error (e.g., "Course already exists") because it sees the event from the first attempt. This is the correct behavior: the command already succeeded, and the domain state reflects it.

### How it differs from the basic example

| Aspect | Basic example | Idempotent commands example |
|--------|--------------|----------------------------|
| Command parameters | Domain fields only | Domain fields + optional `idempotencyKey` |
| Event classes | No `id` field | Public `id?: string` field |
| Store-level retry safety | Not handled | Duplicate `message_id` returns existing position |
| `recordedAt` on read | Not available | Available as `Date` on every `SequencedEvent` |
| Metadata queryability | Stored in payload TEXT | Also stored in JSONB `metadata` column, queryable with `->>`|

---

## course-manager-cli-with-decider-specs

**Location:** [`examples/course-manager-cli-with-decider-specs/`](../examples/course-manager-cli-with-decider-specs/)

This example refactors the basic CLI to use the `Decider` pattern with typed commands (`DcbCommand`) and replaces the ad-hoc tests with `DeciderSpecification` -- a fluent given/when/then API that exercises each decider against a `MemoryEventStore`, asserting both the emitted events and the consistency boundary. Tests run entirely in-memory; no PostgreSQL or Docker required.

### What it adds

- **Typed commands** (`Commands.ts`) -- six `DcbCommand` type aliases replacing untyped parameter bags
- **Decider objects** (`Deciders.ts`) -- the six command handlers expressed as `Decider` values using the `decider()` factory, with the existing `DecisionModels.ts` handler factories
- **Typed domain errors** -- `IllegalStateError`, `NotFoundError`, and `ValidationError` replace bare `new Error(...)` in decide functions
- **`DeciderSpecification` tests** (`Api.tests.ts`) -- given/when/then tests for every command, including error state assertions and `.thenCondition()` boundary assertions
- **`handle()` orchestration** -- `Api.ts` uses `handle(store, decider, command)` instead of inline `buildDecisionModel` + validate + append

### Typed commands

Each command is a plain type alias using `DcbCommand<Type, Data>`, mirroring how events use `DcbEvent`:

```typescript
type RegisterCourse = DcbCommand<"registerCourse", { id: string; title: string; capacity: number }>
type SubscribeStudentToCourse = DcbCommand<"subscribeStudentToCourse", { courseId: string; studentId: string }>
```

Commands are constructed as object literals -- no classes, no `new` keyword:

```typescript
const cmd: RegisterCourse = { type: "registerCourse", data: { id: "c1", title: "Math", capacity: 30 } }
```

### Decider pattern

Each decider is a pure value object with two functions:

- `handlers(cmd)` -- returns the `EventHandlerWithState` map parameterised by command fields (e.g., `CourseExists(cmd.data.id)`)
- `decide(cmd, state)` -- validates business rules against the folded state and returns event(s) or throws a typed error

The `handle()` function orchestrates: build handlers, run `buildDecisionModel` to fold events into state, call `decide`, and append with the returned `appendCondition`.

### DeciderSpecification tests

Tests use the fluent given/when/then API:

```typescript
// Happy path: assert emitted events
await DeciderSpecification.for(registerCourse)
    .given()
    .when({ type: "registerCourse", data: { id: "c1", title: "Math", capacity: 30 } })
    .then(new CourseWasRegisteredEvent({ courseId: "c1", title: "Math", capacity: 30 }))

// Error path: assert specific error type and message
await DeciderSpecification.for(registerCourse)
    .given(new CourseWasRegisteredEvent({ courseId: "c1", title: "Math", capacity: 30 }))
    .when({ type: "registerCourse", data: { id: "c1", title: "Math", capacity: 30 } })
    .thenThrows(IllegalStateError, (e) => e.message.includes("already exists"))

// Boundary assertion (DCB-specific): verify the append condition covers expected tags
await DeciderSpecification.for(subscribeStudentToCourse)
    .given(new CourseWasRegisteredEvent({ courseId: "c1", title: "Math", capacity: 30 }))
    .when({ type: "subscribeStudentToCourse", data: { courseId: "c1", studentId: "s1" } })
    .thenCondition((condition) => {
        const allTagValues = condition.failIfEventsMatch.items.flatMap((item) => item.tags?.values ?? [])
        expect(allTagValues).toContain("courseId=c1")
        expect(allTagValues).toContain("studentId=s1")
    })
```

Event comparison ignores store-generated fields (`id`, `recordedAt`, `schemaVersion`) and normalises `Tags` instances to their string arrays.

### How it differs from the basic example

| Aspect | Basic example | Decider specs example |
|--------|--------------|----------------------|
| Command types | Untyped parameter bags (`{ id, title, capacity }`) | `DcbCommand<Type, Data>` type aliases |
| Command handling | Inline `buildDecisionModel` + validate + append | `Decider` object + `handle()` |
| Error types | Bare `new Error(message)` | `IllegalStateError`, `NotFoundError`, `ValidationError` |
| Tests | Integration tests against PostgresEventStore (Docker required) | `DeciderSpecification` against `MemoryEventStore` (no Docker) |
| Test assertions | `expect(...).rejects.toThrow()` | `.then(events)`, `.thenThrows(ErrorType)`, `.thenCondition()` |
| Boundary testing | Not tested directly | `.thenCondition()` asserts the `AppendCondition` |
| Events, DecisionModels, Cli | Unchanged | Unchanged |

---

## course-manager-cli-with-consumer

**Location:** [`examples/course-manager-cli-with-consumer/`](../examples/course-manager-cli-with-consumer/)

This example extends the read model example by replacing `runHandler` with `createConsumer` -- the production-grade consumer API introduced in Phase 3. The domain, events, decision models, projection handler, and read model repository are all unchanged. The differences are in how the projection lifecycle is managed.

### What it adds

- **`createConsumer`** replaces `runHandler` for starting the projection handler. The consumer wraps one or more named processors with shared lifecycle management.
- **Processor instance lock** -- each processor acquires a session-scoped advisory lock (`P:` namespace), preventing two instances of the same processor from running concurrently. A second instance's promise rejects with "Processor lock not acquired".
- **CAS-versioned checkpoints** -- the bookmark table gains `version`, `instance_id`, and `last_updated` columns. Checkpoint updates use `WHERE version = $expected` (compare-and-swap) as defense-in-depth against double-processing if a lock is lost.
- **Start-position policies** -- `startFrom: "BEGINNING"` (default) resumes from the stored checkpoint. `startFrom: "CURRENT"` skips all historical events for a brand-new handler, useful for projections that only care about future events.
- **Graceful `stop()`** -- `consumer.stop()` aborts all processors via their shared `AbortController` and resolves when all are done, replacing manual `AbortController` + `await promise.catch(() => {})`.
- **`stopAfter`** -- optional event count limit for testing and one-shot processing.

### Entry point wiring

The [`index.ts`](../examples/course-manager-cli-with-consumer/index.ts) entry point creates a consumer with a single processor configuration:

```typescript
const consumer = createConsumer({
    pool,
    eventStore,
    processors: [
        {
            processorName: PROJECTION_NAME,
            handlerFactory: client => PostgresCourseSubscriptionsProjection(client),
            batchSize: 100,
            startFrom: "BEGINNING"
        }
    ]
})
```

Shutdown is a single call: `await consumer.stop()`.

### How it differs from the read model example

| Aspect | Read model example | Consumer example |
|--------|-------------------|-----------------|
| Handler start | `runHandler()` + manual `AbortController` | `createConsumer()` with named processors |
| Instance exclusivity | None -- two handlers race | Session-scoped advisory lock per processor |
| Checkpoint mechanism | Simple `UPDATE SET position` | CAS with `WHERE version = $expected` |
| Bookmark columns | `handler_id`, `last_sequence_position` | Adds `version`, `instance_id`, `last_updated` |
| Start position | Always from stored bookmark | Configurable: `BEGINNING` or `CURRENT` |
| Shutdown | `controller.abort()` + `await promise.catch(() => {})` | `await consumer.stop()` |
| Stop condition | Signal abort only | Signal abort + `stopAfter` event count |
| Events, DecisionModels, Projection, Repository, Cli | Unchanged | Unchanged |

---

## course-manager-cli-with-projections

**Location:** [`examples/course-manager-cli-with-projections/`](../examples/course-manager-cli-with-projections/)

This example extends the consumer example by replacing the ad-hoc `EventHandler` factory with the `Projection` abstraction. The domain, events, decision models, and read model repository are all unchanged. The differences are in how the projection handler is defined and wired to the consumer.

### What it adds

- **`rawSqlProjection`** replaces the hand-written `EventHandler` factory. The projection declares its name, the events it handles via a `canHandle` Query, an `init` function for DDL, an `evolve` function for per-event SQL, and an optional `truncate` function for cleanup.
- **`projectionToProcessor`** bridges the `Projection` to a `ConsumerProcessorConfig`, so it can be passed directly to `createConsumer`. The adapter extracts the query from `canHandle` and passes it to the processor, avoiding lossy round-tripping through `when` keys.
- **`ProjectionSpec`** tests the projection in isolation against a real Postgres database with automatic rollback. The given/when/then API fabricates `SequencedEvent` objects from `DcbEvent` inputs, calls `init` and `handle`, then runs user assertions inside a transaction that is rolled back after the assertion completes.
- **`canHandle` is a full `Query`**, not just an event-type list. This is the DCB-native improvement over Emmett's projections: tag filters in the query are passed through to the event store subscription, so the processor only receives events matching the full query (types + optional tags).

### Entry point wiring

The [`index.ts`](../examples/course-manager-cli-with-projections/index.ts) entry point uses `projectionToProcessor` to convert the projection into a consumer processor configuration:

```typescript
import { createConsumer, projectionToProcessor, ensureHandlersInstalled } from "@dcb-es/event-store-postgres"
import { courseSubscriptionsProjection } from "./src/api/PostgresCourseSubscriptionsProjection.js"

// Init read model tables
const initClient = await pool.connect()
await courseSubscriptionsProjection.init!(initClient)
initClient.release()

const consumer = createConsumer({
    pool,
    eventStore,
    processors: [
        projectionToProcessor(courseSubscriptionsProjection, {
            batchSize: 100,
            startFrom: "BEGINNING"
        })
    ]
})
```

### Projection definition

The projection is defined using `rawSqlProjection`, which wraps a per-event `evolve` function into the batch-capable `Projection.handle` interface:

```typescript
import { rawSqlProjection } from "@dcb-es/event-store-postgres"
import { Query } from "@dcb-es/event-store"

export const courseSubscriptionsProjection = rawSqlProjection({
    name: "CourseProjection",
    canHandle: Query.fromItems([{
        types: [
            "courseWasRegistered", "courseTitleWasChanged", "courseCapacityWasChanged",
            "studentWasRegistered", "studentWasSubscribed", "studentWasUnsubscribed"
        ]
    }]),
    init: async (client) => { /* CREATE TABLE IF NOT EXISTS ... */ },
    evolve: async (event, client) => { /* switch on event.event.type */ },
    truncate: async (client) => { /* TRUNCATE ... */ }
})
```

### ProjectionSpec tests

The example includes `ProjectionSpec` tests that verify the projection logic in isolation, with automatic rollback:

```typescript
await ProjectionSpec.for({ projection: courseSubscriptionsProjection, pool })
    .given([new CourseWasRegisteredEvent({ courseId: "c1", title: "Math", capacity: 30 })])
    .when([new StudentWasSubscribedEvent({ courseId: "c1", studentId: "s1" })])
    .then(async (client) => {
        const result = await client.query("SELECT * FROM subscriptions WHERE course_id = 'c1'")
        expect(result.rows).toHaveLength(1)
    })
```

### How it differs from the consumer example

| Aspect | Consumer example | Projections example |
|--------|-----------------|-------------------|
| Projection definition | `EventHandler` factory function | `rawSqlProjection()` with `canHandle` Query |
| Consumer wiring | Manual `{ processorName, handlerFactory }` | `projectionToProcessor(projection)` |
| Event subscription query | Introspected from `when` keys + `tagFilter` | Passed directly from `canHandle` Query |
| DDL management | Separate `installPostgresCourseSubscriptionsRepository` function | `projection.init()` on the projection itself |
| Cleanup | Manual `TRUNCATE` in test teardown | `projection.truncate()` method |
| Isolated projection tests | Not available | `ProjectionSpec` with rollback isolation |
| Events, DecisionModels, Repository, Api, Cli | Unchanged | Unchanged |

---

## course-manager-cli-with-pongo

**Location:** [`examples/course-manager-cli-with-pongo/`](../examples/course-manager-cli-with-pongo/)

This example extends the projections example by replacing the three relational tables (`courses`, `students`, `subscriptions`) with two Pongo JSONB document collections. Each document embeds its related entities directly -- courses contain their subscribed students, and students contain their subscribed courses. The write side is unchanged.

### What it adds

- **`pongoProjection`** replaces `rawSqlProjection`. The projection handler receives a `PongoProjectionContext` with a `pongo` client that shares the processor's `PoolClient` transaction, so projection writes and bookmark advances commit atomically.
- **Pongo JSONB collections** replace relational tables. Two collections (`courses`, `students`) store rich documents with embedded related entities instead of three normalised tables with JOIN queries.
- **`PongoCourseSubscriptionsRepository`** replaces the SQL-based repository. Read queries select from the Pongo `data` JSONB column and map the embedded document structure to the same `Course` and `Student` interfaces.
- **Transaction-scoped Pongo client** -- the `pongoProjection` factory creates a Pongo client backed by the processor's existing `PoolClient` via dumbo's `pgAmbientPoolClientPool`. This means Pongo operations participate in the same transaction as the event store checkpoint advance.

### Entry point wiring

The [`index.ts`](../examples/course-manager-cli-with-pongo/index.ts) entry point is nearly identical to the projections example. The only difference is the projection import:

```typescript
import { pongoProjection } from "@dcb-es/event-store-postgres"
```

The `projectionToProcessor` adapter works unchanged with `pongoProjection` -- it implements the same `Projection` interface.

### Document model

Instead of three normalised tables, the read model uses two Pongo JSONB collections:

| Collection | Document shape | Purpose |
|------------|---------------|---------|
| `courses` | `{ courseId, title, capacity, subscribedStudents: [{ studentId, name, studentNumber }] }` | Course with embedded subscribers |
| `students` | `{ studentId, name, studentNumber, subscribedCourses: [{ courseId, title, capacity }] }` | Student with embedded courses |

Pongo manages these as PostgreSQL tables with a `_id TEXT PRIMARY KEY` and `data JSONB NOT NULL` column. The repository reads the `data` column directly via SQL.

### Projection definition

The projection is defined using `pongoProjection`, which provides a `PongoProjectionContext` with the transaction-scoped Pongo client:

```typescript
import { pongoProjection, PongoProjectionContext } from "@dcb-es/event-store-postgres"

export const courseSubscriptionsProjection = pongoProjection({
    name: "CourseProjection",
    canHandle: Query.fromItems([{ types: [...] }]),
    init: async (pongo) => {
        await pongo.db().collection("courses").createCollection()
        await pongo.db().collection("students").createCollection()
    },
    handle: async (events, context: PongoProjectionContext) => {
        const courses = context.pongo.db().collection("courses")
        // Use Pongo's MongoDB-like API: insertOne, updateOne, findOne, $set, $push
    }
})
```

### How it differs from the projections example

| Aspect | Projections example | Pongo example |
|--------|-------------------|--------------|
| Projection factory | `rawSqlProjection()` | `pongoProjection()` |
| Handler context | `ProjectionContext` with `client: PoolClient` | `PongoProjectionContext` with `pongo: PongoClient` |
| Read model storage | Three relational tables with SQL DDL | Two Pongo JSONB document collections |
| Write operations | Raw SQL (`INSERT`, `UPDATE`, `DELETE`) | Pongo API (`insertOne`, `updateOne`, `$set`, `$push`) |
| Read operations | SQL JOINs across three tables | Single JSONB document read per query |
| Repository | `PostgresCourseSubscriptionsRepository` with SQL queries | `PongoCourseSubscriptionsRepository` reading `data` JSONB column |
| Schema setup | `CREATE TABLE IF NOT EXISTS` in `init` | `collection.createCollection()` in `init` |
| Test assertions | Query relational columns | Query Pongo `data` JSONB column |
| Dependencies | `pg` only | `@event-driven-io/pongo`, `@event-driven-io/dumbo`, `pg` |
| Events, DecisionModels, Api, Cli | Unchanged | Unchanged |

---

## course-manager-cli-with-inline-projection

**Location:** [`examples/course-manager-cli-with-inline-projection/`](../examples/course-manager-cli-with-inline-projection/)

This example extends the Pongo example by running the projection **inline** -- inside the `append` transaction itself -- instead of asynchronously in a separate consumer process. The read model is consistent the instant `append` returns; there is no `waitUntilProcessed`, no consumer lifecycle, and no bookmark table.

### What it adds

- **`inlineProjections`** option on `PostgresEventStore` -- the same `Projection` object that previously ran in a consumer is passed directly to the store constructor. When events are appended, the store runs the projection inside the append transaction before committing.
- **No consumer, no bookmarks** -- `createConsumer`, `projectionToProcessor`, `ensureHandlersInstalled`, and `waitUntilProcessed` are all removed. The `Api` class no longer captures the returned `SequencePosition` or waits for anything after `append`.
- **Atomic consistency** -- events and read model writes commit in the same transaction. If the projection throws, the events are rolled back too. If the database crashes between `append` and the projection, neither is persisted.

### Trade-off

Advisory locks acquired by `dcb_append` are held for the duration of the inline projection code. This directly reduces write concurrency on overlapping consistency boundaries (Invariant 6 in `CLAUDE.md`). The default autocommit path (no inline projections configured) is completely unchanged, so existing users see no performance regression.

### Entry point wiring

The [`index.ts`](../examples/course-manager-cli-with-inline-projection/index.ts) entry point is simpler than the Pongo example -- no consumer setup or shutdown:

```typescript
import { PostgresEventStore } from "@dcb-es/event-store-postgres"
import { courseSubscriptionsProjection } from "./src/api/PostgresCourseSubscriptionsProjection.js"

const eventStore = new PostgresEventStore({
    pool,
    inlineProjections: [courseSubscriptionsProjection]
})
await eventStore.ensureInstalled()

// Init Pongo collection tables eagerly
const initClient = await pool.connect()
await courseSubscriptionsProjection.init!(initClient)
initClient.release()

const api = new Api(pool, eventStore)
await startCli(api)
await pool.end()
```

### How it differs from the Pongo example

| Aspect | Pongo example | Inline projection example |
|--------|--------------|--------------------------|
| Projection execution | Asynchronous via `createConsumer` | Inline in `append` transaction |
| Read-your-writes | `waitUntilProcessed` after every `append` | Immediate -- `append` returns with read model updated |
| Consumer lifecycle | `createConsumer` start + `consumer.stop()` shutdown | None |
| Bookmark table | `_handler_bookmarks` with CAS versioning | Not needed |
| `ensureHandlersInstalled` | Required | Not needed |
| Api imports | `waitUntilProcessed`, `PROJECTION_NAME` | Neither -- no wait, no projection name |
| Failure behaviour | Projection lag visible to queries; projection retries autonomously | Projection failure rolls back the append; caller sees the error |
| Write concurrency | Locks released at append commit | Locks held through projection code (Invariant 6) |
| Projection, Repository, Events, DecisionModels, Cli | Unchanged | Unchanged |
