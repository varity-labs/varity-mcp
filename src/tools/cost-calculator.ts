import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { successResponse, errorResponse } from "../utils/responses.js";
import { INFRASTRUCTURE } from "../utils/config.js";

/**
 * varity_cost_calculator, THIN CLIENT.
 *
 * All pricing logic + the single source of truth lives in the gateway
 * (`GET /api/pricing`). This tool calls it so the MCP terminal output and the
 * developer-portal deploy page render the IDENTICAL computation, no
 * duplicated pricing numbers anywhere.
 *
 * The point this tool makes memorable: Varity charges ONLY for hardware and
 * the price is FLAT. It doesn't spike with traffic the way usage-metered
 * hosting (bandwidth + invocation metered) does. Varity's price is flat and
 * doesn't move as the app grows, and uniquely runs everything including GPU.
 */

const PROFILE_KEYS = [
  "static-site",
  "web-app",
  "web-app-db",
  "ai-agent-cpu",
  "ai-agent-gpu",
] as const;

export function registerCostCalculatorTool(server: McpServer): void {
  server.registerTool(
    "varity_cost_calculator",
    {
      title: "Cost Calculator",
      description:
        "Compare a deployment's flat monthly Varity cost against usage-metered hosting " +
        "(bandwidth + invocations). " +
        "Varity charges a FLAT hardware-only price that doesn't spike with traffic; " +
        "usage-metered hosting bills grow as the app scales. Varity's price is fixed " +
        "and doesn't move as the app grows. " +
        "Use whenever a developer asks about pricing, cost, hosting bills, traffic " +
        "costs, or platform comparison. Pass `subdomain` for a specific live " +
        "deployment's REAL cost, or `app_profile` for a pre-deploy estimate.",
      inputSchema: {
        app_profile: z
          .enum(PROFILE_KEYS)
          .optional()
          .default("web-app")
          .describe(
            "Pre-deploy estimate preset. Accepted values: static-site, web-app, web-app-db, ai-agent-cpu, ai-agent-gpu. Estimates are computed by the live Varity pricing API."
          ),
        subdomain: z
          .string()
          .optional()
          .describe(
            "A live deployment's subdomain → returns THIS deployment's real cost (overrides app_profile)"
          ),
        has_database: z
          .boolean()
          .optional()
          .describe("Whether the app uses a database (affects competitor base cost)"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ app_profile, subdomain, has_database }) => {
      const qs = new URLSearchParams();
      if (subdomain) qs.set("subdomain", subdomain);
      else qs.set("profile", app_profile || "web-app");
      if (has_database !== undefined) qs.set("has_db", String(has_database));

      const url = `${INFRASTRUCTURE.GATEWAY}/api/pricing?${qs.toString()}`;

      let data: Record<string, unknown>;
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);
        const res = await fetch(url, { signal: controller.signal });
        clearTimeout(timeout);
        if (!res.ok) {
          return errorResponse(
            "pricing_unavailable",
            `Pricing service returned ${res.status}.`,
            "Try again shortly, or check status at varity.app."
          );
        }
        data = (await res.json()) as Record<string, unknown>;
      } catch {
        return errorResponse(
          "pricing_unreachable",
          "Could not reach the Varity pricing service.",
          "Check your connection and retry, pricing is computed server-side so numbers stay consistent everywhere."
        );
      }

      const v = data.varityMonthly as number;
      const fmt = (n: number) => `$${Number(n).toLocaleString("en-US")}`;
      const comps = (data.competitors as Array<{
        label: string;
        atLaunch: number;
        atTraction: number;
      }>) ?? [];

      const summary = comps.length
        ? `${subdomain ?? app_profile}: Varity is a flat ${fmt(v)}/mo, and stays there. ${
            (data.best as { label: string; pct: number } | undefined)?.label
          } is ${
            (data.best as { label: string; pct: number } | undefined)?.pct
          }% more at launch and the gap widens with traffic. ${data.aha as string}`
        : `${subdomain ?? app_profile}: Varity is a flat ${fmt(v)}/mo. ${data.aha as string}`;

      return successResponse(
        {
          source: "gateway:/api/pricing (single source of truth)",
          input: { app_profile, subdomain, has_database },
          ...data,
        },
        summary
      );
    }
  );
}
