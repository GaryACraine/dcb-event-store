# Postgres transactions and locking, as needed for a DCB event store

An upskilling document. It starts from first principles, works through the two
concrete problems a DCB event store has to solve, and finishes by reading the
`dcb-event-store` Postgres implementation line by line against those problems.
Every technique is marked as **used** or **not used** in the delivered solution.

---

## 1. What the event store actually needs from Postgres

Strip away the vocabulary and a DCB event store makes two promises.

**Promise A — no lost boundary.** When a command says "append these events,
provided no event matching *this query* has been appended since position *P*",
then at most one of any set of concurrent conflicting commands succeeds. Two
customers cannot both book the last seat. This is the *write-side* promise.

**Promise B — complete prefix.** When a reader (a projection, a subscription)
reads "everything up to position *N*", nothing with a position ≤ *N* will
appear later. A projection that has processed up to *N* has seen every event up
to *N*, forever. This is the *read-side* promise.

Both promises sound trivially true of any database. Neither is true of Postgres
by default. Understanding why is the whole content of this document.

---

## 2. Transactions — the parts you already know, made precise

A transaction is a unit of work that is atomic (all or nothing), consistent,
isolated (other transactions see it as if it happened instantaneously), and
durable (once committed, it survives crashes). You know this. Three details
matter more than the acronym:

1. **Everything runs in a transaction.** A bare statement outside
   `BEGIN`/`COMMIT` is wrapped in one automatically ("autocommit"). A stored
   function called from a bare `SELECT` runs entirely inside that one
   implicit transaction. This is why the event store's append is a single
   function call: the function *is* the transaction.

2. **Isolation is a promise about what you can see, not about what happens.**
   Two transactions run at the same time on different connections. Isolation
   determines which of the other's changes each can observe. It does not
   stop them running concurrently.

3. **"Isolated" is not "serialised".** The strongest level, `SERIALIZABLE`,
   guarantees the *outcome* is equivalent to some serial order, and it achieves
   that by aborting transactions that would break it, not by running them one at
   a time. Every weaker level allows some observable interleaving.

---

## 3. MVCC — how Postgres lets readers and writers coexist

Postgres never modifies a row in place. An `UPDATE` writes a new row version
and marks the old one as expired; a `DELETE` just marks it; an `INSERT` creates
a version that is invisible until its transaction commits. Every row version
carries the transaction ids that created and (if applicable) expired it.

When a statement runs, it takes a **snapshot**: the set of transactions that
had committed at that instant. A row version is visible if it was created by a
committed transaction in the snapshot and not expired by one. Everything else,
including rows inserted by transactions still in flight, is invisible.

Consequences that drive everything later:

- **Readers never block writers, and writers never block readers.** A `SELECT`
  takes no lock that an `INSERT` cares about.
- **You cannot see uncommitted work.** Ever. There is no "read uncommitted" in
  Postgres; asking for it gives you `READ COMMITTED`.
- **You may fail to see committed work** if it committed after your snapshot
  was taken. Whether that snapshot is per statement or per transaction is what
  the isolation level controls.
- **Two transactions can both not-see each other's uncommitted inserts, and
  both commit.** This is not a bug. It is the design. It is also Promise A's
  problem in one sentence.

---

## 4. Isolation levels — what each one does and does not fix

### 4.1 READ COMMITTED (the default)

Each *statement* takes a fresh snapshot. Within one transaction, two
consecutive `SELECT`s can return different rows if something committed in
between.

```
Tx1: BEGIN
Tx1: SELECT count(*) FROM events WHERE tags @> '{seat:12A}'   -> 0
Tx2: INSERT INTO events (...) VALUES ('SeatBooked', '{seat:12A}', ...); COMMIT
Tx1: SELECT count(*) FROM events WHERE tags @> '{seat:12A}'   -> 1
Tx1: COMMIT
```

Fine for most application code. Fatal for check-then-act:

```
Tx1: BEGIN                                Tx2: BEGIN
Tx1: SELECT ... seat:12A  -> 0            Tx2: SELECT ... seat:12A  -> 0
Tx1: INSERT SeatBooked 12A                Tx2: INSERT SeatBooked 12A
Tx1: COMMIT                               Tx2: COMMIT
```

Both checks ran before either insert committed, both saw nothing, both
inserted, both committed. **Two SeatBooked events for one seat.** Nothing in
Postgres flagged an error. This is the outcome if Promise A is left to the
default isolation level, and it is the exact scenario Maxime Gosselin's article
warns about.

### 4.2 REPEATABLE READ

One snapshot for the whole *transaction*, taken at the first statement. Repeat
`SELECT`s always agree. If you `UPDATE` or `DELETE` a row that another
transaction modified since your snapshot, you get a serialisation error and
must retry.

Does it fix the race above? **No.** Both transactions `INSERT`. Neither touches
a row the other touched (the rows don't exist yet). Both commit. Snapshot
stability protects you from *seeing* inconsistency; it does not detect that
your *decision* was based on a snapshot that is now stale for the purpose of an
insert. The seat is still double-booked.

### 4.3 SERIALIZABLE

Postgres implements this as Serializable Snapshot Isolation (SSI). Every
transaction runs on a snapshot as in `REPEATABLE READ`, plus Postgres tracks
*predicate locks* — not real locks, but records of "this transaction read rows
matching this predicate". If it detects a pattern of reads and writes among
concurrent transactions that could not occur in any serial order, it aborts
one of them with `SQLSTATE 40001` and the client must retry.

Does it fix the race? **Yes.** Tx1 read "seat:12A → nothing", Tx2 wrote a
matching row; Tx2 read the same, Tx1 wrote a matching row. That is a cycle;
one aborts. Retry it, it sees the other's booking, fails the condition
correctly.

So why not just use it?

- **Retries are yours to implement.** Every append must be wrapped in a loop
  that catches 40001 and re-runs the whole decision. Under contention you can
  get retry storms.
- **False positives.** SSI tracks predicates at page or index-range
  granularity when memory is tight. Two commands touching *unrelated* seats can
  be aborted because their reads landed on the same index page. Throughput
  becomes unpredictable and degrades with table size.
- **It is table-wide.** There is no way to say "serialise only commands that
  overlap on these tags". The DCB model is *precisely* about narrow, dynamic
  boundaries; SSI cannot express that.

`SERIALIZABLE` is a correct solution. It is **not used** in the delivered
store, for these reasons. Keep it in mind as the "big hammer" baseline.

### 4.4 Summary

| Level | Snapshot | Fixes the check-then-insert race? | Used in DCB store? |
|---|---|---|---|
| READ COMMITTED | per statement | No | **Yes**, plus explicit locks |
| REPEATABLE READ | per transaction | No | No |
| SERIALIZABLE | per transaction + conflict detection | Yes, via aborts and retries | No |

The store runs at the default level and adds *explicit* locking to get exactly
the mutual exclusion it needs and no more. The rest of this document is about
those locks.

---

## 5. Locks — the vocabulary

### 5.1 Two modes are enough to understand everything here

Postgres has eight table-lock modes with a complicated compatibility matrix.
For this store, two concepts carry all the weight:

- **Shared (S).** "I am using this; you may use it too, but nobody may hold
  it exclusively while I do." Many holders at once.
- **Exclusive (X).** "Mine alone." One holder; blocks all S and X requesters.

| | S requested | X requested |
|---|---|---|
| **S held** | granted | **waits** |
| **X held** | **waits** | **waits** |

That one table is most of what you need. Everything else is about *what* the
lock is attached to and *when* it is released.

### 5.2 Waiting versus failing

By default a lock request that cannot be granted **waits**, indefinitely, until
the holder commits or rolls back. The alternatives:

- `NOWAIT` — error immediately if the lock is not available.
- `SKIP LOCKED` — for row locks: silently skip rows that are locked.
- `lock_timeout` — a session setting; wait at most this long, then error.
- `pg_try_advisory_*` — the non-blocking form of advisory locks; returns
  `false` instead of waiting.

### 5.3 Table locks

Every statement takes a table-level lock implicitly. `SELECT` takes `ACCESS
SHARE`; `INSERT` takes `ROW EXCLUSIVE`; these two do not conflict, which is
MVCC's "readers don't block writers" in lock terms. DDL takes `ACCESS
EXCLUSIVE`, which conflicts with everything — the reason schema changes can
stall a live system.

You can take table locks explicitly with `LOCK TABLE events IN EXCLUSIVE
MODE`. This would solve Promise A by serialising every append in the system.
**Not used**; it is the coarsest possible boundary and throws away all
concurrency.

### 5.4 Row locks

`SELECT ... FOR UPDATE` takes an exclusive row lock on each row returned;
`FOR SHARE` takes a shared one. They are released at transaction end. They are
what most application-level pessimistic locking uses:

```sql
BEGIN;
SELECT * FROM bookmarks WHERE handler = 'seat-map' FOR UPDATE NOWAIT;
-- do work
UPDATE bookmarks SET position = 1234 WHERE handler = 'seat-map';
COMMIT;
```

Two consumers doing this concurrently: the second gets an error from `NOWAIT`
and knows another instance owns the handler. **Used** — this is exactly how the
store's `runHandler` protects a projection's bookmark.

Row locks have a limitation for the write side: you can only lock a row that
*exists*. You cannot `FOR UPDATE` the seat that nobody has booked yet, because
there is no row. The store's `rowLocks()` strategy works around this with a
lazily-upserted "scope" table (see §8.6).

### 5.5 Advisory locks

An advisory lock is a lock on a *number*, not on a row or table. Postgres does
nothing with it except honour the S/X matrix. You decide what the number means.

```sql
SELECT pg_advisory_xact_lock(4128381091236781);         -- X, until COMMIT
SELECT pg_advisory_xact_lock_shared(4128381091236781);  -- S, until COMMIT
SELECT pg_advisory_lock(4128381091236781);              -- X, until unlock or session end
SELECT pg_try_advisory_xact_lock(...)                   -- non-blocking, returns bool
```

Two scopes:

- **Transaction-scoped** (`_xact_`): released automatically at `COMMIT` or
  `ROLLBACK`. Cannot leak. **Used** for all content locking.
- **Session-scoped**: held until explicitly unlocked or the connection closes.
  Survives across transactions. Dangerous with connection pools (the lock goes
  back into the pool with the connection). **Used** in exactly one place: the
  schema-migration mutex in `ensureInstalled`, on a dedicated client.

Why advisory locks fit DCB: a consistency boundary is not a row. It is "the
(type, tag) pairs this command cares about". Hash each pair to a 64-bit number
and lock the number. The row for the seat need not exist; the *lock* exists the
moment you ask for it.

Cost: they live in shared memory, are cheap, and have a configurable maximum
(`max_locks_per_transaction` × connections). Limitation: they are per Postgres
*instance*, so a transaction-mode connection pooler that hands your next
statement to a different backend breaks them — see §8.6.

### 5.6 Deadlocks

Tx1 holds A and wants B; Tx2 holds B and wants A. Postgres detects this after
`deadlock_timeout` (default 1s) and aborts one. The standard prevention is
**always acquire locks in a fixed global order**. If everyone locks A before B,
the cycle cannot form. **Used**: the store sorts every key set numerically and
acquires all keys in one statement, in that order.

---

## 6. Sequences — the detail that breaks Promise B

`BIGSERIAL` is a `BIGINT` with a default of `nextval('events_sequence_position_seq')`.
The critical fact: **`nextval` is not transactional.** The number is allocated
the instant it is called and is never given back. If the transaction rolls
back, that number is simply skipped. This is by design; it lets concurrent
inserters allocate without blocking each other.

The consequence is that **sequence order is not commit order**:

```
t=0  Tx1: INSERT  -> nextval = 100     (Tx1 is slow; not yet committed)
t=1  Tx2: INSERT  -> nextval = 101
t=2  Tx2: COMMIT                        -> position 101 is now visible
t=3  Reader: SELECT ... WHERE position > 99   -> sees 101, not 100
t=3  Reader: bookmark = 101
t=4  Tx1: COMMIT                        -> position 100 is now visible
t=5  Reader: SELECT ... WHERE position > 101  -> never sees 100
```

Event 100 is committed, durable, and **permanently invisible to that
projection.** No error is raised anywhere. This is the "commit gap". Every
Postgres event store that uses a sequence for global ordering has to solve it,
and it is the reason the naive "poll for `position > bookmark`" consumer is
wrong even with a single writer thread per process.

Two functions you need:

- `currval(seq)` — the last value *this session* obtained from `nextval`.
- `pg_sequence_last_value(seq)` — the last value allocated by *anyone*,
  whether or not they have committed. This is the "high-water mark" of
  allocation. The store reads it in both the append and the barrier.

---

## 7. The two problems, worked end to end

### 7.1 Problem A — the lost boundary (write/write)

Two commands, each conditioned on "no `SeatBooked` with tag `seat:12A` after
position 90". Without locks, under READ COMMITTED, both check, both pass,
both insert (§4.1).

**What must be true for a fix.** Between the moment a command checks its
condition and the moment it inserts, no other command with an *overlapping*
condition may do either. And the check must see every committed event that
matters.

**The store's fix, in order:**

1. Compute the set of (type, tag) leaf keys in the condition and in the events
   being appended. Hash each.
2. Take an **exclusive advisory lock on every leaf key**, sorted.
   Any concurrent command sharing a key now waits here until we commit.
3. Read `pg_sequence_last_value` → `hwm`.
4. Run the condition check bounded by `sequence_position <= hwm`.
5. Insert (this is where `nextval` allocates our positions).
6. Commit; locks vanish.

Why step 4's bound is safe: any earlier conflicting writer held the same leaf
lock, so it has already committed before we got past step 2, so its positions
are ≤ our `hwm` and visible to the check. Any *later* conflicting writer is
blocked at step 2 and will re-run its own check after we commit, at which point
it will see our events. Commands with **disjoint** keys never touch each other's
locks and run fully in parallel.

**Outcome without the fix:** silent double-booking. **Outcome with it:** the
second command raises `APPEND_CONDITION_VIOLATED`, deterministically, with no
retry loop.

### 7.2 Problem B — the commit gap (write/read)

From §6: a reader can observe position 101 while 100 is still in flight, and
then never see 100.

**What must be true for a fix.** When a reader decides "I will read up to N",
every position ≤ N must already be committed, or guaranteed never to exist.

**The store's fix — the read barrier:**

1. The reader computes lock keys from its *query* (same hashing as writers).
2. It takes locks in the **opposite modes** to writers (§8.2), then reads
   `pg_sequence_last_value` → `hwm`, then releases immediately. This is one
   autocommit function call, `_barrier_hwm`.
3. It scans with `sequence_position <= hwm`.

Why it works rests on one invariant in the append function, stated in the
source as *lock-then-allocate*: **a writer takes its locks before it calls
`nextval`.** So:

- Any writer that allocated a position ≤ `hwm` had already acquired its locks
  when it allocated. The barrier's lock request waits behind it. By the time
  the barrier holds the lock and reads `hwm`, that writer has committed.
- Any writer that starts after the barrier released allocates a position
  > `hwm`, so it is above the reader's bound; the reader will pick it up next
  time.

Therefore everything ≤ `hwm` is committed. The prefix is complete.

**Outcome without the fix:** projections silently miss events under load,
non-reproducibly, forever. **Outcome with it:** a reader's bound is always a
committed prefix. A dedicated test, `concurrentCommitGap.tests.ts`, holds a
writer transaction open and asserts the reader's bound stays below it.

---

## 8. Reading the implementation

Files: `packages/event-store-postgres/src/eventStore/{advisoryLocks,lockStrategy,ensureInstalled,PostgresEventStore,hwmCache}.ts`
and `eventHandling/runHandler.ts`.

### 8.1 The key taxonomy (`advisoryLocks.ts`)

Three disjoint namespaces, kept apart by a prefix before hashing so a leaf key
can never collide with an intent key:

| Key | Built from | Meaning |
|---|---|---|
| Leaf `L:type\|tag` | one (type, tag) pair | "content of this exact scope" |
| Type intent `T:type` | one type | "any tag of this type" |
| Global intent `G` | constant | "the whole stream" |

Hash: FNV-1a 64-bit, folded to a signed `bigint` because
`pg_advisory_xact_lock` takes `bigint`. Collisions are theoretically possible
and harmless: a collision only causes two unrelated scopes to serialise
against each other, never to miss a conflict.

### 8.2 Who takes what, in which mode

This is the heart of the design and the part worth memorising.

| | Leaf keys | Type intent | Global intent |
|---|---|---|---|
| **Writer** | **X** on every (type, tag) in condition + events | **S** on each event type | **S** |
| **Reader** with (types, tags) filter | **S** on each (type, tag) | — | — |
| **Reader** with type-only filter | — | **X** on each type | — |
| **Reader** `Query.all()` | — | — | **X** |

Read it against the S/X matrix (§5.1):

- **Writer vs writer on the same leaf**: X vs X → serialise. That's Promise A.
- **Writer vs writer on different leaves**: no shared X keys; intent keys are
  S vs S → compatible. They run in parallel. This is why the intent locks are
  taken in *shared* mode by writers: they must never serialise writers against
  each other.
- **Narrow reader vs writer on the same leaf**: S vs X → the reader waits for
  the in-flight writer to commit. That's the barrier for Promise B.
- **Type-only reader vs writers of that type**: reader X vs writer S on the
  type intent → the reader waits for *every* in-flight writer of that type,
  regardless of tag. It cannot know which tags matter, so it has to wait for
  all of them.
- **`Query.all()` reader vs everyone**: X vs S on global → waits for every
  in-flight writer. Correct, and the most expensive; the design pushes you
  toward tagged queries.

The "intent" terminology is borrowed from multi-granularity locking in
textbooks: a fine-grained lock (leaf) is accompanied by a coarse-grained
*intent* lock so that a coarse-grained requester can detect fine-grained
activity without enumerating it.

### 8.3 Acquisition (`lockStrategy.ts`, `advisoryLocks()`)

One SQL statement per side, unnesting both key arrays with an `excl` flag,
`ORDER BY k`, and choosing `pg_advisory_xact_lock` or `_shared` per row. Single
statement plus global ordering is the deadlock defence from §5.6, applied
across both modes at once. There is no `NOWAIT` here: writers *wait*, which is
what gives deterministic outcomes without retries.

### 8.4 The append function (`ensureInstalled.ts`, `<table>_append`)

Follow the body against §7.1:

```
IF any keys THEN  <lock block>  END IF;              -- step 2, before anything else
SELECT pg_sequence_last_value(...) INTO v_hwm;       -- step 3
IF conditions THEN
    ... EXISTS (... AND e.sequence_position > c.after_pos
                    AND e.sequence_position <= v_hwm) ...   -- step 4
    IF found THEN RAISE EXCEPTION 'APPEND_CONDITION_VIOLATED:cmd=%' ...
END IF;
INSERT INTO <table> (type, tags, payload) SELECT ... ;      -- step 5, nextval here
SELECT currval(...) INTO v_pos;
PERFORM pg_notify(<table>, v_pos::text);
RETURN v_pos;
```

Three things to notice:

- The source comment calls lock-then-allocate "load-bearing for the read
  barrier". If anyone ever moves the `INSERT` (or a `nextval`) above the lock
  block, Promise B silently breaks while every unit test that doesn't race
  still passes.
- `RAISE EXCEPTION` rolls back the whole function call. Because the call *is*
  the transaction (§2.1), nothing is inserted and the locks are released.
- The `SET LOCAL enable_hashjoin = off ...` lines around the multi-condition
  check are planner hints scoped to this transaction, forcing an index-friendly
  nested loop over the small `conds` CTE. Performance, not correctness.

`pg_notify` inside the transaction is delivered only on commit, which is the
right semantics: listeners are never told about events that rolled back.

### 8.5 The barrier function and the read path

`<table>_barrier_hwm(p_shared_keys, p_exclusive_keys)` is the §7.2 procedure:
lock block, read `pg_sequence_last_value`, return. `PostgresEventStore.read()`
calls it via `pool.query` — autocommit — so the locks are held for
microseconds and never span the subsequent cursor scan. Then it opens a
separate transaction for the scan with `sequence_position <= hwm` and a
server-side cursor, fetching in batches. Backwards reads skip the barrier
entirely because scanning downward from the top cannot "jump over" a gap that
later fills in.

### 8.6 `rowLocks()` — the same protocol without advisory locks

Transaction-mode poolers (PgBouncer, Supavisor, RDS Proxy) may route each
statement or transaction of your session to a different backend. Advisory
locks are per-backend, so a lock taken in one statement can be invisible to the
next. `rowLocks()` re-implements the identical S/X protocol on a
`<table>_lock_scopes(scope_key BIGINT PRIMARY KEY)` table: upsert the keys
(`ON CONFLICT DO NOTHING`), then `SELECT ... FOR UPDATE` for X and `FOR SHARE`
for S, in sorted order. Row locks are stored in the row headers, so they follow
the data rather than the backend. Cost: a few extra writes per append and a
table that grows with the number of distinct scopes ever seen. The deadlock
argument is preserved because the leaf and intent keyspaces are disjoint, so
no transaction can wait in one keyspace while holding the same keyspace in the
opposite mode.

### 8.7 `hwmCache` — caching a barrier result safely

Repeated readers with the same filter shape coalesce into one barrier call and
reuse the result for `ttlMs` (default 50ms). The correctness argument is in the
source: a cached `hwm` was a valid barrier output at fill time, and any writer
that started after that allocates `> hwm`, so scanning `<= hwm` can never
observe it. Staleness only delays visibility; it cannot create a gap.

### 8.8 The hardened processor (`processor.ts`, `processorLock.ts`, `checkpointer.ts`)

The production consumer solves a **third problem** beyond boundaries and
barriers.

**Problem C — instance ownership.** Two consumer processes start for the same
handler. Without protection, both poll, both process, events are handled
twice. Idempotent projections mask it; non-idempotent side effects (emails,
external API calls) do not.

**Session-scoped processor lock.** Each processor acquires
`pg_try_advisory_lock(processorLockKey(name))` on a dedicated client before
processing begins. If another instance already holds the lock, the call
returns `false` and the processor rejects immediately. The lock is session-
scoped (not `_xact_`) because it must survive across the many short
transactions that process individual events: each event is processed in its
own `BEGIN`/`COMMIT`, and the lock must not be released between them. Contrast
with the schema-migration lock in §8.9 which also spans multiple statements,
and with the boundary locks in §8.3 which are transaction-scoped because they
protect a single append.

**The `P:` namespace.** The processor lock key is hashed with the `P:` prefix,
the fourth namespace alongside `L:` (leaf), `T:` (type intent), and `G`
(global intent). Collisions with boundary locks would cause writers to wait on
a processor lock that is held for minutes — explaining why the distinct
namespace matters. A writer's advisory lock request completes in microseconds;
waiting behind a minutes-long processor lock would stall all writes to that
scope.

**CAS checkpoints.** The bookmark update uses `WHERE version = $expected` as
defense-in-depth. If the lock was somehow lost (network partition, stale
connection), a concurrent instance's version bump causes this instance's CAS
to fail (zero rows affected), surfacing the conflict immediately rather than
silently double-processing. The bookmark table carries three Phase 3 columns:
`version BIGINT` (incremented on each update), `instance_id TEXT` (which
processor instance last wrote), and `last_updated TIMESTAMPTZ`.

**Subscribe-based processing.** The processor uses `eventStore.subscribe()`
internally, which handles the LISTEN/read/poll loop efficiently via a
persistent cursor. Each event yielded by `subscribe()` is processed in its own
transaction: `BEGIN` → handler writes → CAS checkpoint update → `pg_notify`
on the bookmark channel → `COMMIT`. This preserves the atomicity guarantee:
projection writes and bookmark advance are atomic. If either fails, neither
commits and the event is redelivered on restart.

**Start positions.** `startFrom: "BEGINNING"` uses the stored checkpoint
(position 0 for new handlers, or the stored position for restarted ones).
`startFrom: "CURRENT"` snapshots the high-water mark if the handler has never
run before, skipping all historical events — useful for projections added
after millions of events (e.g., a notification sender). If the handler has run
before, `CURRENT` resumes from the stored checkpoint (a restarted processor
should not skip events).

### 8.9 The consumer lifecycle (`consumer.ts`)

`createConsumer` wraps one or more processors with a shared `AbortController`.
Each processor runs independently with its own lock and checkpoint. `stop()`
aborts the shared signal, and all processors finish their current event,
release their locks, and resolve. `Promise.allSettled` ensures one processor's
error does not affect the others.

### 8.10 The one session-scoped lock (`ensureInstalled.ts`)

`DROP FUNCTION` followed by `CREATE FUNCTION` is two DDL statements; a writer
arriving between them would find no append function. `ensureInstalled` takes
`pg_advisory_lock(-89001)` on a dedicated client before the migration and
releases it after. Session scope is required because the mutex must span
several statements, and the key is a constant far outside the hashed
namespaces. It is also the pattern for the migration table in Phase 9 of the
plan.

---

## 9. Techniques catalogue

| Technique | Used? | Where / why not |
|---|---|---|
| READ COMMITTED + explicit locks | **Yes** | Default level everywhere; locks supply the mutual exclusion |
| Transaction-scoped advisory locks, S and X | **Yes** | Content mutex and read barrier, `advisoryLocks()` |
| Multi-granularity (intent) locking | **Yes** | Type and global intent keys let coarse readers wait for fine-grained writers |
| Global lock ordering in a single statement | **Yes** | Deadlock prevention |
| `pg_sequence_last_value` as high-water mark | **Yes** | Bounds both the condition check and the reader scan |
| Lock-then-allocate ordering | **Yes** | The invariant that makes the barrier sound |
| Row locks `FOR UPDATE NOWAIT` | **Yes** | Consumer bookmark ownership |
| Row locks `FOR UPDATE` / `FOR SHARE` on a scope table | **Yes** | `rowLocks()` strategy for pooled/proxied deployments |
| Session-scoped advisory lock for processor ownership | **Yes** | `P:` namespace, one per processor instance |
| CAS version column on bookmark row | **Yes** | Defense-in-depth against double-processing |
| Session-scoped advisory lock | **Yes**, twice | Schema migration mutex + processor instance lock |
| Server-side cursors | **Yes** | Batched reads without loading the result set |
| `pg_notify` inside the append transaction | **Yes** | Wake subscribers only on commit |
| `SERIALIZABLE` / SSI | No | Correct but table-wide, retry-based, unpredictable under contention |
| `REPEATABLE READ` | No | Does not detect the insert race |
| `LOCK TABLE` | No | Serialises every append |
| Optimistic concurrency via a version row (Emmett's `streams` table) | No | Stream-scoped; DCB boundaries are dynamic, not per-stream |
| `xid8` + `pg_snapshot_xmin` visibility filter (Emmett's gap fix) | No | Alternative to the barrier; needs composite checkpoints; the barrier keeps `sequence_position` sufficient |
| `SKIP LOCKED` | No | Queue-worker pattern; not needed for single-owner bookmarks |
| Triggers for projections or notifications | No | Append is a function; notification is explicit |
| `lock_timeout` | No (yet) | Worth adding as a safety net around writer acquisition in a fork |

---

## 10. Try it yourself — two psql sessions

These reproduce the failures and the fixes. Use two terminals, `A` and `B`.

**The commit gap.**
```
A: CREATE TABLE ev (pos BIGSERIAL PRIMARY KEY, body TEXT);
A: BEGIN; INSERT INTO ev(body) VALUES ('slow');           -- allocates 1, holds
B: INSERT INTO ev(body) VALUES ('fast');                  -- allocates 2, commits
B: SELECT * FROM ev WHERE pos > 0;                        -- sees only 2
B: -- a projection would now set bookmark = 2
A: COMMIT;
B: SELECT * FROM ev WHERE pos > 2;                        -- empty; 1 is lost to it
```

**The barrier fixing it.**
```
A: BEGIN; SELECT pg_advisory_xact_lock(42); INSERT INTO ev(body) VALUES ('slow');
B: SELECT pg_advisory_xact_lock_shared(42);               -- blocks...
A: COMMIT;
B: -- ...returns now. SELECT pg_sequence_last_value('ev_pos_seq');  -> includes A's row
```
Note that B is only safe because A locked *before* inserting. Swap A's two
statements and B's barrier proves nothing.

**The lost boundary and the fix.**
```
A: BEGIN; SELECT count(*) FROM ev WHERE body='seat12A';  -> 0
B: BEGIN; SELECT count(*) FROM ev WHERE body='seat12A';  -> 0
A: INSERT INTO ev(body) VALUES ('seat12A'); COMMIT;
B: INSERT INTO ev(body) VALUES ('seat12A'); COMMIT;      -- double booking
```
Now prefix both `BEGIN`s with `SELECT pg_advisory_xact_lock(hashtext('seat12A'));`.
B blocks at the lock until A commits, then its `count(*)` returns 1.

**SERIALIZABLE for comparison.**
Repeat the lost-boundary script with `BEGIN ISOLATION LEVEL SERIALIZABLE;`.
B's `COMMIT` fails with `could not serialize access`. Correct, but you now own
the retry.

**Processor instance exclusivity.**
```
A: SELECT pg_try_advisory_lock(hashtext('P:my-projection'));   -> true
B: SELECT pg_try_advisory_lock(hashtext('P:my-projection'));   -> false
-- B knows another instance owns this processor, rejects immediately
A: SELECT pg_advisory_unlock(hashtext('P:my-projection'));     -> true
B: SELECT pg_try_advisory_lock(hashtext('P:my-projection'));   -> true
-- B acquires the lock after A releases
B: SELECT pg_advisory_unlock(hashtext('P:my-projection'));
```
Session A holds the lock; B gets `false` (non-blocking) and knows it cannot
process. After A unlocks, B retries and succeeds. This is exactly how
`acquireProcessorLock` implements instance exclusivity.

---

## 11. Glossary

- **Snapshot** — the set of committed transactions a statement can see.
- **MVCC** — multi-version concurrency control; row versions plus snapshots.
- **Isolation level** — how long a snapshot is held and what conflicts abort.
- **SSI** — Serializable Snapshot Isolation; Postgres's `SERIALIZABLE`.
- **Advisory lock** — a lock on an application-chosen integer.
- **Transaction-scoped / session-scoped** — released at commit vs at unlock or disconnect.
- **Intent lock** — a coarse-grained lock signalling fine-grained activity beneath it.
- **High-water mark (hwm)** — highest sequence value allocated so far, committed or not.
- **Commit gap** — a committed row with a lower sequence value than one already observed.
- **Read barrier** — briefly acquiring locks to wait for in-flight writers before snapshotting the hwm.
- **Lock-then-allocate** — the invariant that a writer holds its locks before calling `nextval`.
- **Consistency boundary** — the set of (type, tag) scopes a command's condition depends on.
- **Processor lock** — session-scoped advisory lock for processor instance ownership, using the `P:` namespace.
- **CAS (compare-and-swap)** — updating only when the current version matches expected; detects concurrent modifications.
- **Start position** — where a processor begins reading: `BEGINNING` (from stored checkpoint) or `CURRENT` (skip historical events).
- **Consumer** — lifecycle wrapper for one or more processors, providing shared abort and graceful `stop()`.
