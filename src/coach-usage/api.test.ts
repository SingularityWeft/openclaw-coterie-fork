import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { createCoachUsageHttpRequestHandler } from "./api.js";
import { createInMemoryCoachUsageStorage } from "./storage.js";

const makeResponse = (): {
  res: ServerResponse;
  setHeader: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
} => {
  const setHeader = vi.fn();
  const end = vi.fn();
  const res = {
    headersSent: false,
    statusCode: 200,
    setHeader,
    end,
  } as unknown as ServerResponse;
  return { res, setHeader, end };
};

function parseResponseBody(end: ReturnType<typeof vi.fn>): unknown {
  const firstCall = end.mock.calls[0]?.[0];
  return typeof firstCall === "string" ? JSON.parse(firstCall) : null;
}

describe("createCoachUsageHttpRequestHandler", () => {
  it("returns false for unrelated paths", async () => {
    const handler = createCoachUsageHttpRequestHandler({
      auth: { mode: "token", token: "secret", allowTailscale: false },
      storage: createInMemoryCoachUsageStorage(),
    });
    const { res } = makeResponse();
    const handled = await handler(
      {
        method: "GET",
        url: "/not-coach-usage",
        headers: { host: "localhost", authorization: "Bearer secret" },
      } as IncomingMessage,
      res,
    );
    expect(handled).toBe(false);
  });

  it("serves grouped monthly rows for authorized requests", async () => {
    const storage = createInMemoryCoachUsageStorage({
      seedMonthlyRows: [
        {
          usageSubjectId: "cust-1",
          month: "2026-04",
          workspaceId: "pbm-fit",
          customerId: "cust-1",
          planId: "coach_standard",
          activeCustomers: 1,
          usageUnits: 48,
          sessions: 10,
          retests: 1,
          toolRuns: 6,
          aiDeliveryCost: 18.4,
          rawTokensTotal: 82000,
          source: "seed",
        },
        {
          usageSubjectId: "cust-2",
          month: "2026-04",
          workspaceId: "pbm-fit",
          customerId: "cust-2",
          planId: "coach_standard",
          activeCustomers: 1,
          usageUnits: 36,
          sessions: 8,
          retests: 1,
          toolRuns: 5,
          aiDeliveryCost: 13,
          rawTokensTotal: 46300,
          source: "seed",
        },
      ],
    });
    const handler = createCoachUsageHttpRequestHandler({
      auth: { mode: "token", token: "secret", allowTailscale: false },
      storage,
    });

    const { res, end } = makeResponse();
    const handled = await handler(
      {
        method: "GET",
        url: "/api/v1/coach-usage/monthly?from=2026-04&to=2026-04&workspace_id=pbm-fit",
        headers: { host: "localhost", authorization: "Bearer secret" },
        socket: { remoteAddress: "127.0.0.1" },
      } as unknown as IncomingMessage,
      res,
    );

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    const body = parseResponseBody(end) as {
      rows: Array<Record<string, unknown>>;
      group_by: string;
    };
    expect(body.group_by).toBe("month");
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]).toMatchObject({
      month: "2026-04",
      active_customers: 2,
      usage_units: 84,
      sessions: 18,
      retests: 2,
      tool_runs: 11,
      ai_delivery_cost: 31.4,
    });
  });

  it("supports group_by=customer for customer-month drilldowns", async () => {
    const storage = createInMemoryCoachUsageStorage({
      seedMonthlyRows: [
        {
          usageSubjectId: "cust-1::seat-a",
          month: "2026-04",
          workspaceId: "pbm-fit",
          customerId: "cust-1",
          coachUserId: "seat-a",
          activeCustomers: 1,
          usageUnits: 30,
          sessions: 6,
          retests: 1,
          toolRuns: 4,
          aiDeliveryCost: 11,
          rawTokensTotal: 38000,
          source: "seed",
        },
        {
          usageSubjectId: "cust-1::seat-b",
          month: "2026-04",
          workspaceId: "pbm-fit",
          customerId: "cust-1",
          coachUserId: "seat-b",
          activeCustomers: 1,
          usageUnits: 18,
          sessions: 4,
          retests: 0,
          toolRuns: 2,
          aiDeliveryCost: 7.5,
          rawTokensTotal: 21000,
          source: "seed",
        },
      ],
    });
    const handler = createCoachUsageHttpRequestHandler({
      auth: { mode: "token", token: "secret", allowTailscale: false },
      storage,
    });
    const { res, end } = makeResponse();
    const handled = await handler(
      {
        method: "GET",
        url: "/api/v1/coach-usage/monthly?from=2026-04&to=2026-04&workspace_id=pbm-fit&group_by=customer",
        headers: { host: "localhost", authorization: "Bearer secret" },
        socket: { remoteAddress: "127.0.0.1" },
      } as unknown as IncomingMessage,
      res,
    );
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    const body = parseResponseBody(end) as {
      rows: Array<Record<string, unknown>>;
      group_by: string;
    };
    expect(body.group_by).toBe("customer");
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]).toMatchObject({
      month: "2026-04",
      customer_id: "cust-1",
      active_customers: 2,
      usage_units: 48,
      sessions: 10,
      tool_runs: 6,
      ai_delivery_cost: 18.5,
    });
  });

  it("returns 401 for unauthorized requests", async () => {
    const handler = createCoachUsageHttpRequestHandler({
      auth: { mode: "token", token: "secret", allowTailscale: false },
      storage: createInMemoryCoachUsageStorage(),
    });
    const { res } = makeResponse();
    const handled = await handler(
      {
        method: "GET",
        url: "/api/v1/coach-usage/monthly",
        headers: { host: "localhost", authorization: "Bearer wrong" },
      } as IncomingMessage,
      res,
    );
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(401);
  });
});
