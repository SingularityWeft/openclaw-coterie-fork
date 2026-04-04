import {
  aggregateMonthlyUsageRows,
  aggregateRowsByCustomer,
  aggregateRowsByMonth,
  buildMonthlyStorageKey,
  compareMonthKey,
} from "./aggregator.js";
import type {
  CoachUsageEvent,
  CoachUsageMonthlyQuery,
  CoachUsageMonthlyQueryResult,
  CoachUsageMonthlyRow,
  CoachUsageStorage,
} from "./types.js";

function cloneMonthlyRow(row: CoachUsageMonthlyRow): CoachUsageMonthlyRow {
  return { ...row };
}

function round(value: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function withinMonthRange(month: string, from?: string, to?: string): boolean {
  if (from && compareMonthKey(month, from) < 0) {
    return false;
  }
  if (to && compareMonthKey(month, to) > 0) {
    return false;
  }
  return true;
}

function mergeMonthlyRows(
  existing: CoachUsageMonthlyRow | undefined,
  delta: CoachUsageMonthlyRow,
): CoachUsageMonthlyRow {
  if (!existing) {
    return cloneMonthlyRow({
      ...delta,
      refreshedAt: delta.refreshedAt || new Date().toISOString(),
    });
  }
  return cloneMonthlyRow({
    ...existing,
    planId: existing.planId || delta.planId,
    activeCustomers: Math.max(existing.activeCustomers, delta.activeCustomers),
    usageUnits: round(existing.usageUnits + delta.usageUnits),
    sessions: existing.sessions + delta.sessions,
    retests: existing.retests + delta.retests,
    toolRuns: existing.toolRuns + delta.toolRuns,
    aiDeliveryCost: round(existing.aiDeliveryCost + delta.aiDeliveryCost, 6),
    rawTokensTotal: existing.rawTokensTotal + delta.rawTokensTotal,
    source: delta.source || existing.source,
    refreshedAt: delta.refreshedAt || new Date().toISOString(),
  });
}

type PgQueryResult<Row extends Record<string, unknown> = Record<string, unknown>> = {
  rows: Row[];
  rowCount?: number | null;
};

type PgQueryable = {
  query: <Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ) => Promise<PgQueryResult<Row>>;
};

type PgPoolClient = PgQueryable & {
  release: () => void;
};

type PgPool = PgQueryable & {
  connect: () => Promise<PgPoolClient>;
  end: () => Promise<void>;
};

async function loadPgPoolCtor(): Promise<
  new (config: {
    connectionString: string;
    max?: number;
    idleTimeoutMillis?: number;
    connectionTimeoutMillis?: number;
  }) => PgPool
> {
  const moduleName = "pg";
  const pgModule = (await import(moduleName)) as {
    Pool?: new (config: {
      connectionString: string;
      max?: number;
      idleTimeoutMillis?: number;
      connectionTimeoutMillis?: number;
    }) => PgPool;
  };
  if (!pgModule.Pool) {
    throw new Error("pg package is installed but does not export Pool");
  }
  return pgModule.Pool;
}

function normalizeOccurredAt(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid occurredAt value: ${String(value)}`);
  }
  return date.toISOString();
}

function normalizeMonthDateValue(value: unknown): string {
  if (typeof value === "string") {
    return value.slice(0, 7);
  }
  if (value instanceof Date) {
    return value.toISOString().slice(0, 7);
  }
  throw new Error(`Invalid month value returned from database: ${String(value)}`);
}

function numberOrZero(value: unknown): number {
  const parsed =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function integerOrZero(value: unknown): number {
  return Math.round(numberOrZero(value));
}

function mapMonthlyDbRow(row: Record<string, unknown>): CoachUsageMonthlyRow {
  return {
    usageSubjectId: String(row.usage_subject_id ?? ""),
    month: normalizeMonthDateValue(row.month),
    workspaceId: String(row.workspace_id ?? ""),
    customerId: String(row.customer_id ?? ""),
    coachUserId:
      typeof row.coach_user_id === "string" && row.coach_user_id.trim()
        ? row.coach_user_id
        : undefined,
    planId: typeof row.plan_id === "string" && row.plan_id.trim() ? row.plan_id : undefined,
    activeCustomers: integerOrZero(row.active_customer_count),
    usageUnits: numberOrZero(row.usage_units),
    sessions: integerOrZero(row.session_count),
    retests: integerOrZero(row.retest_count),
    toolRuns: integerOrZero(row.tool_run_count),
    aiDeliveryCost: numberOrZero(row.ai_delivery_cost_eur),
    rawTokensTotal: integerOrZero(row.raw_total_tokens),
    source:
      row.source === "seed" || row.source === "backfill" || row.source === "openclaw"
        ? row.source
        : "openclaw",
    refreshedAt:
      typeof row.refreshed_at === "string"
        ? row.refreshed_at
        : row.refreshed_at instanceof Date
          ? row.refreshed_at.toISOString()
          : undefined,
  };
}

export class InMemoryCoachUsageStorage implements CoachUsageStorage {
  private monthlyRows = new Map<string, CoachUsageMonthlyRow>();

  async appendEvent(event: CoachUsageEvent): Promise<void> {
    aggregateMonthlyUsageRows([event]).forEach((row) => {
      const key = buildMonthlyStorageKey(row);
      const existing = this.monthlyRows.get(key);
      this.monthlyRows.set(key, mergeMonthlyRows(existing, row));
    });
  }

  async upsertMonthlyRows(rows: CoachUsageMonthlyRow[]): Promise<void> {
    rows.forEach((row) => {
      const key = buildMonthlyStorageKey(row);
      const normalized = cloneMonthlyRow({
        ...row,
        refreshedAt: row.refreshedAt || new Date().toISOString(),
      });
      this.monthlyRows.set(key, normalized);
    });
  }

  async listMonthlyUsage(query: CoachUsageMonthlyQuery): Promise<CoachUsageMonthlyQueryResult> {
    const groupBy = query.groupBy === "customer" ? "customer" : "month";
    const filtered = [...this.monthlyRows.values()]
      .filter((row) => {
        if (query.workspaceId && row.workspaceId !== query.workspaceId) {
          return false;
        }
        if (query.customerId && row.customerId !== query.customerId) {
          return false;
        }
        return withinMonthRange(row.month, query.from, query.to);
      })
      .sort((left, right) => (
        compareMonthKey(left.month, right.month)
        || left.customerId.localeCompare(right.customerId)
        || (left.coachUserId || "").localeCompare(right.coachUserId || "")
      ));

    const rows =
      groupBy === "month"
        ? aggregateRowsByMonth(filtered).map(cloneMonthlyRow)
        : aggregateRowsByCustomer(filtered).map(cloneMonthlyRow);

    return {
      from: query.from || null,
      to: query.to || null,
      workspaceId: query.workspaceId || null,
      groupBy,
      rows,
    };
  }

  async close(): Promise<void> {
    // no-op
  }
}

export function createInMemoryCoachUsageStorage(params?: {
  seedMonthlyRows?: CoachUsageMonthlyRow[];
}): CoachUsageStorage {
  const storage = new InMemoryCoachUsageStorage();
  if (params?.seedMonthlyRows?.length) {
    void storage.upsertMonthlyRows(params.seedMonthlyRows);
  }
  return storage;
}

async function withPgTransaction<T>(pool: PgPool, fn: (client: PgPoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (error) {
    try {
      await client.query("rollback");
    } catch {
      // ignore rollback failure
    }
    throw error;
  } finally {
    client.release();
  }
}

export class PostgresCoachUsageStorage implements CoachUsageStorage {
  private readonly poolPromise: Promise<PgPool>;
  private schemaPromise: Promise<void> | null = null;

  constructor(params: {
    databaseUrl: string;
    pool?: PgPool;
  }) {
    const databaseUrl = params.databaseUrl?.trim() || "";
    if (!databaseUrl && !params.pool) {
      throw new Error("PostgresCoachUsageStorage requires databaseUrl or pool");
    }
    this.poolPromise = params.pool
      ? Promise.resolve(params.pool)
      : loadPgPoolCtor().then(
          (Pool) =>
            new Pool({
              connectionString: databaseUrl,
              max: 5,
              idleTimeoutMillis: 10_000,
              connectionTimeoutMillis: 3_000,
            }),
        );
  }

  private async getPool(): Promise<PgPool> {
    return this.poolPromise;
  }

  private async ensureSchema(): Promise<void> {
    if (!this.schemaPromise) {
      this.schemaPromise = this.ensureSchemaImpl();
    }
    return this.schemaPromise;
  }

  private async ensureSchemaImpl(): Promise<void> {
    const pool = await this.getPool();
    await pool.query(`
      create table if not exists coach_usage_events (
        event_id text primary key,
        workspace_id text not null,
        customer_id text not null,
        coach_user_id text,
        session_id text,
        plan_id text,
        source_event_key text,
        event_type text not null,
        occurred_at timestamptz not null,
        provider text,
        model text,
        input_tokens integer not null default 0,
        output_tokens integer not null default 0,
        cache_read_tokens integer not null default 0,
        cache_write_tokens integer not null default 0,
        tool_runs integer not null default 0,
        retest_count integer not null default 0,
        raw_cost_eur numeric(12,6) not null default 0,
        billed_units numeric(12,4) not null default 0,
        metadata jsonb not null default '{}'::jsonb,
        inserted_at timestamptz not null default now()
      )
    `);
    await pool.query(`
      create unique index if not exists uq_coach_usage_events_source_event_key
      on coach_usage_events (source_event_key)
      where source_event_key is not null
    `);
    await pool.query(`
      create index if not exists idx_coach_usage_events_workspace_time
      on coach_usage_events (workspace_id, occurred_at desc)
    `);
    await pool.query(`
      create index if not exists idx_coach_usage_events_customer_time
      on coach_usage_events (customer_id, occurred_at desc)
    `);
    await pool.query(`
      create table if not exists coach_usage_monthly (
        usage_subject_id text not null,
        month date not null,
        workspace_id text not null,
        customer_id text not null,
        coach_user_id text,
        plan_id text,
        active_customer_count integer not null default 1,
        session_count integer not null default 0,
        retest_count integer not null default 0,
        tool_run_count integer not null default 0,
        usage_units numeric(12,4) not null default 0,
        ai_delivery_cost_eur numeric(12,6) not null default 0,
        raw_total_tokens bigint not null default 0,
        source text not null default 'openclaw',
        first_event_at timestamptz,
        last_event_at timestamptz,
        refreshed_at timestamptz not null default now(),
        primary key (usage_subject_id, month)
      )
    `);
    await pool.query(`
      create index if not exists idx_coach_usage_monthly_workspace_month
      on coach_usage_monthly (workspace_id, month)
    `);
    await pool.query(`
      create index if not exists idx_coach_usage_monthly_customer_month
      on coach_usage_monthly (customer_id, month desc)
    `);
  }

  private async upsertMonthlyRowsSnapshot(
    db: PgQueryable,
    rows: CoachUsageMonthlyRow[],
  ): Promise<void> {
    for (const row of rows) {
      await db.query(
        `
          insert into coach_usage_monthly (
            usage_subject_id,
            month,
            workspace_id,
            customer_id,
            coach_user_id,
            plan_id,
            active_customer_count,
            session_count,
            retest_count,
            tool_run_count,
            usage_units,
            ai_delivery_cost_eur,
            raw_total_tokens,
            source,
            refreshed_at
          )
          values (
            $1,
            to_date($2 || '-01', 'YYYY-MM-DD'),
            $3,
            $4,
            $5,
            $6,
            $7,
            $8,
            $9,
            $10,
            $11,
            $12,
            $13,
            $14,
            $15
          )
          on conflict (usage_subject_id, month) do update set
            workspace_id = excluded.workspace_id,
            customer_id = excluded.customer_id,
            coach_user_id = excluded.coach_user_id,
            plan_id = coalesce(excluded.plan_id, coach_usage_monthly.plan_id),
            active_customer_count = excluded.active_customer_count,
            session_count = excluded.session_count,
            retest_count = excluded.retest_count,
            tool_run_count = excluded.tool_run_count,
            usage_units = excluded.usage_units,
            ai_delivery_cost_eur = excluded.ai_delivery_cost_eur,
            raw_total_tokens = excluded.raw_total_tokens,
            source = excluded.source,
            refreshed_at = excluded.refreshed_at
        `,
        [
          row.usageSubjectId,
          row.month,
          row.workspaceId,
          row.customerId,
          row.coachUserId || null,
          row.planId || null,
          row.activeCustomers,
          row.sessions,
          row.retests,
          row.toolRuns,
          row.usageUnits,
          row.aiDeliveryCost,
          row.rawTokensTotal,
          row.source,
          row.refreshedAt || new Date().toISOString(),
        ],
      );
    }
  }

  private async applyMonthlyDelta(
    db: PgQueryable,
    row: CoachUsageMonthlyRow,
    occurredAtIso: string,
  ): Promise<void> {
    await db.query(
      `
        insert into coach_usage_monthly (
          usage_subject_id,
          month,
          workspace_id,
          customer_id,
          coach_user_id,
          plan_id,
          active_customer_count,
          session_count,
          retest_count,
          tool_run_count,
          usage_units,
          ai_delivery_cost_eur,
          raw_total_tokens,
          source,
          first_event_at,
          last_event_at,
          refreshed_at
        )
        values (
          $1,
          to_date($2 || '-01', 'YYYY-MM-DD'),
          $3,
          $4,
          $5,
          $6,
          $7,
          $8,
          $9,
          $10,
          $11,
          $12,
          $13,
          $14,
          $15::timestamptz,
          $15::timestamptz,
          $16
        )
        on conflict (usage_subject_id, month) do update set
          workspace_id = excluded.workspace_id,
          customer_id = excluded.customer_id,
          coach_user_id = coalesce(excluded.coach_user_id, coach_usage_monthly.coach_user_id),
          plan_id = coalesce(excluded.plan_id, coach_usage_monthly.plan_id),
          active_customer_count = greatest(coach_usage_monthly.active_customer_count, excluded.active_customer_count),
          session_count = coach_usage_monthly.session_count + excluded.session_count,
          retest_count = coach_usage_monthly.retest_count + excluded.retest_count,
          tool_run_count = coach_usage_monthly.tool_run_count + excluded.tool_run_count,
          usage_units = coach_usage_monthly.usage_units + excluded.usage_units,
          ai_delivery_cost_eur = coach_usage_monthly.ai_delivery_cost_eur + excluded.ai_delivery_cost_eur,
          raw_total_tokens = coach_usage_monthly.raw_total_tokens + excluded.raw_total_tokens,
          source = excluded.source,
          first_event_at = least(coalesce(coach_usage_monthly.first_event_at, excluded.first_event_at), excluded.first_event_at),
          last_event_at = greatest(coalesce(coach_usage_monthly.last_event_at, excluded.last_event_at), excluded.last_event_at),
          refreshed_at = excluded.refreshed_at
      `,
      [
        row.usageSubjectId,
        row.month,
        row.workspaceId,
        row.customerId,
        row.coachUserId || null,
        row.planId || null,
        row.activeCustomers,
        row.sessions,
        row.retests,
        row.toolRuns,
        row.usageUnits,
        row.aiDeliveryCost,
        row.rawTokensTotal,
        "openclaw",
        occurredAtIso,
        row.refreshedAt || new Date().toISOString(),
      ],
    );
  }

  async appendEvent(event: CoachUsageEvent): Promise<void> {
    await this.ensureSchema();
    const pool = await this.getPool();
    const occurredAtIso = normalizeOccurredAt(event.occurredAt);
    const deltaRows = aggregateMonthlyUsageRows([event]);
    if (deltaRows.length === 0) {
      return;
    }
    await withPgTransaction(pool, async (client) => {
      const inserted = await client.query(
        `
          insert into coach_usage_events (
            event_id,
            workspace_id,
            customer_id,
            coach_user_id,
            session_id,
            plan_id,
            source_event_key,
            event_type,
            occurred_at,
            provider,
            model,
            input_tokens,
            output_tokens,
            cache_read_tokens,
            cache_write_tokens,
            tool_runs,
            retest_count,
            raw_cost_eur,
            billed_units,
            metadata
          )
          values (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
            $11, $12, $13, $14, $15, $16, $17, $18, $19, $20::jsonb
          )
          on conflict (event_id) do nothing
        `,
        [
          event.eventId,
          event.workspaceId,
          event.customerId,
          event.coachUserId || null,
          event.sessionId || null,
          event.planId || null,
          event.sourceEventKey || null,
          event.eventType,
          occurredAtIso,
          event.provider || null,
          event.model || null,
          Math.round(numberOrZero(event.inputTokens)),
          Math.round(numberOrZero(event.outputTokens)),
          Math.round(numberOrZero(event.cacheReadTokens)),
          Math.round(numberOrZero(event.cacheWriteTokens)),
          Math.round(numberOrZero(event.toolRuns)),
          Math.round(numberOrZero(event.retestCount)),
          numberOrZero(event.rawCostEur),
          numberOrZero(event.billedUnits),
          JSON.stringify(event.metadata ?? {}),
        ],
      );
      if (!inserted.rowCount) {
        return;
      }
      for (const row of deltaRows) {
        await this.applyMonthlyDelta(client, row, occurredAtIso);
      }
    });
  }

  async upsertMonthlyRows(rows: CoachUsageMonthlyRow[]): Promise<void> {
    await this.ensureSchema();
    if (rows.length === 0) {
      return;
    }
    const pool = await this.getPool();
    await withPgTransaction(pool, async (client) => {
      await this.upsertMonthlyRowsSnapshot(client, rows);
    });
  }

  async listMonthlyUsage(query: CoachUsageMonthlyQuery): Promise<CoachUsageMonthlyQueryResult> {
    await this.ensureSchema();
    const pool = await this.getPool();
    const values: unknown[] = [];
    const where: string[] = [];
    if (query.workspaceId) {
      values.push(query.workspaceId);
      where.push(`workspace_id = $${values.length}`);
    }
    if (query.customerId) {
      values.push(query.customerId);
      where.push(`customer_id = $${values.length}`);
    }
    if (query.from) {
      values.push(`${query.from}-01`);
      where.push(`month >= $${values.length}::date`);
    }
    if (query.to) {
      values.push(`${query.to}-01`);
      where.push(`month <= $${values.length}::date`);
    }
    const result = await pool.query(
      `
        select
          usage_subject_id,
          month,
          workspace_id,
          customer_id,
          coach_user_id,
          plan_id,
          active_customer_count,
          session_count,
          retest_count,
          tool_run_count,
          usage_units,
          ai_delivery_cost_eur,
          raw_total_tokens,
          source,
          refreshed_at
        from coach_usage_monthly
        ${where.length > 0 ? `where ${where.join(" and ")}` : ""}
        order by month asc, customer_id asc, coalesce(coach_user_id, '') asc
      `,
      values,
    );
    const filtered = result.rows.map(mapMonthlyDbRow);
    const groupBy = query.groupBy === "customer" ? "customer" : "month";
    const rows =
      groupBy === "month"
        ? aggregateRowsByMonth(filtered).map(cloneMonthlyRow)
        : aggregateRowsByCustomer(filtered).map(cloneMonthlyRow);
    return {
      from: query.from || null,
      to: query.to || null,
      workspaceId: query.workspaceId || null,
      groupBy,
      rows,
    };
  }

  async close(): Promise<void> {
    const pool = await this.getPool();
    await pool.end();
  }
}

export async function createPostgresCoachUsageStorage(params: {
  databaseUrl: string;
}): Promise<CoachUsageStorage> {
  const storage = new PostgresCoachUsageStorage(params);
  await storage.listMonthlyUsage({ to: "1900-01", groupBy: "month" });
  return storage;
}

export async function createCoachUsageStorage(params?: {
  databaseUrl?: string;
  seedMonthlyRows?: CoachUsageMonthlyRow[];
  log?: {
    info?: (message: string) => void;
    warn?: (message: string) => void;
  };
}): Promise<CoachUsageStorage> {
  const databaseUrl = params?.databaseUrl?.trim() || process.env.DATABASE_URL?.trim();
  if (databaseUrl) {
    try {
      const storage = await createPostgresCoachUsageStorage({ databaseUrl });
      params?.log?.info?.("coach-usage storage: using Postgres");
      return storage;
    } catch (error) {
      params?.log?.warn?.(
        `coach-usage storage: failed to initialize Postgres, falling back to in-memory (${String(error)})`,
      );
    }
  } else {
    params?.log?.info?.("coach-usage storage: using in-memory fallback (no DATABASE_URL)");
  }
  return createInMemoryCoachUsageStorage({
    seedMonthlyRows: params?.seedMonthlyRows,
  });
}
