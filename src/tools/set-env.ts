import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorResponse, successResponse } from "../utils/responses.js";
import { getDeployment, updateDeploymentEnv, VarityPublicApiError } from "../utils/public-api.js";
import { INFRASTRUCTURE } from "../utils/endpoints.js";
import { withoutValues } from "../utils/redact.js";
import { ENV_KEY, readProjectEnv } from "./env-file.js";

/** Said before and after every env change: it restarts the app (V9-1/V9-3). */
export const RESTART_NOTE =
  "Your app restarts to use the new settings; a restart sets aside another monthly maximum until it settles.";

/**
 * `varity_set_env` (stdio only): reads the named settings from the project's
 * own `.env` file on the user's machine and sends them in ONE
 * `PATCH /api/deployments/:id/env` (merge, never `replace`). The change
 * restarts the app. No value ever appears in a tool argument, response,
 * error, log or telemetry; only names and counts do. A request that may or
 * may not have arrived (timeout) is never resent: the tool reads the
 * deployment's status instead, because a resend is a second restart.
 */
export async function setEnv(deployment: string, projectPath: string, envFile: string, keys: string[]) {
  const read = await readProjectEnv(projectPath, envFile, keys);
  if (!read.ok) return read.response;
  return withoutValues(await sendEnv(deployment, read.env, keys), Object.values(read.env));
}

async function sendEnv(deployment: string, env: Record<string, string>, keys: string[]) {
  try {
    const accepted = await updateDeploymentEnv(deployment, env);
    const count = keys.length;
    return successResponse(
      {
        deployment,
        keys_set: [...keys].sort(),
        count,
        status: accepted.status ?? null,
        run_id: accepted.run_id ?? null,
        total_keys: accepted.env?.count ?? null,
      },
      `Saved ${count} setting${count === 1 ? "" : "s"} (${[...keys].sort().join(", ")}) on ${deployment}. ${RESTART_NOTE} ` +
        "Check progress with varity_deploy_status."
    );
  } catch (err) {
    if (err instanceof VarityPublicApiError && err.code === "VARITY_API_UNREACHABLE") {
      let state = "unknown";
      try {
        state = (await getDeployment(deployment)).status ?? "unknown";
      } catch {
        // The status read is best effort; the message below still says not to resend.
      }
      return errorResponse(
        "ENV_UPDATE_UNCONFIRMED",
        `Varity did not answer in time, so it is not known whether the settings arrived. The app's status is now: ${state}.`,
        "Do not send the settings again yet: call varity_deploy_status first. If the app is restarting, they arrived; only resend if it shows no restart."
      );
    }
    if (err instanceof VarityPublicApiError && err.code === "approval_required") {
      return errorResponse(
        err.code,
        "Varity needs the account owner's approval before it changes an app's settings, so nothing was changed.",
        `Set these values from the app's page in the Varity dashboard at ${INFRASTRUCTURE.DASHBOARD}.`
      );
    }
    if (err instanceof VarityPublicApiError) {
      return errorResponse(err.code, err.message, err.action ?? "Check the deployment with varity_deploy_status, then retry.");
    }
    return errorResponse("ENV_UPDATE_FAILED", "The settings could not be saved.", "Check the deployment with varity_deploy_status, then retry.");
  }
}

export function registerSetEnvTool(server: McpServer): void {
  server.registerTool(
    "varity_set_env",
    {
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      title: "Set App Settings From .env",
      description:
        "Set environment variables (settings such as API keys) on a deployed app from the project's own .env file. " +
        "Pass the app, the project folder and the setting NAMES; the values are read from the file on this computer and " +
        "never go through chat. Never ask the user to type a value into chat: ask them to put it in .env. " +
        "This restarts the app, and a restart sets aside another monthly maximum until it settles, so tell the user before calling. " +
        "Call it once; do not repeat it on a timeout (check varity_deploy_status instead).",
      inputSchema: {
        deployment: z
          .string()
          .regex(/^[a-zA-Z0-9_-]+$/, "Invalid deployment id or app name")
          .describe("The deployment id or app name to change."),
        path: z
          .string()
          .describe("Absolute path to the app's project folder (the folder that holds its .env file)."),
        keys: z
          .array(z.string().regex(ENV_KEY, "Setting names are UPPER_SNAKE_CASE, e.g. OPENAI_API_KEY"))
          .min(1)
          .max(100)
          .describe("Names of the settings to send, e.g. [\"OPENAI_API_KEY\"]. Names only, never values."),
        env_file: z
          .string()
          .optional()
          .default(".env")
          .describe("The settings file inside the project folder (default .env). Example files such as .env.example hold names only and are refused as a value source."),
      },
    },
    async ({ deployment, path, keys, env_file }) => setEnv(deployment, path, env_file ?? ".env", [...new Set(keys)])
  );
}
