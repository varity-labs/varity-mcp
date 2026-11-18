import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";

/** Resolved per call: the sign-in file follows the current HOME. */
function configDir(): string {
  return join(homedir(), ".varitykit");
}
function configFile(): string {
  return join(configDir(), "config.json");
}

/** Where the deploy key came from; reported by varity_doctor, never the key itself. */
export type DeployKeySource = "env:VARITY_DEPLOY_KEY" | "config:~/.varitykit/config.json" | "env:VARITY_API_KEY";

/**
 * Resolve the deploy key in this order:
 *   1. env `VARITY_DEPLOY_KEY` (the override)
 *   2. the sign-in file `~/.varitykit/config.json`: `deploy_key`, then the
 *      legacy `api_key` (read only: `updateSignIn` never writes it)
 *   3. env `VARITY_API_KEY` (legacy alias)
 * WHY: the public AI Gateway docs use `VARITY_API_KEY` for the inference key,
 * so an exported inference key read first refused every deploy with 403 even
 * when a deploy key was configured.
 */
export async function resolveDeployKey(): Promise<{ key: string; source: DeployKeySource } | null> {
  const deployEnv = process.env["VARITY_DEPLOY_KEY"];
  if (deployEnv) return { key: deployEnv, source: "env:VARITY_DEPLOY_KEY" };

  try {
    const config = JSON.parse(await readFile(configFile(), "utf-8"));
    const configKey = config.deploy_key || config.api_key;
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

// The endpoint table lives in an fs-free module so the remote toolset can
// import it; stdio callers keep importing it from here.
export { INFRASTRUCTURE } from "./endpoints.js";

/** The saved sign-in fields this process may write (`api_key` is never one of them). */
export interface SavedSignIn {
  deployKey: string | null;
  deployKeyId: string | null;
}

async function readConfigObject(): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(configFile(), "utf-8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

/** The browser sign-in saved in the sign-in file (`deploy_key`, `deploy_key_id`), not env keys. */
export async function readSavedSignIn(): Promise<SavedSignIn> {
  let config: Record<string, unknown> = {};
  try {
    config = await readConfigObject();
  } catch {
    // An unreadable file holds no usable sign-in.
  }
  const key = config["deploy_key"];
  const id = config["deploy_key_id"];
  return {
    deployKey: typeof key === "string" && key ? key : null,
    deployKeyId: typeof id === "string" && id ? id : null,
  };
}

/**
 * The one writer of `~/.varitykit/config.json` in this package (PLAN N3, §0a).
 *
 * `set` fields are merged over the current file and `remove` fields deleted;
 * every other field (written by varitykit) is kept. Only `deploy_key` and
 * `deploy_key_id` are ever written. The new content goes to a fresh file
 * created 0600 with O_CREAT|O_EXCL (so it is never readable by others, not
 * even briefly), is flushed, then atomically renamed over the old file, in a
 * 0700 directory. A concurrent reader sees the old file or the new one.
 */
export async function updateSignIn(
  set: { deploy_key?: string; deploy_key_id?: string },
  remove: ReadonlyArray<"deploy_key" | "deploy_key_id"> = []
): Promise<void> {
  const dir = configDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const next = { ...(await readConfigObject()) };
  for (const field of remove) delete next[field];
  if (set.deploy_key !== undefined) next["deploy_key"] = set.deploy_key;
  if (set.deploy_key_id !== undefined) next["deploy_key_id"] = set.deploy_key_id;
  const temp = join(dir, `.config.json.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  const handle = await open(temp, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(next, null, 2)}\n`, "utf-8");
    await handle.sync();
  } catch (error) {
    await handle.close();
    await unlink(temp).catch(() => undefined);
    throw error;
  }
  await handle.close();
  try {
    await rename(temp, configFile());
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }
}
