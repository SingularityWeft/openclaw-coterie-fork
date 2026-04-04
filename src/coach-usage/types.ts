export type CoachUsageEventType = "session" | "tool_run" | "retest" | "adjustment";

export type CoachUsageEvent = {
  eventId: string;
  occurredAt: string | Date;
  workspaceId: string;
  customerId: string;
  coachUserId?: string;
  sessionId?: string;
  planId?: string;
  sourceEventKey?: string;
  eventType: CoachUsageEventType;
  provider?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  toolRuns?: number;
  retestCount?: number;
  rawCostEur?: number;
  billedUnits?: number;
  metadata?: Record<string, unknown>;
};

export type CoachUsageMonthlyRow = {
  usageSubjectId: string;
  month: string;
  workspaceId: string;
  customerId: string;
  coachUserId?: string;
  planId?: string;
  activeCustomers: number;
  usageUnits: number;
  sessions: number;
  retests: number;
  toolRuns: number;
  aiDeliveryCost: number;
  rawTokensTotal: number;
  source: "openclaw" | "seed" | "backfill";
  refreshedAt?: string;
};

export type CoachUsageMonthlyQuery = {
  from?: string;
  to?: string;
  workspaceId?: string;
  customerId?: string;
  groupBy?: "month" | "customer";
};

export type CoachUsageMonthlyQueryResult = {
  from: string | null;
  to: string | null;
  workspaceId: string | null;
  groupBy: "month" | "customer";
  rows: CoachUsageMonthlyRow[];
};

export type CoachUsageStorage = {
  appendEvent: (event: CoachUsageEvent) => Promise<void>;
  upsertMonthlyRows: (rows: CoachUsageMonthlyRow[]) => Promise<void>;
  listMonthlyUsage: (query: CoachUsageMonthlyQuery) => Promise<CoachUsageMonthlyQueryResult>;
  close?: () => Promise<void>;
};
