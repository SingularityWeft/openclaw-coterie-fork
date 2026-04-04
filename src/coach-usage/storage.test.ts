import { describe, expect, it } from "vitest";
import { InMemoryCoachUsageStorage } from "./storage.js";

describe("InMemoryCoachUsageStorage", () => {
  it("accumulates event deltas within a month without double-counting active customers", async () => {
    const storage = new InMemoryCoachUsageStorage();

    await storage.appendEvent({
      eventId: "evt-1",
      occurredAt: "2026-04-03T10:00:00.000Z",
      workspaceId: "pbm-fit",
      customerId: "cust-1",
      coachUserId: "seat-a",
      eventType: "session",
      billedUnits: 12,
      rawCostEur: 3.2,
      inputTokens: 2000,
      outputTokens: 600,
      toolRuns: 1,
    });

    await storage.appendEvent({
      eventId: "evt-2",
      occurredAt: "2026-04-10T10:00:00.000Z",
      workspaceId: "pbm-fit",
      customerId: "cust-1",
      coachUserId: "seat-a",
      eventType: "tool_run",
      billedUnits: 4,
      rawCostEur: 0.8,
      inputTokens: 400,
      outputTokens: 100,
      toolRuns: 1,
    });

    const result = await storage.listMonthlyUsage({
      from: "2026-04",
      to: "2026-04",
      workspaceId: "pbm-fit",
      groupBy: "customer",
    });

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      month: "2026-04",
      customerId: "cust-1",
      activeCustomers: 1,
      usageUnits: 16,
      sessions: 1,
      toolRuns: 2,
      aiDeliveryCost: 4,
      rawTokensTotal: 3100,
    });
  });
});
