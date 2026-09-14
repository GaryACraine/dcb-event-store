# course-manager-postgres-web-api

End-to-end example of the DCB Event Store: commands over HTTP, Postgres projections, and
two read-your-writes patterns.

## What this example demonstrates

- **Commands over HTTP** — write routes append events via Deciders; each response carries the
  appended sequence position as an ETag header
- **Postgres-backed read models** — Pongo JSONB projections rebuilt from the event log asynchronously
- **Read-your-writes — polling** — `Prefer: wait=<seconds>` + `If-None-Match: "<position>"` blocks
  the read until the projection has processed that position
- **Read-your-writes — push** — `GET /events` streams events as Server-Sent Events; a browser or
  long-lived client receives confirmation the moment a write lands, with no polling needed
- **Consistency enforcement** — duplicates, over-capacity subscriptions, and missing resources are
  rejected with RFC 9457 problem details

## Architecture

```
HTTP client
    │
    ├─ POST /courses          ─► Decider ─► EventStore (Postgres)   writes events
    ├─ POST /students                            │                   returns ETag: "<position>"
    ├─ PUT  /courses/:id/capacity                │
    ├─ POST /courses/:id/subscriptions           │
    └─ DELETE /courses/:id/subscriptions/:sid    │
                                                 ▼
                                         Consumer (async)
                                         CourseSubscriptionsProjection
                                         (Pongo JSONB → courses / students tables)
                                                 │
    ├─ GET /courses           ◄──────────────────┤  reads Pongo read model
    ├─ GET /courses/:id       ◄──────────────────┤  + ETag on response
    └─ GET /students/:id      ◄──────────────────┘  + ETag on response

    └─ GET /events            ─► SSE stream (EventStore.subscribe)
```

## Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| Node.js | ≥ 20 | `node --version` to check |
| pnpm | ≥ 9 | `pnpm --version`; install with `npm i -g pnpm` |
| Docker Desktop | any recent | Required for Postgres (both automated tests and manual run) |

## Running the automated scenario (recommended starting point)

The scenario test spins up a real Postgres container automatically via testcontainers — no
manual Docker steps needed.

```bash
# From the repo root
pnpm install
pnpm -r run build
pnpm --filter @dcb-es/examples-course-manager-postgres-web-api test --reporter=verbose
```

Look for `Scenario: course enrollment lifecycle` in the output. Each of the 16 steps logs its
request, response status, ETag, and payload so you can follow the complete data flow, including
both read-your-writes patterns and the two-page keyset pagination demo (steps 15–16).

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
# From the repo root
pnpm install
pnpm -r run build

# From this directory
PG_CONNECTION_STRING="postgresql://dcb:dcb@localhost:5432/dcb" \
PORT=3000 \
pnpm --filter @dcb-es/examples-course-manager-postgres-web-api start
```

The server logs the port on startup:

```
course-manager-postgres-web-api listening on http://localhost:3000
  GET  http://localhost:3000/health/live
  GET  http://localhost:3000/courses
  GET  http://localhost:3000/events   (SSE)
```

### 3. Verify health

```bash
curl http://localhost:3000/health/live
# → {"status":"ok"}
```

## API walkthrough with curl

### Write-side — commands with ETag responses

```bash
# Register a course (capacity 2)
curl -s -D - -X POST http://localhost:3000/courses \
  -H "Content-Type: application/json" \
  -d '{"id":"ts101","title":"Introduction to TypeScript","capacity":2}'
# HTTP/1.1 201 Created
# ETag: "1"
# {"id":"ts101"}

# Register students
curl -s -D - -X POST http://localhost:3000/students \
  -H "Content-Type: application/json" \
  -d '{"id":"alice","name":"Alice"}'
# ETag: "2"

curl -s -D - -X POST http://localhost:3000/students \
  -H "Content-Type: application/json" \
  -d '{"id":"bob","name":"Bob"}'
# ETag: "3"
```

### Pattern A — read-your-writes via Prefer: wait

The ETag from the write tells you which position to wait for. Pass it as `If-None-Match` on the
next read, along with `Prefer: wait=<seconds>`. The server blocks until the projection has
processed that position, then responds with fresh data.

```bash
# Subscribe Alice — returns ETag of the subscription event
curl -s -D - -X POST http://localhost:3000/courses/ts101/subscriptions \
  -H "Content-Type: application/json" \
  -d '{"studentId":"alice"}'
# ETag: "4"

# Read the course — guaranteed to see Alice in the subscriber list
curl -s -D - http://localhost:3000/courses/ts101 \
  -H "Prefer: wait=5" \
  -H 'If-None-Match: "4"'
# HTTP/1.1 200 OK
# ETag: "4"
# Preference-Applied: wait
# {"id":"ts101","title":"Introduction to TypeScript","capacity":2,
#  "subscribedStudents":[{"studentId":"alice","name":"Alice","studentNumber":1}]}
```

If the projection hasn't caught up within the timeout, the server responds `504 Gateway Timeout`.

The `ETag` on the read response carries the projection's bookmark position — the same currency as
the write-side ETag. Clients can store it and use it as the next `If-None-Match` to gate a
subsequent read on freshness.

### Pagination

`GET /courses` supports keyset pagination via `?limit=N` and `?cursor=<id>`. The response is
always wrapped in `{ data, cursor? }`:

```bash
# First page — up to 2 results, sorted by course ID
curl -s http://localhost:3000/courses?limit=2
# HTTP/1.1 200 OK
# ETag: "8"
# {"data":[{"id":"extra101",...},{"id":"go101",...}],"cursor":"go101"}

# Second (last) page — no cursor means end of results
curl -s "http://localhost:3000/courses?cursor=go101&limit=2"
# HTTP/1.1 200 OK
# ETag: "8"
# {"data":[{"id":"ts101",...}]}
```

The `cursor` value is the last `_id` of the current page. When absent the client has reached the
final page. Combine `?limit=` with `Prefer: wait` and `If-None-Match` for read-your-writes
pagination: the server blocks until the projection is fresh before returning each page.

### Pattern B — read-your-writes via SSE push

Open a persistent SSE stream in one terminal. Any event appended on the write side is pushed to
all connected clients immediately — no polling loop needed.

```bash
# Terminal 1 — open the event stream
curl -N http://localhost:3000/events
```

```bash
# Terminal 2 — append an event
curl -s -X POST http://localhost:3000/courses \
  -H "Content-Type: application/json" \
  -d '{"id":"go101","title":"Introduction to Go","capacity":20}'
```

Terminal 1 receives the event within milliseconds:

```
id: 5
data: {"event":{"type":"courseWasRegistered","data":{"courseId":"go101","title":"Introduction to Go","capacity":20},...},"position":"5"}
```

Reconnect after a disconnect by replaying missed events:

```bash
curl -N http://localhost:3000/events \
  -H 'Last-Event-ID: 5'
```

### Consistency enforcement

```bash
# Subscribe Bob (fills the course at capacity 2)
curl -s -X POST http://localhost:3000/courses/ts101/subscriptions \
  -H "Content-Type: application/json" \
  -d '{"studentId":"bob"}'

# Try to subscribe Charlie — rejected because the course is full
curl -s http://localhost:3000/courses/ts101/subscriptions \
  -H "Content-Type: application/json" \
  -d '{"studentId":"charlie"}'
# HTTP/1.1 422 Unprocessable Entity
# Content-Type: application/problem+json
# {"status":422,"title":"Unprocessable Entity","detail":"Course ts101 is full."}
```

### Unsubscribe and re-subscribe

```bash
# Remove Alice — a spot opens up
curl -s -D - -X DELETE http://localhost:3000/courses/ts101/subscriptions/alice
# HTTP/1.1 204 No Content
# ETag: "7"

# Charlie can now subscribe
curl -s -D - -X POST http://localhost:3000/courses/ts101/subscriptions \
  -H "Content-Type: application/json" \
  -d '{"studentId":"charlie"}'
# ETag: "8"

# Confirm Charlie's course list is updated (wait for projection)
curl -s http://localhost:3000/students/charlie \
  -H "Prefer: wait=5" \
  -H 'If-None-Match: "8"'
# {"id":"charlie","subscribedCourses":[{"courseId":"ts101","title":"Introduction to TypeScript",...}]}
```

### Stopping the server

```bash
# Stop the server (Ctrl-C or SIGTERM)
# Then clean up the Postgres container
docker stop dcb-pg
```

## API endpoints

| Method | Path                                        | Response                           |
|--------|---------------------------------------------|------------------------------------|
| POST   | /courses                                    | 201 `{ id }` + `ETag: "<pos>"`    |
| POST   | /students                                   | 201 `{ id }` + `ETag: "<pos>"`    |
| PUT    | /courses/:courseId/capacity                 | 204 + `ETag: "<pos>"`             |
| POST   | /courses/:courseId/subscriptions            | 201 + `ETag: "<pos>"`             |
| DELETE | /courses/:courseId/subscriptions/:studentId | 204 + `ETag: "<pos>"`             |
| GET    | /courses                                    | 200 `{ data, cursor? }` + `ETag: "<pos>"` (`?limit=N&cursor=<id>`) |
| GET    | /courses/:courseId                          | 200 doc + `ETag: "<pos>"`         |
| GET    | /students/:studentId                        | 200 doc + `ETag: "<pos>"`         |
| GET    | /events                                     | text/event-stream                 |
| GET    | /health/live                                | 200 `{"status":"ok"}`             |

## How it differs from course-manager-web-api

| Aspect              | course-manager-web-api       | course-manager-postgres-web-api       |
|---------------------|------------------------------|---------------------------------------|
| Persistence         | In-memory (MemoryEventStore) | PostgreSQL                            |
| Read models         | None                         | Pongo JSONB projections               |
| Write responses     | `{ id }` only                | `{ id }` + `ETag: "<position>"`       |
| Read-your-writes    | N/A                          | Prefer: wait (polling) + SSE (push)   |
| SSE event feed      | No                           | Yes (`GET /events`)                   |
| Runnable server     | No                           | Yes (`pnpm start`)                    |
| Docker required     | No                           | Yes (Postgres)                        |
