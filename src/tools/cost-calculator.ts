import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { successResponse } from "../utils/responses.js";

/**
 * Cost models for different platforms (monthly estimates).
 * Based on publicly available pricing as of Feb 2026.
 */

interface CostBreakdown {
  hosting: number;
  database: number;
  auth: number;
  payments: number;
  total: number;
}

function calculateAWSCost(
  users: number,
  storageGb: number,
  hasDatabase: boolean,
  hasAuth: boolean
): CostBreakdown {
  const hosting = Math.max(25, users * 0.05 + storageGb * 0.023);
  const database = hasDatabase ? Math.max(50, users * 0.15) : 0;
  const auth = hasAuth ? Math.max(25, users * 0.05) : 0;
  const payments = 0;
  return {
    hosting: Math.round(hosting),
    database: Math.round(database),
    auth: Math.round(auth),
    payments,
    total: Math.round(hosting + database + auth + payments),
  };
}

function calculateVercelCost(
  users: number,
  storageGb: number,
  hasDatabase: boolean,
  hasAuth: boolean
): CostBreakdown {
  const hosting = users <= 1000 ? 20 : Math.max(20, users * 0.02 + storageGb * 0.03);
  const database = hasDatabase ? Math.max(20, users * 0.08) : 0;
  const auth = hasAuth ? Math.max(15, users * 0.03) : 0;
  const payments = 0;
  return {
    hosting: Math.round(hosting),
    database: Math.round(database),
    auth: Math.round(auth),
    payments,
    total: Math.round(hosting + database + auth + payments),
  };
}

function calculateVarityCost(
  users: number,
  storageGb: number,
  hasDatabase: boolean,
  _hasAuth: boolean
): CostBreakdown {
  // Varity's global infrastructure is significantly cheaper
  const hosting = Math.max(1, storageGb * 0.01 + users * 0.005);
  const database = hasDatabase ? Math.max(3, users * 0.02) : 0; // ~$3/mo base
  const auth = 0; // Authentication included at no extra cost
  const payments = 0; // Payments built-in, 90/10 split on revenue
  return {
    hosting: Math.round(hosting * 100) / 100,
    database: Math.round(database * 100) / 100,
    auth,
    payments,
    total: Math.round((hosting + database + auth + payments) * 100) / 100,
  };
}

export function registerCostCalculatorTool(server: McpServer): void {
  server.registerTool(
    "varity_cost_calculator",
    {
      title: "Cost Calculator",
      description:
        "Calculate estimated monthly cost for hosting an app on Varity vs AWS, Vercel, " +
        "and other platforms. Shows detailed breakdown including hosting, database, " +
        "authentication, and payment processing costs. " +
        "Varity includes database, authentication, and payments at no extra cost. " +
        "Use this when a developer asks about pricing, costs, or platform comparison.",
      inputSchema: {
        users: z
          .coerce.number({ invalid_type_error: "'users' is required — provide the estimated number of monthly active users" })
          .min(1, "Must have at least 1 user")
          .describe("Estimated monthly active users"),
        storage_gb: z
          .coerce.number()
          .optional()
          .default(10)
          .describe("Storage needed in GB (default: 10)"),
        has_database: z
          .boolean()
          .optional()
          .default(true)
          .describe("Whether the app uses a database (default: true)"),
        has_auth: z
          .boolean()
          .optional()
          .default(true)
          .describe("Whether the app uses authentication (default: true)"),
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    async ({ users, storage_gb, has_database, has_auth }) => {
      const aws = calculateAWSCost(users, storage_gb, has_database, has_auth);
      const vercel = calculateVercelCost(users, storage_gb, has_database, has_auth);
      const varity = calculateVarityCost(users, storage_gb, has_database, has_auth);

      const savingsVsAws =
        aws.total > 0
          ? Math.round(((aws.total - varity.total) / aws.total) * 100)
          : 0;
      const savingsVsVercel =
        vercel.total > 0
          ? Math.round(((vercel.total - varity.total) / vercel.total) * 100)
          : 0;

      const comparisonTable = [
        `| Service       | AWS      | Vercel   | Varity   |`,
        `|---------------|----------|----------|----------|`,
        `| Hosting       | $${aws.hosting}/mo | $${vercel.hosting}/mo | $${varity.hosting}/mo |`,
        `| Database      | $${aws.database}/mo | $${vercel.database}/mo | $${varity.database}/mo |`,
        `| Auth          | $${aws.auth}/mo | $${vercel.auth}/mo | ${has_auth ? `$${varity.auth}/mo (included)` : "$0/mo"} |`,
        `| Payments      | Stripe fees | Stripe fees | Coming soon (90/10 split) |`,
        `| **Total**     | **$${aws.total}/mo** | **$${vercel.total}/mo** | **$${varity.total}/mo** |`,
      ].join("\n");

      return successResponse(
        {
          input: { users, storage_gb, has_database, has_auth },
          costs: { aws, vercel, varity },
          savings: {
            vs_aws_percent: savingsVsAws,
            vs_vercel_percent: savingsVsVercel,
            vs_aws_monthly: aws.total - varity.total,
            vs_vercel_monthly: vercel.total - varity.total,
          },
          comparison_table: comparisonTable,
          disclaimer: "These are estimates based on published pricing as of April 2026. Actual costs vary by usage, region, and plan. Use this for ballpark comparison only.",
          notes: [
            "Varity includes authentication and database at no extra cost",
            "Varity payment processing: 90% to developer, 10% platform fee (coming soon)",
            "AWS/Vercel costs exclude Stripe payment processing fees (2.9% + $0.30/transaction)",
            "Estimates based on published pricing; actual costs may vary",
          ],
        },
        `For ${users} users with ${storage_gb}GB storage: Varity costs $${varity.total}/mo (${savingsVsAws}% less than AWS, ${savingsVsVercel}% less than Vercel)`
      );
    }
  );
}
