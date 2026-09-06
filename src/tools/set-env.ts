import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { successResponse, errorResponse } from "../utils/responses.js";
import { execVaritykit, lifecycleTracking } from "../utils/cli-bridge.js";

export function registerSetEnvTool(server: McpServer): void {
  server.registerTool(
    "varity_set_env",
    {
      annotations: { destructiveHint: true },
      title: "Set Environment Variables on an Existing Deployment",
      description:
        "Set or update environment variables (config + secrets) on an app that is ALREADY deployed, " +
        "then redeploy it in place. Use this when a developer says 'add an env var to <name>', " +
        "'change the API key on <name>', 'set DATABASE_URL on my app', or 'update the config and redeploy'. " +
        "The variables are applied to the SAME deployment and app URL. " +
        "The tool returns the durable run used to track the terminal outcome. By default the new variables are " +
        "MERGED over the existing set; pass replace=true to overwrite the entire set. Variable values are " +
        "write-only and are never echoed back. To create a NEW deployment instead, use varity_deploy.",
      inputSchema: {
        name: z
          .string()
          .describe(
            "The subdomain / app name of the existing deployment to update, the slug in https://varity.app/<name>/. Example: 'my-api'."
          ),
        env: z
          .record(z.string(), z.string())
          .describe(
            "Environment variables to set as a map of NAME to value, e.g. { \"DATABASE_URL\": \"postgres://...\", \"FEATURE_X\": \"on\" }. " +
              "Names must be UPPER_SNAKE_CASE."
          ),
        replace: z
          .boolean()
          .optional()
          .describe(
            "When true, replace the entire variable set with `env` instead of merging it over the current set. Default false (merge)."
          ),
      },
    },
    async ({ name, env, replace }) => {
      if (!name || !name.trim()) {
        return errorResponse(
          "MISSING_NAME",
          "Deployment name is required.",
          "Ask the user for the app name they want to update. It is the slug in their varity.app URL."
        );
      }
      const entries = Object.entries(env ?? {});
      if (entries.length === 0) {
        return errorResponse(
          "MISSING_ENV",
          "At least one environment variable is required.",
          "Ask the user which variable(s) to set, e.g. DATABASE_URL or an API key."
        );
      }

      // Enforce the documented UPPER_SNAKE_CASE rule before building argv, and reject the
      // app name if it could be read as a flag, so no key/name can smuggle a CLI flag
      // (argv flag injection). The gateway validates again server-side (defense in depth).
      const KEY_RE = /^[A-Z_][A-Z0-9_]*$/;
      for (const [k] of entries) {
        if (!KEY_RE.test(k)) {
          return errorResponse(
            "INVALID_KEY",
            `Invalid env var name: "${k}".`,
            "Names must be UPPER_SNAKE_CASE (e.g. DATABASE_URL, FEATURE_X)."
          );
        }
      }
      if (name.startsWith("-")) {
        return errorResponse("INVALID_NAME", `Invalid app name: "${name}".`, "App names can't start with '-'.");
      }

      // `--` stops the CLI's flag parsing so positionals (name + KEY=VALUE pairs) are never
      // interpreted as flags, even if a value contains leading dashes.
      const pairs = entries.map(([k, v]) => `${k}=${v}`);
      const args = ["env", ...(replace ? ["--replace"] : []), "--", name, ...pairs];

      const result = await execVaritykit("app", args, { timeout: 120_000 });

      if (result.exitCode === 0) {
        const keys = entries.map(([k]) => k).sort();
        const tracking = lifecycleTracking(result.stdout);
        return successResponse(
          {
            name,
            updated_keys: keys,
            replaced: Boolean(replace),
            status: tracking.runId ? "redeploying" : "outcome_unconfirmed",
            run_id: tracking.runId,
            status_command: tracking.statusCommand,
          },
          `Updated ${keys.length} variable(s) on "${name}" (${keys.join(", ")}). ` +
            (tracking.statusCommand
              ? `Redeploy accepted on the same app URL. Track its terminal outcome with: ${tracking.statusCommand}. `
              : "The command returned success without a durable tracking reference, so the terminal outcome is not proven. Upgrade varitykit and inspect varity_deploy_status before retrying. ") +
            "Values are not shown back for security."
        );
      }

      const errorOutput = (result.stderr || result.stdout || "").trim();
      if (errorOutput.toLowerCase().includes("not found") || errorOutput.toLowerCase().includes("404")) {
        return errorResponse(
          "DEPLOYMENT_NOT_FOUND",
          `No deployment found with name "${name}".`,
          'Check the exact name at https://varity.app/dashboard, or run "varitykit app list" to see active deployments.'
        );
      }
      return errorResponse(
        "ENV_UPDATE_FAILED",
        `Could not update environment variables on "${name}".`,
        errorOutput || "Try again in a moment, or confirm the app is a dynamic deployment that supports env editing."
      );
    }
  );
}
