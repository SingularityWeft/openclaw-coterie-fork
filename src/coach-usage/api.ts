import type { IncomingMessage, ServerResponse } from "node:http";
import { authorizeGatewayConnect, type ResolvedGatewayAuth } from "../gateway/auth.js";
import {
  sendInvalidRequest,
  sendJson,
  sendMethodNotAllowed,
  sendUnauthorized,
} from "../gateway/http-common.js";
import { getBearerToken } from "../gateway/http-utils.js";
import type { CoachUsageMonthlyRow, CoachUsageStorage } from "./types.js";

export type CoachUsageHttpRequestHandler = (
  req: IncomingMessage,
  res: ServerResponse,
) => Promise<boolean>;

function parseMonthParam(value: string | null): string | undefined {
  if (!value) {
    return undefined;
  }
  const text = value.trim();
  if (!text) {
    return undefined;
  }
  if (!/^\d{4}-\d{2}$/.test(text)) {
    throw new Error(`Invalid month parameter: ${text}`);
  }
  return text;
}

function serializeMonthlyRow(row: CoachUsageMonthlyRow) {
  return {
    month: row.month,
    workspace_id: row.workspaceId,
    customer_id: row.customerId === "*" ? undefined : row.customerId,
    coach_user_id: row.coachUserId,
    plan_id: row.planId,
    active_customers: row.activeCustomers,
    usage_units: row.usageUnits,
    sessions: row.sessions,
    retests: row.retests,
    tool_runs: row.toolRuns,
    ai_delivery_cost: row.aiDeliveryCost,
    raw_tokens_total: row.rawTokensTotal,
    source: row.source,
  };
}

export function createCoachUsageHttpRequestHandler(params: {
  auth: ResolvedGatewayAuth;
  storage: CoachUsageStorage;
  trustedProxies?: string[];
}): CoachUsageHttpRequestHandler {
  const { auth, storage, trustedProxies } = params;
  return async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (url.pathname !== "/api/v1/coach-usage/monthly") {
      return false;
    }

    if (req.method !== "GET") {
      sendMethodNotAllowed(res, "GET");
      return true;
    }

    const token = getBearerToken(req);
    const authResult = await authorizeGatewayConnect({
      auth,
      connectAuth: token ? { token, password: token } : null,
      req,
      trustedProxies,
    });
    if (!authResult.ok) {
      sendUnauthorized(res);
      return true;
    }

    try {
      const from = parseMonthParam(url.searchParams.get("from"));
      const to = parseMonthParam(url.searchParams.get("to"));
      const workspaceId = url.searchParams.get("workspace_id")?.trim() || undefined;
      const customerId = url.searchParams.get("customer_id")?.trim() || undefined;
      const groupBy = url.searchParams.get("group_by") === "customer" ? "customer" : "month";

      if (from && to && from > to) {
        sendInvalidRequest(res, "from must be less than or equal to to");
        return true;
      }

      const result = await storage.listMonthlyUsage({
        from,
        to,
        workspaceId,
        customerId,
        groupBy,
      });

      sendJson(res, 200, {
        from: result.from,
        to: result.to,
        workspace_id: result.workspaceId,
        group_by: result.groupBy,
        rows: result.rows.map(serializeMonthlyRow),
      });
      return true;
    } catch (error) {
      sendInvalidRequest(res, error instanceof Error ? error.message : "Invalid request");
      return true;
    }
  };
}
