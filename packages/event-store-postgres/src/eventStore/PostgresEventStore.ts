import { Pool, PoolClient, QueryResult } from "pg"
import {
    EventStore,
    TaggedEvent,
    AppendConditionError,
    AppendCommand,
    SequencedEvent,
    SequencePosition,
    ReadOptions,
    SubscribeOptions,
    Query,
    ensureIsArray,
    validateAppendCondition
} from "@dcb-es/event-store"
import { v4 as uuid } from "uuid"
import { Projection } from "../projections/projection.js"
import { registerProjection, serializeCanHandle } from "../projections/registry/projectionRegistry.js"
import { tryAcquireSharedProjectionLock } from "../projections/projectionLock.js"
import { dbEventConverter } from "./utils.js"
import { readSqlWithCursor } from "./readSql.js"
import { ensureInstalled } from "./ensureInstalled.js"
import { LockStrategy, advisoryLocks } from "./lockStrategy.js"
import { copyEventsToTable } from "./copyWriter.js"
import { getHighWaterMark, getLastPosition, checkConditions } from "./queries.js"
import { analyseCommands } from "./analyseCommands.js"
import { HwmCache } from "./hwmCache.js"

const VALID_IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/i
const READ_BATCH_SIZE = 5000
const COPY_THRESHOLD = 10_000
const TAG_DELIMITER = "\x1F"
const CONDITION_VIOLATED_SIGNAL = "APPEND_CONDITION_VIOLATED"
const DEFAULT_HWM_CACHE_TTL_MS = 50

export interface PostgresEventStoreOptions {
    pool: Pool
    tablePrefix?: string
    copyThreshold?: number
    lockStrategy?: LockStrategy
    /**
     * Time-to-live for the in-process read-barrier hwm cache. Coalesces concurrent
     * `read()` / `subscribe()` calls with the same filter into a single barrier
     * round-trip. Set to 0 to disable. Default: 50ms — readers can lag new commits
     * by up to this many ms; correctness is unaffected.
     */
    hwmCacheTtlMs?: number
    /**
     * Hard cap on cached hwm entries (FIFO eviction). Default: 1024. Bounds the
     * cache memory footprint when filters churn (per-entity reads, distinct
     * tag values per request, etc.).
     */
    hwmCacheMaxEntries?: number
    /**
     * Projections that run inside the append transaction. Their writes commit
     * atomically with the events, eliminating eventual-consistency lag.
     * Trade-off: advisory locks are held for the duration of projection code,
     * reducing write concurrency on overlapping boundaries (Invariant 6).
     */
    inlineProjections?: Projection[]
    /**
     * Hook that runs inside the append transaction after inline projections
     * but before COMMIT. Receives the newly appended SequencedEvent[].
     * A throw rolls back both the events and any projection writes.
     */
    onBeforeCommit?: (events: SequencedEvent[], context: { client: PoolClient }) => Promise<void>
}

export class PostgresEventStore implements EventStore {
    private tableName: string
    private appendFunctionName: string
    private barrierFunctionName: string
    private notifyChannel: string
    private pool: Pool
    private copyThreshold: number
    private lockStrategy: LockStrategy
    private hwmCache: HwmCache
    private inlineProjections: Projection[]
    private onBeforeCommit?: (events: SequencedEvent[], context: { client: PoolClient }) => Promise<void>

    constructor(options: PostgresEventStoreOptions) {
        this.pool = options.pool
        this.copyThreshold = options.copyThreshold ?? COPY_THRESHOLD
        this.lockStrategy = options.lockStrategy ?? advisoryLocks()
        this.hwmCache = new HwmCache(options.hwmCacheTtlMs ?? DEFAULT_HWM_CACHE_TTL_MS, options.hwmCacheMaxEntries)
        this.inlineProjections = options.inlineProjections ?? []
        this.onBeforeCommit = options.onBeforeCommit
        this.tableName = options.tablePrefix ? `${options.tablePrefix}_events` : "events"
        if (!VALID_IDENTIFIER.test(this.tableName))
            throw new Error(`Invalid table name "${this.tableName}": must match ${VALID_IDENTIFIER}`)
        this.appendFunctionName = `${this.tableName}_append`
        this.barrierFunctionName = `${this.tableName}_barrier_hwm`
        this.notifyChannel = this.tableName
    }

    async ensureInstalled(): Promise<void> {
        await ensureInstalled(this.pool, this.tableName, this.lockStrategy)

        if (this.inlineProjections.length > 0) {
            const client = await this.pool.connect()
            try {
                await client.query("BEGIN")
                for (const projection of this.inlineProjections) {
                    await registerProjection(client, {
                        name: projection.name,
                        version: projection.version ?? 1,
                        type: "i",
                        kind: projection.kind ?? "unknown",
                        status: "active",
                        definition: serializeCanHandle(projection.canHandle)
                    })
                    if (projection.init) await projection.init(client)
                }
                await client.query("COMMIT")
            } catch (err) {
                await client.query("ROLLBACK").catch(() => {})
                throw err
            } finally {
                client.release()
            }
        }
    }

    // ─── Read ───────────────────────────────────────────────────────

    async *read(query: Query, options?: ReadOptions): AsyncGenerator<SequencedEvent> {
        // Backwards reads have no gap problem: they scan from highest seq downwards,
        // and the danger of skipping past in-flight allocations doesn't apply.
        const upperBound = options?.backwards ? undefined : await this.barrierSnapshot(query)

        const client = await this.pool.connect()
        try {
            await client.query("BEGIN")
            const { sql, params, cursorName } = readSqlWithCursor(query, this.tableName, { ...options, upperBound })
            await client.query(sql, params)

            let result: QueryResult
            while ((result = await client.query(`FETCH ${READ_BATCH_SIZE} FROM ${cursorName}`))?.rows?.length) {
                for (const ev of result.rows) yield dbEventConverter.fromDb(ev)
            }
        } finally {
            await client.query("ROLLBACK").catch(() => {})
            client.release()
        }
    }

    /**
     * Acquire reader-side barrier locks via the per-table SP, snapshot
     * pg_sequence_last_value(), release. Returns the safe high-water mark.
     *
     * Implemented as a single autocommit function call so the barrier locks
     * are held only for the duration of the function — they don't span the
     * subsequent cursor scan, which keeps writers unblocked. Concurrent calls
     * with the same filter are coalesced through `hwmCache`; the TTL bounds
     * how stale a cached hwm may be (correctness is unaffected — see HwmCache).
     */
    private async barrierSnapshot(query: Query): Promise<bigint> {
        const keys = this.lockStrategy.computeReaderKeys(query)
        return this.hwmCache.get(keys, async () => {
            const result = await this.pool.query(
                `SELECT ${this.barrierFunctionName}($1::bigint[], $2::bigint[]) AS hwm`,
                [keys.leafS, keys.intentX]
            )
            return BigInt(String(result.rows[0].hwm ?? "0"))
        })
    }

    // ─── Subscribe ──────────────────────────────────────────────────

    async *subscribe(query: Query, options?: SubscribeOptions): AsyncGenerator<SequencedEvent> {
        const pollInterval = options?.pollIntervalMs ?? 100
        let position = options?.after ?? SequencePosition.initial()
        const signal = options?.signal

        const listener = await this.pool.connect()
        listener.setMaxListeners(0)
        let listenerError: Error | null = null
        listener.on("error", err => {
            listenerError = err
        })

        try {
            await listener.query(`LISTEN ${this.notifyChannel}`)

            while (!signal?.aborted) {
                let hadEvents = false
                for await (const event of this.read(query, { after: position })) {
                    yield event
                    position = event.position
                    hadEvents = true
                }

                if (hadEvents) continue
                if (listenerError) throw listenerError

                await new Promise<void>(resolve => {
                    const timeout = setTimeout(resolve, pollInterval)
                    const onNotification = () => {
                        clearTimeout(timeout)
                        signal?.removeEventListener("abort", onAbort)
                        // A NOTIFY means a writer (here or on another instance) committed.
                        // Invalidate so the next iteration's barrier picks up the new state.
                        this.hwmCache.invalidateAll()
                        resolve()
                    }
                    const onAbort = () => {
                        clearTimeout(timeout)
                        listener.removeListener("notification", onNotification)
                        resolve()
                    }
                    listener.once("notification", onNotification)
                    signal?.addEventListener("abort", onAbort, { once: true })
                })
            }
        } finally {
            await listener.query(`UNLISTEN ${this.notifyChannel}`).catch(() => {})
            listener.release()
        }
    }

    // ─── Append ─────────────────────────────────────────────────────

    async append(command: AppendCommand | AppendCommand[]): Promise<SequencePosition> {
        const commands = ensureIsArray(command)
        for (const cmd of commands) {
            if (cmd.condition) validateAppendCondition(cmd.condition)
        }

        const { totalEvents, leafLockKeys, intentLockKeys, conditions, eventIterator } = analyseCommands(
            commands,
            this.lockStrategy
        )
        if (totalEvents === 0) throw new Error("Cannot append zero events")

        const result = await (totalEvents <= this.copyThreshold
            ? this.appendViaFunction(commands, leafLockKeys, intentLockKeys)
            : this.appendViaCopy(commands, leafLockKeys, intentLockKeys, conditions, eventIterator))
        // We just committed new events; any cached hwm in this process is now stale.
        // Cross-instance staleness is handled by subscribers invalidating on NOTIFY.
        this.hwmCache.invalidateAll()
        return result
    }

    /** Stored procedure — single round-trip for ≤ copyThreshold total events. */
    private async appendViaFunction(
        commands: AppendCommand[],
        leafLockKeys: bigint[],
        intentLockKeys: bigint[]
    ): Promise<SequencePosition> {
        if (this.hasInlineWork) {
            return this.appendViaFunctionWithInline(commands, leafLockKeys, intentLockKeys)
        }
        return this.appendViaFunctionAutocommit(commands, leafLockKeys, intentLockKeys)
    }

    /** Autocommit path — no inline projections, single round-trip. */
    private async appendViaFunctionAutocommit(
        commands: AppendCommand[],
        leafLockKeys: bigint[],
        intentLockKeys: bigint[]
    ): Promise<SequencePosition> {
        const { params } = buildAppendFunctionParams(commands, leafLockKeys, intentLockKeys)

        try {
            const result = await this.pool.query(
                `SELECT ${this.appendFunctionName}($1::bigint[], $2::bigint[], $3::text[], $4::text[], $5::text[], $6::int[], $7::text[], $8::text[], $9::bigint[], $10::uuid[], $11::text[], $12::jsonb[]) as pos`,
                params
            )
            return SequencePosition.fromString(String(result.rows[0].pos))
        } catch (err) {
            throw translateAppendError(err, commands)
        }
    }

    /** Transactional path — runs dcb_append + inline projections + hook in one tx. */
    private async appendViaFunctionWithInline(
        commands: AppendCommand[],
        leafLockKeys: bigint[],
        intentLockKeys: bigint[]
    ): Promise<SequencePosition> {
        const allMessageIds = preGenerateMessageIds(commands)
        const { params } = buildAppendFunctionParams(commands, leafLockKeys, intentLockKeys)

        return this.withTransaction(async client => {
            const hwm = await getHighWaterMark(client, this.tableName)

            let pos: number
            try {
                const result = await client.query(
                    `SELECT ${this.appendFunctionName}($1::bigint[], $2::bigint[], $3::text[], $4::text[], $5::text[], $6::int[], $7::text[], $8::text[], $9::bigint[], $10::uuid[], $11::text[], $12::jsonb[]) as pos`,
                    params
                )
                pos = Number(result.rows[0].pos)
            } catch (err) {
                throw translateAppendError(err, commands)
            }

            // Skip projections when all events were idempotent duplicates.
            // dcb_append returns MAX(existing pos) for full duplicates, which is <= hwm.
            if (pos > hwm) {
                const appended = await this.readAppendedEventsByIds(client, allMessageIds)
                await this.runInlineProjections(client, appended)
                if (this.onBeforeCommit) {
                    await this.onBeforeCommit(appended, { client })
                }
            }

            // pg_notify inside dcb_append is deferred until COMMIT — no double notify.
            return SequencePosition.fromString(String(pos))
        })
    }

    /** COPY FROM STDIN — high throughput for > copyThreshold total events. */
    private async appendViaCopy(
        commands: AppendCommand[],
        leafLockKeys: bigint[],
        intentLockKeys: bigint[],
        conditions: { cmdIdx: number; type: string; tags: string[]; afterPos: number }[],
        eventIterator: () => Iterable<TaggedEvent>
    ): Promise<SequencePosition> {
        return this.withTransaction(async client => {
            // Lock-then-allocate invariant: acquire leaf X + intent S BEFORE INSERT.
            await this.lockStrategy.acquireWriter(
                client,
                { leafX: leafLockKeys, intentS: intentLockKeys },
                this.tableName
            )

            // Idempotency check: detect duplicate message_ids before COPY
            // (COPY cannot do ON CONFLICT). Only check when events supply explicit ids.
            const events = [...eventIterator()]
            const suppliedIds = events.filter(e => e.id).map(e => e.id!)
            if (suppliedIds.length > 0) {
                const dupResult = await client.query(
                    `SELECT message_id FROM ${this.tableName} WHERE message_id = ANY($1::uuid[])`,
                    [suppliedIds]
                )
                const duplicateIds = new Set(dupResult.rows.map((r: { message_id: string }) => r.message_id))
                if (duplicateIds.size > 0) {
                    if (duplicateIds.size === suppliedIds.length && suppliedIds.length === events.length) {
                        // All events are duplicates — return max position of existing events
                        const posResult = await client.query(
                            `SELECT MAX(sequence_position) as pos FROM ${this.tableName} WHERE message_id = ANY($1::uuid[])`,
                            [suppliedIds]
                        )
                        return SequencePosition.fromString(String(posResult.rows[0].pos))
                    }
                    throw new Error(
                        `Partial duplicate: ${duplicateIds.size} of ${events.length} events have message_ids that already exist. ` +
                            `This indicates a mix of retry and new events in one batch, which is not supported.`
                    )
                }
            }

            // Pre-generate message_ids when inline work is configured so we can
            // read back exactly our events by identity, avoiding HWM-range races.
            let allMessageIds: string[] | undefined
            if (this.hasInlineWork) {
                allMessageIds = events.map(evt => {
                    if (!evt.id) evt.id = uuid()
                    return evt.id
                })
            }

            const highWaterMark = await getHighWaterMark(client, this.tableName)
            await copyEventsToTable(client, this.tableName, events)

            if (conditions.length > 0) {
                const { condCmdIdxs, condTypes, condTags, condAfter } = flattenConditionRows(conditions)
                const failedIdx = await checkConditions(
                    client,
                    this.tableName,
                    condCmdIdxs,
                    condTypes,
                    condTags,
                    condAfter,
                    highWaterMark,
                    TAG_DELIMITER
                )
                if (failedIdx !== null) throw new AppendConditionError(commands[failedIdx].condition!, failedIdx)
            }

            if (this.hasInlineWork) {
                const appended = await this.readAppendedEventsByIds(client, allMessageIds!)
                await this.runInlineProjections(client, appended)
                if (this.onBeforeCommit) {
                    await this.onBeforeCommit(appended, { client })
                }
            }

            return this.notifyAndReturnPosition(client)
        })
    }

    private async notifyAndReturnPosition(client: PoolClient): Promise<SequencePosition> {
        const pos = await getLastPosition(client, this.tableName)
        await client.query("SELECT pg_notify($1, $2)", [this.notifyChannel, String(pos)])
        return SequencePosition.fromString(String(pos))
    }

    // ─── Inline projection helpers ───────────────────────────────────

    private get hasInlineWork(): boolean {
        return this.inlineProjections.length > 0 || this.onBeforeCommit !== undefined
    }

    /** Read back the events we just appended, identified by their pre-generated message_ids. */
    private async readAppendedEventsByIds(client: PoolClient, messageIds: string[]): Promise<SequencedEvent[]> {
        const result = await client.query(
            `SELECT sequence_position, type, tags, payload, message_id, recorded_at, schema_version, metadata
             FROM ${this.tableName}
             WHERE message_id = ANY($1::uuid[])
             ORDER BY sequence_position`,
            [messageIds]
        )
        return result.rows.map(dbEventConverter.fromDb)
    }

    /** Filter appended events per projection's canHandle query and dispatch. */
    private async runInlineProjections(client: PoolClient, events: SequencedEvent[]): Promise<void> {
        for (const projection of this.inlineProjections) {
            const { acquired, isActive } = await tryAcquireSharedProjectionLock(
                client,
                projection.name,
                projection.version ?? 1
            )
            if (!acquired || !isActive) continue

            const filtered = filterEventsByTypes(events, projection.canHandle)
            if (filtered.length > 0) {
                await projection.handle(filtered, { client })
            }
        }
    }

    // ─── Transaction helper ─────────────────────────────────────────

    private async withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
        const client = await this.pool.connect()
        try {
            await client.query("BEGIN TRANSACTION ISOLATION LEVEL READ COMMITTED")
            const result = await fn(client)
            await client.query("COMMIT")
            return result
        } catch (err) {
            await client.query("ROLLBACK").catch(() => {})
            throw err
        } finally {
            client.release()
        }
    }
}

function translateAppendError(err: unknown, commands: AppendCommand[]): Error {
    const msg = (err as { message?: string }).message ?? ""
    if (msg.includes(CONDITION_VIOLATED_SIGNAL)) {
        const match = msg.match(/APPEND_CONDITION_VIOLATED:cmd=(\d+)/)
        const idx = match ? parseInt(match[1]) : 0
        return new AppendConditionError(commands[idx].condition!, idx)
    }
    return err as Error
}

/**
 * Pre-generate message_id UUIDs for events that don't have an explicit id.
 * Mutates evt.id in place so that serializeCommands picks up the value.
 * Returns the full list of ids for identity-based read-back.
 */
function preGenerateMessageIds(commands: AppendCommand[]): string[] {
    const ids: string[] = []
    for (const cmd of commands) {
        for (const evt of ensureIsArray(cmd.events)) {
            if (!evt.id) evt.id = uuid()
            ids.push(evt.id)
        }
    }
    return ids
}

function buildAppendFunctionParams(
    commands: AppendCommand[],
    leafLockKeys: bigint[],
    intentLockKeys: bigint[]
): { params: unknown[]; hasConditions: boolean } {
    const {
        types,
        tags,
        payloads,
        messageIds,
        schemaVersions,
        metadataJsonb,
        condCmdIdxs,
        condTypes,
        condTags,
        condAfter
    } = serializeCommands(commands)
    const hasConditions = condCmdIdxs.length > 0
    return {
        params: [
            leafLockKeys,
            intentLockKeys,
            types,
            tags,
            payloads,
            hasConditions ? condCmdIdxs : null,
            hasConditions ? condTypes : null,
            hasConditions ? condTags : null,
            hasConditions ? condAfter : null,
            messageIds,
            schemaVersions,
            metadataJsonb
        ],
        hasConditions
    }
}

function serializePayload(evt: TaggedEvent): string {
    return JSON.stringify({ data: evt.event.data, metadata: evt.event.metadata })
}

function serializeCommands(commands: AppendCommand[]) {
    const types: string[] = []
    const tags: string[] = []
    const payloads: string[] = []
    const messageIds: (string | null)[] = []
    const schemaVersions: (string | null)[] = []
    const metadataJsonb: (string | null)[] = []
    const condCmdIdxs: number[] = []
    const condTypes: string[] = []
    const condTags: string[] = []
    const condAfter: number[] = []

    for (let i = 0; i < commands.length; i++) {
        const cmd = commands[i]
        for (const evt of ensureIsArray(cmd.events)) {
            types.push(evt.event.type)
            tags.push(evt.tags.values.join(TAG_DELIMITER))
            payloads.push(serializePayload(evt))
            messageIds.push(evt.id ?? null)
            schemaVersions.push(evt.schemaVersion ?? null)
            metadataJsonb.push(JSON.stringify(evt.event.metadata ?? {}))
        }
        if (cmd.condition) {
            const afterPos = parseInt(cmd.condition.after?.toString() ?? "0")
            for (const item of cmd.condition.failIfEventsMatch.items) {
                for (const type of item.types) {
                    condCmdIdxs.push(i)
                    condTypes.push(type)
                    condTags.push(item.tags?.values.join(TAG_DELIMITER) ?? "")
                    condAfter.push(afterPos)
                }
            }
        }
    }

    return {
        types,
        tags,
        payloads,
        messageIds,
        schemaVersions,
        metadataJsonb,
        condCmdIdxs,
        condTypes,
        condTags,
        condAfter
    }
}

function flattenConditionRows(conditions: { cmdIdx: number; type: string; tags: string[]; afterPos: number }[]) {
    const condCmdIdxs: number[] = []
    const condTypes: string[] = []
    const condTags: string[] = []
    const condAfter: number[] = []
    for (const c of conditions) {
        condCmdIdxs.push(c.cmdIdx)
        condTypes.push(c.type)
        condTags.push(c.tags.join(TAG_DELIMITER))
        condAfter.push(c.afterPos)
    }
    return { condCmdIdxs, condTypes, condTags, condAfter }
}

function filterEventsByTypes(events: SequencedEvent[], types: string[]): SequencedEvent[] {
    if (types.length === 0) return events
    const typeSet = new Set(types)
    return events.filter(se => typeSet.has(se.event.type))
}
