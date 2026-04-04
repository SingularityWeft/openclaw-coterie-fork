import type { CoachUsageEvent, CoachUsageMonthlyRow } from "./types.js";

function round(value: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function safeNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function normalizeMonthKey(value: string | Date): string {
  if (value instanceof Date) {
    const year = value.getUTCFullYear();
    const month = String(value.getUTCMonth() + 1).padStart(2, "0");
    return `${year}-${month}`;
  }
  const text = String(value || "").trim();
  const match =
    text.match(/^(?<year>\d{4})-(?<month>\d{2})/) ??
    text.match(/^(?<day>\d{2})\.(?<month>\d{2})\.(?<year>\d{4})$/);
  const year = match?.groups?.year;
  const month = match?.groups?.month;
  if (!year || !month) {
    throw new Error(`Invalid month value: ${text || "<empty>"}`);
  }
  return `${year}-${month}`;
}

export function compareMonthKey(left: string, right: string): number {
  return left.localeCompare(right);
}

export function buildUsageSubjectId(params: {
  customerId: string;
  coachUserId?: string;
}): string {
  const customerId = params.customerId.trim();
  const coachUserId = params.coachUserId?.trim();
  return coachUserId ? `${customerId}::${coachUserId}` : customerId;
}

export function buildMonthlyStorageKey(row: {
  usageSubjectId: string;
  month: string;
}): string {
  return `${row.usageSubjectId}@@${row.month}`;
}

export function aggregateMonthlyUsageRows(events: CoachUsageEvent[]): CoachUsageMonthlyRow[] {
  const rows = new Map<string, CoachUsageMonthlyRow>();
  events.forEach((event) => {
    const customerId = String(event.customerId || "").trim();
    const workspaceId = String(event.workspaceId || "").trim();
    if (!customerId || !workspaceId) {
      return;
    }
    const usageSubjectId = buildUsageSubjectId({
      customerId,
      coachUserId: event.coachUserId,
    });
    const month = normalizeMonthKey(event.occurredAt);
    const key = buildMonthlyStorageKey({ usageSubjectId, month });
    const existing = rows.get(key);
    const totalTokens =
      safeNumber(event.inputTokens)
      + safeNumber(event.outputTokens)
      + safeNumber(event.cacheReadTokens)
      + safeNumber(event.cacheWriteTokens);
    const next: CoachUsageMonthlyRow = existing ?? {
      usageSubjectId,
      month,
      workspaceId,
      customerId,
      coachUserId: event.coachUserId?.trim() || undefined,
      planId: event.planId?.trim() || undefined,
      activeCustomers: 1,
      usageUnits: 0,
      sessions: 0,
      retests: 0,
      toolRuns: 0,
      aiDeliveryCost: 0,
      rawTokensTotal: 0,
      source: "openclaw",
    };
    next.usageUnits = round(next.usageUnits + safeNumber(event.billedUnits));
    next.sessions += event.eventType === "session" ? 1 : 0;
    next.retests += event.eventType === "retest" ? Math.max(1, Math.round(safeNumber(event.retestCount) || 1)) : Math.round(safeNumber(event.retestCount));
    next.toolRuns += event.eventType === "tool_run" ? Math.max(1, Math.round(safeNumber(event.toolRuns) || 1)) : Math.round(safeNumber(event.toolRuns));
    next.aiDeliveryCost = round(next.aiDeliveryCost + safeNumber(event.rawCostEur), 6);
    next.rawTokensTotal += Math.round(totalTokens);
    next.planId ||= event.planId?.trim() || undefined;
    rows.set(key, next);
  });
  return [...rows.values()].sort((left, right) => (
    compareMonthKey(left.month, right.month)
    || left.customerId.localeCompare(right.customerId)
    || (left.coachUserId || "").localeCompare(right.coachUserId || "")
  ));
}

export function aggregateRowsByMonth(rows: CoachUsageMonthlyRow[]): CoachUsageMonthlyRow[] {
  const grouped = new Map<string, CoachUsageMonthlyRow>();
  rows.forEach((row) => {
    const existing = grouped.get(row.month);
    if (!existing) {
      grouped.set(row.month, {
        ...row,
        usageSubjectId: `month::${row.month}`,
        customerId: "*",
        coachUserId: undefined,
        planId: undefined,
      });
      return;
    }
    existing.activeCustomers += row.activeCustomers;
    existing.usageUnits = round(existing.usageUnits + row.usageUnits);
    existing.sessions += row.sessions;
    existing.retests += row.retests;
    existing.toolRuns += row.toolRuns;
    existing.aiDeliveryCost = round(existing.aiDeliveryCost + row.aiDeliveryCost, 6);
    existing.rawTokensTotal += row.rawTokensTotal;
  });
  return [...grouped.values()].sort((left, right) => compareMonthKey(left.month, right.month));
}

export function aggregateRowsByCustomer(rows: CoachUsageMonthlyRow[]): CoachUsageMonthlyRow[] {
  const grouped = new Map<string, CoachUsageMonthlyRow>();
  rows.forEach((row) => {
    const key = `${row.customerId}@@${row.month}`;
    const existing = grouped.get(key);
    if (!existing) {
      grouped.set(key, {
        ...row,
        usageSubjectId: `customer::${row.customerId}::${row.month}`,
        coachUserId: undefined,
        planId: undefined,
      });
      return;
    }
    existing.activeCustomers += row.activeCustomers;
    existing.usageUnits = round(existing.usageUnits + row.usageUnits);
    existing.sessions += row.sessions;
    existing.retests += row.retests;
    existing.toolRuns += row.toolRuns;
    existing.aiDeliveryCost = round(existing.aiDeliveryCost + row.aiDeliveryCost, 6);
    existing.rawTokensTotal += row.rawTokensTotal;
  });
  return [...grouped.values()].sort((left, right) => (
    compareMonthKey(left.month, right.month) || left.customerId.localeCompare(right.customerId)
  ));
}
