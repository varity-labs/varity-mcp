import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { successResponse, errorResponse } from "../utils/responses.js";
import { INFRASTRUCTURE } from "../utils/config.js";

const GATEWAY_URL = INFRASTRUCTURE.GATEWAY;

export function registerWorldModelDeployPatternsTool(server: McpServer): void {
  server.registerTool(
    "world_model_deploy_patterns",
    {
      title: "World Model: Deploy Patterns",
      description:
        "Query deployment telemetry from the World Model to discover patterns. " +
        "Returns framework breakdown, success rates, cold-start averages, Vercel migration stats, " +
        "and user override rates. Use this to answer questions like " +
        '"how have similar Next.js+Prisma+Postgres repos deployed?" or ' +
        '"what is the success rate for Python apps?"',
      inputSchema: {
        framework: z
          .string()
          .optional()
          .describe(
            "Filter by detected framework (e.g. nextjs, react, express, fastapi, django). Omit for all."
          ),
        success: z
          .boolean()
          .optional()
          .describe(
            "Filter by deploy outcome. true = successful only, false = failures only. Omit for all."
          ),
        limit: z
          .coerce.number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .default(100)
          .describe("Max events to query (default 100, max 500)"),
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    async ({ framework, success, limit }) => {
      try {
        const params = new URLSearchParams();
        if (framework) params.set("framework", framework);
        if (success !== undefined) params.set("success", String(success));
        if (limit) params.set("limit", String(limit));

        const url = `${GATEWAY_URL}/api/telemetry/deploy/patterns?${params}`;
        const res = await fetch(url, {
          signal: AbortSignal.timeout(15000),
        });

        if (!res.ok) {
          const errText = await res.text();
          return errorResponse(
            "QUERY_FAILED",
            `Failed to query deploy patterns: ${res.status}`,
            errText
          );
        }

        const data = (await res.json()) as {
          totalEvents: number;
          frameworkBreakdown: Record<
            string,
            {
              total: number;
              success: number;
              avgColdStartMs: number;
              coldStartSamples: number;
            }
          >;
          vercelMigrations: number;
          overrideRate: number;
          events: unknown[];
        };

        const patterns: string[] = [];
        for (const [fw, stats] of Object.entries(data.frameworkBreakdown)) {
          const successRate = stats.total > 0
            ? Math.round((stats.success / stats.total) * 100)
            : 0;
          const coldStart = stats.coldStartSamples > 0
            ? `${stats.avgColdStartMs}ms avg cold start`
            : "no cold-start data";
          patterns.push(
            `${fw}: ${stats.total} deploys, ${successRate}% success, ${coldStart}`
          );
        }

        const summary = [
          `${data.totalEvents} total deploy events`,
          ...(framework ? [`filtered to framework: ${framework}`] : []),
          `${data.vercelMigrations} Vercel migrations`,
          `${data.overrideRate}% framework override rate`,
          ...patterns,
        ].join(". ");

        return successResponse(
          {
            totalEvents: data.totalEvents,
            frameworkBreakdown: data.frameworkBreakdown,
            vercelMigrations: data.vercelMigrations,
            overrideRate: data.overrideRate,
            patterns,
          },
          summary
        );
      } catch (err) {
        return errorResponse(
          "NETWORK_ERROR",
          err instanceof Error ? err.message : "Failed to reach gateway",
          "Ensure the Varity Gateway is running and accessible."
        );
      }
    }
  );
}
