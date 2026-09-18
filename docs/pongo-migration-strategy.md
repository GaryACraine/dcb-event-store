# Pongo projection migration strategy

## Context

When a projection needs to handle new event types (e.g. a new domain event is introduced
and the read model must subscribe to it), the projection's `canHandle` list grows and its
document/table shape may change. The question is: **do we need a formal migration
mechanism, and if so, what should it look like?**

---

## Finding 1 — Emmett has no migration framework for projections

Emmett's internal schema tool (`dumbo`) handles only the **event store's own tables**
(the events table, streams table, subscriptions). It does **not** manage projection
schemas.

For Pongo projections, Emmett relies on Pongo's schemaless JSONB nature: collections are
auto-created (`createCollection()`), and documents are stored as JSONB blobs in a table
with columns `(_id, data, metadata, _version, _partition, _archived, _created, _updated)`.
There is no per-field DDL — the "schema" lives in the TypeScript type and in the
projection's `evolve`/`handle` code.

For raw SQL projections, Emmett expects the projection's `init()` callback to run its own
DDL (`CREATE TABLE IF NOT EXISTS ...`). There is no versioned migration runner.

**Conclusion:** Emmett does not ship projection migrations. Each projection owns its own
schema via `init()`, and evolution is handled by version-bump + rebuild.

---

## Finding 2 — The build-kit SKILL.md uses Flyway + raw SQL projections

The Eventmodelers build kit takes a different path:
- Uses `rawSqlProjection` (not Pongo) with Knex as a **SQL builder only** (no connection).
- Stores migrations as `supabase/migrations/V{N}__{tablename}.sql` (Flyway naming).
- Tests run `runFlywayMigrations(connectionString)` to ensure test schema matches prod.
- Every column in the migration derives from the board's `slice.json`.

This is a schema-first, relational approach. It gives you `ALTER TABLE ADD COLUMN`,
indexes, constraints, and full SQL query flexibility. The trade-off is that every schema
change requires a new migration file and a deployment step.

---

## Finding 3 — Pongo projections are effectively schemaless

In our codebase (e.g. `PostgresCourseSubscriptionsProjection.ts`), the Pongo projection:
- Calls `createCollection()` in `init` — this creates the JSONB table if it doesn't exist.
- Stores whole documents via `insertOne`, `updateOne` with `$set`/`$push` operators.
- The "schema" is the TypeScript interface (`CourseDoc`, `StudentDoc`).
- Adding a new field to a document requires **no DDL** — you just start writing it.
  Old documents that lack the field still load fine (JSONB is sparse).

**When a new event type is added to `canHandle`:**
1. Update the `canHandle` array.
2. Add a new `case` in the `handle` switch.
3. If the new event adds a new field to the document, old documents won't have it.
   The handler code must tolerate this (default values, optional fields).
4. Bump the projection `version` and run `rebuildProjection()` to replay all events,
   which populates the new field on all documents.

No migration file is needed. The rebuild *is* the migration.

---

## Finding 4 — Raw SQL projections require explicit migrations

With `rawSqlProjection`, the read model is a regular Postgres table with typed columns.
Adding a new event that introduces a new column requires:
1. An `ALTER TABLE ADD COLUMN` migration (or a full `DROP + CREATE` via rebuild).
2. Updating `init()` to include the new column in the `CREATE TABLE IF NOT EXISTS`.
3. Adding the new event handler in `evolve`.
4. Rebuilding to backfill.

If you use `rebuildProjection()` (which calls `truncate` then replays), the `init()`
re-creates the table with the new column, so you can avoid incremental `ALTER TABLE` —
but only if you can tolerate the downtime of a full rebuild. For large datasets or
zero-downtime requirements, you need incremental migrations.

---

## Trade-off comparison: Pongo vs raw SQL projections

| Concern | Pongo (JSONB docs) | Raw SQL (relational tables) |
|---------|--------------------|-----------------------------|
| **Schema change for new event** | No DDL needed; just write the new field. Old docs tolerate missing fields. Rebuild backfills. | Requires `ALTER TABLE` or rebuild with new `CREATE TABLE`. |
| **Migration files** | None required. | Required for incremental changes; avoidable if rebuild-only. |
| **Query flexibility** | MongoDB-style operators (`$set`, `$push`, `$elemMatch`). Limited — no JOINs, no complex aggregations. | Full SQL: JOINs, GROUP BY, window functions, indexes on specific columns. |
| **Query performance** | JSONB GIN indexes. Good for document lookups by `_id`. Slower for cross-field filtering without custom indexes. | Standard B-tree indexes on typed columns. Predictable, optimisable. |
| **Read model complexity** | Best for single-entity lookups (get course by ID, list all courses). | Better for cross-entity queries, reporting, filtered listings with pagination. |
| **Tooling ecosystem** | Pongo API (subset of MongoDB). Limited community. | Standard Postgres. Massive ecosystem (pgAdmin, EXPLAIN, etc). |
| **Testing** | `ProjectionSpec` with real Postgres; rollback isolation. | Same `ProjectionSpec`; can also assert with raw SQL queries. |
| **Rebuild cost** | Truncate collection + replay. Fast (bulk JSONB inserts). | Truncate table + replay. May be slower if projection does complex SQL per event. |
| **Vendor neutrality** | Postgres-only (Pongo is a Postgres library). | Postgres-only (both use `pg` pool). Migrations are plain SQL, portable. |
| **Maintenance burden** | Low — no migration files, no DDL drift. TypeScript interface is the schema. Risk: silent shape drift if handler code diverges from interface. | Higher — migration files accumulate. Benefit: explicit, auditable schema history. |
| **Zero-downtime evolution** | Trivial — old and new documents coexist in the same JSONB column. No DDL lock. | Requires careful `ALTER TABLE ... ADD COLUMN` (nullable or with default) to avoid table locks on large tables. |

---

## Recommendation

### For this project's current stage: stay with Pongo projections

The dcb-event-store examples are demonstrating DCB patterns, not running production
workloads with millions of rows. Pongo projections are the right fit because:

1. **No migration infrastructure to build or maintain.** Schema evolution is handled by
   the projection code itself + rebuild. This is the event-sourcing sweet spot: the event
   log is the source of truth, and projections are disposable/rebuildable.

2. **The rebuild mechanism already exists.** `rebuildProjection()` with version-bump
   handles the "new event type added" scenario cleanly — deactivate, truncate, replay,
   reactivate.

3. **Adding Flyway/Knex/dbmate would be over-engineering.** It introduces a deployment
   dependency, a migration directory, ordering constraints, and a migration-tracking table
   — all to manage tables that can be rebuilt from events in seconds.

### When to switch to raw SQL projections

Consider raw SQL when:
- The read model needs **relational queries** (JOINs, aggregations, filtered pagination
  across entities).
- The dataset is large enough that **full rebuilds are impractical** and incremental
  `ALTER TABLE` is needed.
- The team needs **auditable, versioned schema history** for compliance.
- The read model serves an **API with complex query parameters** that map naturally to
  SQL WHERE clauses rather than JSONB operators.

### If/when you need a migration runner

If raw SQL projections become necessary and rebuilds are too slow, the vendor-neutral
options ranked by simplicity:

1. **`dbmate`** — single binary, plain SQL files, version-tracked in a `schema_migrations`
   table. No JVM. Works with any Postgres. MIT licensed.
   `dbmate up` / `dbmate new add_enrollment_count_to_courses`.

2. **`node-pg-migrate`** — Node.js native, plain SQL or JS migrations. No JVM. Fits the
   TypeScript toolchain. `npx node-pg-migrate create add-enrollment-count`.

3. **Flyway** — battle-tested, JVM-based. Overkill for a Node.js project but universally
   understood. The build-kit SKILL.md uses this path.

4. **Projection-owned `init()` with `CREATE TABLE IF NOT EXISTS` + `rebuildProjection()`**
   — the zero-dependency option. No migration runner at all. The projection defines its
   full DDL in `init()`; any schema change bumps the version and triggers a rebuild. This
   is what Emmett does internally. Only works when rebuilds are fast enough.

---

## Summary

**Do you need migrations for Pongo projections?** No. Pongo is schemaless — the JSONB
column accepts any document shape. Schema evolution is handled by updating the handler
code and rebuilding. The existing `rebuildProjection()` + `version` mechanism is the
migration strategy.

**Should you abandon Pongo for raw SQL?** Not yet. The current examples don't have query
requirements that demand relational tables. When they do, raw SQL projections with
`init()`-owned DDL + rebuild is the first step. A formal migration runner (dbmate or
node-pg-migrate) is the second step, only needed when rebuilds become too expensive.

---

## Appendix: Step-by-step Pongo projection evolution with version + rebuild

This walkthrough uses a concrete example: adding a `courseWasArchived` event to a
projection that currently handles 6 event types, showing exactly what exists in Postgres
at each stage.

### Stage 1 — Original projection (version 1, or unversioned)

**Projection code** defines:
```typescript
pongoProjection({
    name: "CourseProjection",
    // version: 1  (defaults to 1 if omitted)
    canHandle: [
        "courseWasRegistered",
        "courseTitleWasChanged",
        "courseCapacityWasChanged",
        "studentWasRegistered",
        "studentWasSubscribed",
        "studentWasUnsubscribed"
    ],
    init: async pongo => {
        await pongo.db().collection<CourseDoc>("courses").createCollection()
        await pongo.db().collection<StudentDoc>("students").createCollection()
    },
    handle: async (events, context) => { /* 6 cases */ },
    truncate: async pongo => {
        await pongo.db().collection<CourseDoc>("courses").deleteMany()
        await pongo.db().collection<StudentDoc>("students").deleteMany()
    }
})
```

**What exists in Postgres** (query with `\dt` or `SELECT tablename FROM pg_tables`):

| Table | Purpose |
|-------|---------|
| `courses` | Pongo collection — columns: `_id TEXT PK`, `data JSONB`, `metadata JSONB`, `_version BIGINT`, `_partition TEXT`, `_archived BOOLEAN`, `_created TIMESTAMPTZ`, `_updated TIMESTAMPTZ` |
| `students` | Same Pongo schema |
| `_handler_bookmarks` | Stores `(handler_name, last_sequence_position)` — the consumer's checkpoint |
| `_projections` | Registry row: `name='CourseProjection', version=1, type='a' (or 'i'), kind='pongo', status='active', definition='{"types":["courseWasRegistered",...]}'` |

**Sample document in `courses.data`:**
```json
{
  "_id": "course-1",
  "courseId": "course-1",
  "title": "Event Modeling 101",
  "capacity": 30,
  "subscribedStudents": [
    { "studentId": "s-1", "name": "Alice", "studentNumber": 1 }
  ]
}
```

No `archived` field yet. JSONB doesn't require one.

---

### Stage 2 — Add the new event to the projection (version 2)

**Code changes:**

1. Update the `CourseDoc` interface to include the new field:
   ```typescript
   export interface CourseDoc {
       // ... existing fields ...
       archived?: boolean  // optional — old docs won't have it
   }
   ```

2. Bump the version and add the new event:
   ```typescript
   pongoProjection({
       name: "CourseProjection",
       version: 2,  // bumped from 1
       canHandle: [
           "courseWasRegistered",
           "courseTitleWasChanged",
           "courseCapacityWasChanged",
           "studentWasRegistered",
           "studentWasSubscribed",
           "studentWasUnsubscribed",
           "courseWasArchived"          // new
       ],
       // ...
       handle: async (events, context) => {
           // ... existing 6 cases ...
           case "courseWasArchived":
               await courses.updateOne(
                   { _id: data.courseId as string },
                   { $set: { archived: true } }
               )
               break
       },
   })
   ```

3. Deploy the new code. On startup, `ensureInstalled()` / consumer setup calls `init()`:
   - `createCollection()` is idempotent — `courses` and `students` tables already exist,
     no-op.
   - `registerProjection()` inserts a **new row** in `_projections` for version 2.

**What exists in Postgres immediately after deploy (before rebuild):**

`_projections` table:
| name | version | status | definition |
|------|---------|--------|------------|
| CourseProjection | 1 | active | `{"types":["courseWasRegistered",...]}` (6 types) |
| CourseProjection | 2 | active | `{"types":["courseWasRegistered",...,"courseWasArchived"]}` (7 types) |

The `courses` and `students` **tables are shared** — both versions read/write the same
collections. Documents written before the deploy do not have `archived`; that is fine
because JSONB is sparse.

**Problem:** Documents for courses archived before the deploy position won't have
`archived: true` because v1 never handled that event. This is why we rebuild.

---

### Stage 3 — Rebuild the projection

Run `rebuildProjection()` targeting version 2. The sequence is:

1. **Deactivate:** Acquire exclusive lock `R:CourseProjection:2`. Set status to `inactive`.
   Handlers that try to take the shared lock will see inactive and skip.

2. **Truncate:** Call `truncate()` — deletes all documents from `courses` and `students`.
   ```sql
   -- What Pongo does internally:
   DELETE FROM courses;
   DELETE FROM students;
   ```

3. **Reset bookmark:** Set `last_sequence_position = 0` for v2's bookmark.

4. **Re-init:** Call `init()` — `createCollection()` is a no-op (tables still exist).

5. **Replay:** Start a `stopWhenCaughtUp` consumer that reads ALL events matching the
   7 event types from position 0. Each event is processed through `handle()`, including
   the new `courseWasArchived` events. All documents are rebuilt with the `archived` field
   populated where applicable.

6. **Reactivate:** Acquire exclusive lock, set status back to `active`.

**What exists in Postgres after rebuild:**

`courses.data` for an archived course now contains:
```json
{
  "_id": "course-1",
  "courseId": "course-1",
  "title": "Event Modeling 101",
  "capacity": 30,
  "subscribedStudents": [...],
  "archived": true
}
```

---

### Stage 4 — Clean up the old version

The v1 registration and its bookmark are stale. To tidy up:

```sql
-- Remove the old projection registration
DELETE FROM _projections
WHERE name = 'CourseProjection' AND version = 1;

-- Remove the old bookmark
DELETE FROM _handler_bookmarks
WHERE handler_name = 'CourseProjection';
```

**Final Postgres state:**

`_projections`:
| name | version | status | kind | definition |
|------|---------|--------|------|------------|
| CourseProjection | 2 | active | pongo | `{"types":[...7 types...]}` |

`_handler_bookmarks`:
| handler_name | last_sequence_position |
|-------------|----------------------|
| CourseProjection_v2 | 200 |

`courses` and `students` tables: unchanged structure (same JSONB columns), all
documents now contain the `archived` field where applicable.

---

### Diagnostic queries at any stage

```sql
-- 1. What projections are registered?
SELECT name, version, status, kind, type, definition
FROM _projections
ORDER BY name, version;

-- 2. Where is each handler's bookmark?
SELECT handler_name, last_sequence_position, updated_at
FROM _handler_bookmarks
ORDER BY handler_name;

-- 3. What do the course documents look like?
SELECT _id, data->>'title' AS title, data->>'archived' AS archived
FROM courses
ORDER BY _id;

-- 4. How many events exist for the new type?
SELECT COUNT(*) FROM events
WHERE payload::jsonb->>'type' = 'courseWasArchived';
```

---

### Key takeaways

1. **No DDL migration needed.** The JSONB column accepts any document shape. The
   "migration" is: update handler code, bump version, rebuild.
2. **Rebuild is the migration.** `rebuildProjection()` truncates and replays — the new
   handler code produces documents with the new shape.
3. **Old and new versions can coexist** during the transition, with independent bookmarks
   and locks.
4. **Clean up is manual** — delete the old `_projections` row and old bookmark after
   confirming v2 is stable.
5. **The Postgres tables never change structure** — they are always the same Pongo
   collection schema (`_id`, `data JSONB`, `metadata JSONB`, ...). All evolution happens
   inside the `data` JSONB column.
