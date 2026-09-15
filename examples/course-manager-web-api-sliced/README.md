# course-manager-web-api-sliced

The course manager HTTP API restructured as a **vertical slice architecture**. Same domain, same
runtime behaviour, same endpoints as `course-manager-postgres-web-api` — but the code is organised
by feature slice rather than by technical layer, and the projections are fully independent of each
other.

## What this example demonstrates

- **Vertical slice structure** — one directory per slice; each slice owns its command type,
  decision models, decider, Zod schema, route, and tests. No cross-slice imports except through
  the composition root.
- **Bounded contexts** — domain events are grouped at the context level
  (`contexts/enrollment/Events.ts`), not scattered across slices. The context boundary is explicit
  in the directory hierarchy.
- **Global tag constants** — tag key strings (`courseId`, `studentId`) are defined once in
  `shared/Tags.ts` and imported everywhere. A typo becomes a compile error rather than a silent
  query miss.
- **Independent projections** — each Pongo projection owns all the data it needs. No projection
  reads from a collection managed by another projection. Each can be deployed, rebuilt, or removed
  without affecting the other.
- **Private lookup collections** — when a projection needs denormalised data from another
  aggregate's events, it subscribes to those events and maintains its own private lookup table
  (`_course_projection_students`, `_student_projection_courses`).
- All runtime features from the base example: ETag read-your-writes, idempotent commands,
  `Prefer: wait`, keyset pagination, SSE event feed, Zod validation, OpenAPI 3.1 document.

## Architecture

### Slice structure

```
src/
├── contexts/
│   └── enrollment/
│       ├── Events.ts                      ← all domain events for this context
│       └── slices/
│           ├── register-course/           ← write slice
│           │   ├── command.ts             ← DcbCommand type alias
│           │   ├── decider.ts             ← decider (handlers + decide)
│           │   ├── decisionModels.ts      ← EventHandlerWithState factories
│           │   ├── schema.ts              ← Zod schema + OpenAPI metadata
│           │   ├── route.ts               ← Express route
│           │   └── route.tests.ts         ← ApiSpecification + E2E tests
│           ├── register-student/          ← write slice
│           ├── subscribe-student/         ← write slice
│           ├── unsubscribe-student/       ← write slice
│           ├── change-course-capacity/    ← write slice
│           ├── course-details/            ← read slice
│           │   ├── projection.ts          ← pongoProjection (owns _course_projection_students)
│           │   ├── route.ts
│           │   └── route.tests.ts         ← standalone — no dependency on student projection
│           ├── student-details/           ← read slice
│           │   ├── projection.ts          ← pongoProjection (owns _student_projection_courses)
│           │   ├── route.ts
│           │   └── route.tests.ts         ← standalone — no dependency on course projection
│           ├── course-list/               ← read slice (shares course projection)
│           ├── event-feed/                ← infrastructure slice (SSE)
│           └── openapi/                   ← infrastructure slice
├── shared/
│   ├── Tags.ts                            ← TAG_COURSE_ID, TAG_STUDENT_ID constants
│   ├── dependencies.ts                    ← SliceDependencies interface
│   └── idempotency.ts                     ← shared idempotency-key lookup helper
├── index.ts                               ← composition root (the only file that sees all slices)
└── scenario.tests.ts                      ← full lifecycle E2E test
```

### Independent projections

In the base `course-manager-postgres-web-api` example, the two projections cross-read each
other's collections: the course projection looked up `students` to get student names, and the
student projection looked up `courses` to get course titles. This created temporal coupling — the
course projection would silently produce incomplete data if it processed `studentWasSubscribed`
before the student projection had processed `studentWasRegistered`.

Here each projection is causally self-contained:

```
CourseDetailsProjection
  canHandle: courseWasRegistered, courseTitleWasChanged, courseCapacityWasChanged,
             studentWasRegistered,                        ← subscribed for its own lookup
             studentWasSubscribed, studentWasUnsubscribed
  writes to: courses                                      ← primary collection
             _course_projection_students                  ← private lookup; never read externally

StudentDetailsProjection
  canHandle: studentWasRegistered,
             courseWasRegistered, courseTitleWasChanged, courseCapacityWasChanged,
             ← subscribed for its own lookup
             studentWasSubscribed, studentWasUnsubscribed
  writes to: students                                     ← primary collection
             _student_projection_courses                  ← private lookup; never read externally
```

Consequences:
- Rebuilding one projection never corrupts the other's data.
- Each projection's test file only starts its own consumer — no `waitUntilProcessed` on the
  other projection.
- Either projection can be removed from the consumer without breaking the other.

### Request flow

```
HTTP client
    │
    ├─ POST /courses           ─► Decider ─► EventStore (Postgres)   writes events
    ├─ POST /students                            │                    returns ETag: "<position>"
    ├─ PUT  /courses/:id/capacity                │
    ├─ POST /courses/:id/subscriptions           │
    └─ DELETE /courses/:id/subscriptions/:sid    │
                                                 │
                            ┌────────────────────┤
                            │                    │
                     CourseDetails          StudentDetails
                     Projection (async)     Projection (async)
                     ┌ courses              ┌ students
                     └ _course_proj_studs   └ _student_proj_courses
                            │                    │
    ├─ GET /courses     ◄───┘                    │   reads own collection + ETag
    ├─ GET /courses/:id ◄───┘                    │
    └─ GET /students/:id ◄───────────────────────┘

    └─ GET /events      ─► SSE stream (EventStore.subscribe)
```

## Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| Node.js | ≥ 20 | `node --version` to check |
| pnpm | ≥ 9 | `pnpm --version`; install with `npm i -g pnpm` |
| Docker Desktop | any recent | Required for Postgres (both automated tests and manual run) |

## Running the tests

```bash
# From the repo root
pnpm install
pnpm -r run build
pnpm --filter @dcb-es/examples-course-manager-web-api-sliced test --reporter=verbose
```

Nine test files run: one per write slice (using `ApiSpecification` + `ApiE2ESpecification` against
`MemoryEventStore`, no Postgres), one per read slice (Postgres integration via testcontainers),
and a full lifecycle scenario test.

## Running the server manually

### 1. Start Postgres

```bash
docker run --rm -d \
  --name dcb-pg \
  -e POSTGRES_USER=dcb \
  -e POSTGRES_PASSWORD=dcb \
  -e POSTGRES_DB=dcb \
  -p 5432:5432 \
  postgres:16
```

### 2. Build and start the server

```bash
pnpm install
pnpm -r run build

PG_CONNECTION_STRING="postgresql://dcb:dcb@localhost:5432/dcb" \
PORT=3000 \
pnpm --filter @dcb-es/examples-course-manager-web-api-sliced start
```

### 3. Verify health

```bash
curl http://localhost:3000/health/live
# → {"status":"ok"}
```

## API walkthrough

### Register a course and students

```bash
curl -s -D - -X POST http://localhost:3000/courses \
  -H "Content-Type: application/json" \
  -d '{"id":"ts101","title":"Introduction to TypeScript","capacity":2}'
# HTTP/1.1 201 Created
# ETag: "1"

curl -s -D - -X POST http://localhost:3000/students \
  -H "Content-Type: application/json" \
  -d '{"id":"alice","name":"Alice"}'
# ETag: "2"
```

### Read-your-writes via Prefer: wait

```bash
curl -s -D - -X POST http://localhost:3000/courses/ts101/subscriptions \
  -H "Content-Type: application/json" \
  -d '{"studentId":"alice"}'
# ETag: "3"

# Block until the course projection has processed position 3
curl -s -D - http://localhost:3000/courses/ts101 \
  -H "Prefer: wait=5" \
  -H 'If-None-Match: "3"'
# HTTP/1.1 200 OK
# Preference-Applied: wait
# {"id":"ts101","title":"Introduction to TypeScript","capacity":2,
#  "subscribedStudents":[{"studentId":"alice","name":"Alice","studentNumber":1}]}
```

Note: the student name and number in the course document come from the course projection's own
`_course_projection_students` lookup — not from the students collection.

### SSE event feed

```bash
# Terminal 1
curl -N http://localhost:3000/events

# Terminal 2
curl -s -X POST http://localhost:3000/courses \
  -H "Content-Type: application/json" \
  -d '{"id":"go101","title":"Introduction to Go","capacity":20}'
# Terminal 1 receives the event immediately
```

### Idempotent commands

```bash
KEY=$(uuidgen | tr '[:upper:]' '[:lower:]')

curl -s -D - -X POST http://localhost:3000/courses \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $KEY" \
  -d '{"id":"ts101","title":"Introduction to TypeScript","capacity":2}'
# ETag: "1"

# Retry — same ETag, no duplicate event
curl -s -D - -X POST http://localhost:3000/courses \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $KEY" \
  -d '{"id":"ts101","title":"Introduction to TypeScript","capacity":2}'
# ETag: "1"
```

## How it differs from `course-manager-postgres-web-api`

| Aspect | `course-manager-postgres-web-api` | `course-manager-web-api-sliced` |
|--------|-----------------------------------|----------------------------------|
| Directory structure | Flat `src/api/` directory | `contexts/<name>/slices/<slice>/` hierarchy |
| Bounded contexts | Implicit | Explicit — `contexts/enrollment/Events.ts` |
| Tag key strings | Magic strings scattered across files | Constants in `shared/Tags.ts` |
| Slice encapsulation | All slices share `Deciders.ts`, `DecisionModels.ts`, `routes.ts` | Each slice owns its own command, decider, schema, route, and tests |
| Projection coupling | Course projection reads `students` collection; student projection reads `courses` collection | No cross-collection reads; each projection owns private lookup collections |
| Temporal coupling in tests | Course-details test must `waitUntilProcessed` on the *student* projection before subscribing | Each test file starts only its own projection consumer |
| Projection rebuild safety | Rebuilding one projection truncates data the other reads | Truncate is scoped to owned collections; rebuild of one cannot affect the other |
| Composition root | One `routes.ts` with all handlers | `index.ts` is the only file that imports from all slices |
| Runtime behaviour | Identical | Identical |
| API endpoints | Identical | Identical |
