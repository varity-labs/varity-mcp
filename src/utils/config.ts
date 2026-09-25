import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const VARITYKIT_CONFIG_DIR = join(homedir(), ".varitykit");
const VARITYKIT_CONFIG_FILE = join(VARITYKIT_CONFIG_DIR, "config.json");

/**
 * Get the API key (deploy key) from config file or environment variable.
 * The CLI stores config as JSON: { "deploy_key": "..." }
 */
export async function getApiKey(): Promise<string | null> {
  // Check env var first
  const envKey = process.env["VARITY_API_KEY"] ?? process.env["VARITY_DEPLOY_KEY"];
  if (envKey) return envKey;

  // Check config file (JSON format, matches CLI's auth.py)
  try {
    const configContent = await readFile(VARITYKIT_CONFIG_FILE, "utf-8");
    const config = JSON.parse(configContent);
    return config.deploy_key ?? config.api_key ?? null;
  } catch {
    // Config file doesn't exist or invalid JSON
  }

  return null;
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
