# @dcb-es/event-store-bench

Stress test and benchmark suite for all event store adapters.

## Purpose

This package serves two distinct roles:

**1. Proving DCB consistency under concurrency.** One of the key concerns
about the Dynamic Consistency Boundary pattern is whether the boundary
actually holds when multiple writers race on overlapping scopes. Several
scenarios in this suite are designed as **correctness proofs** — they set up
concurrent writers that deliberately create race conditions, then assert
hard invariants (zero duplicate entities, event counts matching successful
appends, no phantom writes). If the advisory lock strategy, the
`dcb_append` stored procedure, or the read barrier ever regress, these
tests catch it.

**2. Measuring throughput and latency.** The remaining scenarios are
conventional performance benchmarks — peak write speed, scaling factors,
batch size tuning, COPY path crossover points, and degradation as the
event table grows.

### Correctness scenarios (DCB boundary proofs)

These scenarios assert **data invariants**, not just performance metrics.
They are the evidence that DCB works under concurrent load:

| Scenario | What it proves |
|---|---|
| **consistency-oracle** | Multiple workers race to create a finite pool of entities via check-then-write. Asserts **zero duplicate creates** — the core DCB invariant. |
| **overlap-consistency** | Same race, but events carry extra tags beyond the condition query scope. Proves conditions hold even when the event's tag set is wider than the boundary. |
| **contention** | All workers write to a single shared scope (maximum advisory lock contention). Asserts the stored event count matches exactly the number of successful appends — no phantom or lost writes. |
| **bulk-import** | Single large `append(commands[])` with per-entity conditions. Asserts no duplicate entity creates or serial numbers in the resulting event stream. |
| **parallel-import** | Concurrent batch appends with non-overlapping entity ranges. Asserts no duplicates when multiple transactions run conditions in parallel. |
| **meter-upsert** | End-to-end read-decide-write cycle: reads all state, decides which entities to create, batch upserts with `AppendCondition.after` at the read position. Asserts all meters alive with correct create counts. |
| **mixed-workload** | Bulk import runs alongside conditional writers on different scopes. Asserts import completeness and zero errors on the concurrent writers — no cross-contamination at the lock level. |

### Performance scenarios (throughput and latency)

These scenarios have no meaningful data correctness assertions — they measure
ev/sec, latency percentiles, and scaling ratios:

| Scenario | What it measures |
|---|---|
| **throughput-scaling** | Linear scaling factor from 1 to N isolated writers |
| **raw-throughput** | Peak unconditional write speed with no conditions |
| **esb-compat** | Write and read ops/sec at different concurrency tiers |
| **batch-sweep** | Optimal batch size for unconditional and conditional appends |
| **degradation** | Per-phase throughput as the event table grows |
| **batch-commands** | Throughput of N-commands-per-append with per-entity conditions |
| **copy-threshold** | COPY path crossover tuning (pg-local only) |
| **copy-crossover** | COPY vs stored procedure head-to-head (pg-local only) |

### Required regression tests

The project's `CLAUDE.md` (invariant 1) requires that any change to the lock
strategy, advisory locks, or `dcb_append` must be accompanied by passing
`contention` and `overlap-consistency` scenarios with bench numbers recorded
in the PR.

## Architecture

```
src/
├── harness/           Reusable infrastructure
│   ├── types.ts       Result types (WorkerResult, ScenarioResult, AggregateMetrics)
│   ├── stats.ts       Latency percentiles and result aggregation
│   └── workers.ts     Four composable worker primitives (see below)
├── scenarios/         One file per scenario, self-contained
│   ├── registry.ts    Scenario list used by test files
│   └── types.ts       BenchScenario / ThresholdBenchScenario interfaces
├── reporters/         Console table and JSON output formatters
├── test-harness.ts    Shared Postgres lifecycle (pool, DB create/drop, factories)
├── pg.tests.ts        Runs quick presets on testcontainers Postgres
└── pg-local.tests.ts  Runs full presets on a local Postgres instance
```

### Worker primitives

Every scenario is built from one of four worker functions in `harness/workers.ts`:

| Worker | What it does |
|---|---|
| `conditionalRetryWorker` | Appends events with a DCB condition on a scoped query, retries on conflict |
| `scopedBatchWriter` | Appends N events per operation to an isolated scope, optionally with conditions |
| `entityOracleWorker` | Picks a random entity, checks if it exists, creates it with a condition if not |
| `emptyResult` + inline | For scenarios with custom logic (import, read, etc.) |

### Scenario structure

Each scenario exports a `BenchScenario` (or `ThresholdBenchScenario`) object with:

- **`id`** — unique identifier, used as the test name
- **`name`** — human-readable title
- **`description`** — one sentence explaining what the test measures
- **`presets.quick`** — fast config for CI / testcontainers (seconds, small data)
- **`presets.full`** — production-scale config for local Postgres benchmarking
- **`correctnessChecks`** — which verification checks are asserted in tests
- **`run(factory, config)`** — executes the scenario, returns `StressTestResult`

## Scenarios

| Scenario | What it tests |
|---|---|
| **throughput-scaling** | Scales from 1 to N isolated writers — does throughput grow linearly with concurrency? |
| **bulk-import** | Single massive `append(commands[])` with per-entity DCB conditions — can it import thousands of entities in one call without duplicates? |
| **contention** | All workers write to the same scope simultaneously — do conditions and retries handle conflicts correctly under heavy contention? |
| **mixed-workload** | A bulk import runs while small conditional writers operate concurrently — does the import degrade latency for other writers? |
| **raw-throughput** | Unconditional bulk append with no conditions at all — what is the absolute peak write speed? |
| **parallel-import** | Multiple batches import different entity ranges in parallel — do concurrent batch appends with conditions stay correct? |
| **consistency-oracle** | Workers race to create random entities (check-then-write pattern) — does DCB prevent any duplicate entity creation? |
| **overlap-consistency** | Same as consistency-oracle but events carry more tags than the condition query — do conditions still hold when event scope is wider than condition scope? |
| **esb-compat** | Replicates the Event Store Benchmark pattern — separate write and read scaling tiers to measure both paths independently |
| **meter-upsert** | Full read-decide-write cycle: reads all events, decides which meters to create, batch upserts with conditions — does the decision model work end-to-end? |
| **batch-sweep (unconditional)** | Sweeps batch sizes (1, 10, 50, 100, 500) with unconditional appends — which batch size gives the best throughput? |
| **batch-sweep (conditional)** | Same sweep but with conditional appends — how much overhead do conditions add at different batch sizes? |
| **degradation** | Runs multiple phases on the same store as the table grows — how much does throughput degrade as event count increases? |
| **batch-commands** | Each `append()` submits N `AppendCommand` objects (1 event + 1 condition each) — tests the real-world bulk import pattern with per-entity uniqueness |
| **copy-threshold** *(pg-local only)* | Holds batch size constant, varies the Postgres COPY threshold — finds the crossover point where `COPY FROM` beats the stored procedure |
| **copy-crossover** *(pg-local only)* | For each batch size, runs both function path and COPY path back-to-back — direct side-by-side comparison |

## Running

```bash
# Unit tests (MemoryEventStore, fast)
npm test

# Testcontainers Postgres (requires Docker)
npm run test:pg

# Local Postgres (requires PG_CONNECTION_STRING or localhost:5432)
npm run test:pg-local
```

Set `PG_CONNECTION_STRING` to point at a local Postgres instance for `test:pg-local`. The test harness creates and drops an isolated database per test.
