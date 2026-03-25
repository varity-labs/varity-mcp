import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const VARITYKIT_CONFIG_DIR = join(homedir(), ".varitykit");
const VARITYKIT_CONFIG_FILE = join(VARITYKIT_CONFIG_DIR, "config.json");
const DEPLOYMENTS_DIR = join(VARITYKIT_CONFIG_DIR, "deployments");

/**
 * Get the API key (deploy key) from config file or environment variable.
 * The CLI stores config as JSON: { "deploy_key": "..." }
 */
export async function getApiKey(): Promise<string | null> {
  // Check env var first
  const envKey = process.env["VARITY_API_KEY"];
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
 * Get path to deployments directory.
 */
export function getDeploymentsDir(): string {
  return DEPLOYMENTS_DIR;
}

/**
 * Get path to varitykit config directory.
 */
export function getConfigDir(): string {
  return VARITYKIT_CONFIG_DIR;
}

/**
 * Infrastructure endpoints (all LIVE).
 */
export const INFRASTRUCTURE = {
  GATEWAY: "https://varity.app",
  DOCS: "https://docs.varity.so",
  APP_STORE: "https://store.varity.so",
  DEVELOPER_PORTAL: "https://developer.store.varity.so",
} as const;
