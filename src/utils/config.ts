import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const VARITYKIT_CONFIG_DIR = join(homedir(), ".varitykit");
const VARITYKIT_CONFIG_FILE = join(VARITYKIT_CONFIG_DIR, "config");
const DEPLOYMENTS_DIR = join(VARITYKIT_CONFIG_DIR, "deployments");

/**
 * Get the API key from config file or environment variable.
 */
export async function getApiKey(): Promise<string | null> {
  // Check env var first
  const envKey = process.env["VARITY_API_KEY"];
  if (envKey) return envKey;

  // Check config file
  try {
    const configContent = await readFile(VARITYKIT_CONFIG_FILE, "utf-8");
    const lines = configContent.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("api_key=") || trimmed.startsWith("api_key =")) {
        return trimmed.split("=")[1]?.trim() ?? null;
      }
    }
  } catch {
    // Config file doesn't exist
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
 * Public-facing infrastructure endpoints.
 */
export const INFRASTRUCTURE = {
  DOCS: "https://docs.varity.so",
  APP_STORE: "https://store.varity.so",
  DEVELOPER_PORTAL: "https://developer.store.varity.so",
  GATEWAY: "https://varity.app",
} as const;
