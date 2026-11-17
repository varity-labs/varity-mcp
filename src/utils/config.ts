import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const VARITYKIT_CONFIG_DIR = join(homedir(), ".varitykit");
const VARITYKIT_CONFIG_FILE = join(VARITYKIT_CONFIG_DIR, "config.json");

/** Where the deploy key came from; reported by varity_doctor, never the key itself. */
export type DeployKeySource = "env:VARITY_DEPLOY_KEY" | "config:~/.varitykit/config.json" | "env:VARITY_API_KEY";

/**
 * Resolve the deploy key in this order:
 *   1. env `VARITY_DEPLOY_KEY` (the override)
 *   2. the CLI sign-in file `~/.varitykit/config.json`: `deploy_key`, then `api_key`
 *   3. env `VARITY_API_KEY` (legacy alias)
 * WHY: the public AI Gateway docs use `VARITY_API_KEY` for the inference key,
 * so an exported inference key read first refused every deploy with 403 even
 * when a deploy key was configured.
 */
export async function resolveDeployKey(): Promise<{ key: string; source: DeployKeySource } | null> {
  const deployEnv = process.env["VARITY_DEPLOY_KEY"];
  if (deployEnv) return { key: deployEnv, source: "env:VARITY_DEPLOY_KEY" };

  try {
    const config = JSON.parse(await readFile(VARITYKIT_CONFIG_FILE, "utf-8"));
    const configKey = config.deploy_key ?? config.api_key;
    if (typeof configKey === "string" && configKey) {
      return { key: configKey, source: "config:~/.varitykit/config.json" };
    }
  } catch {
    // Config file doesn't exist or invalid JSON
  }

  const legacyEnv = process.env["VARITY_API_KEY"];
  if (legacyEnv) return { key: legacyEnv, source: "env:VARITY_API_KEY" };
  return null;
}

/** The deploy key from `resolveDeployKey`, or null. */
export async function getApiKey(): Promise<string | null> {
  return (await resolveDeployKey())?.key ?? null;
}

/**
 * Check if user is authenticated (has API key or beta key).
 */
export async function isAuthenticated(): Promise<boolean> {
  const key = await getApiKey();
  return key !== null;
}

/**
 * Infrastructure endpoints (all LIVE).
 */
export const INFRASTRUCTURE = {
  GATEWAY: process.env["VARITY_GATEWAY_URL"] ?? "https://varity.app",
  DOCS: "https://docs.varity.so",
  DEVELOPER_PORTAL: "https://developer.store.varity.so",
  /** Where a user lists and manages deployments. `varity.app/dashboard` is a 404 (evidence p2-cli-mcp D7). */
  DASHBOARD: "https://developer.store.varity.so/dashboard",
} as const;
