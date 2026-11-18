import { realpath, readFile } from "node:fs/promises";
import path from "node:path";
import { errorResponse } from "../utils/responses.js";

/**
 * Reads named settings from a project's own `.env` file on the user's machine
 * (stdio only; the remote toolset never imports this module). Values never
 * leave this module except as the returned map that is sent to Varity's
 * write-only env field; no response, error or log built here contains one.
 *
 * Allowed source (IF-SECRET-PATHS, plan V9-1): a file inside the project
 * folder after symlinks are resolved whose name is `.env` or `.env.<x>`.
 * `.env.example`, `.env.sample` and `.env.template` hold names only, so they
 * are never a value source. Every requested name must be present.
 */

/** The env basenames IF-SECRET-PATHS classes as secret (gateway `SECRET_BASENAME_RE` env branch). */
const ENV_FILE = /^\.env(?:\..+)?$/i;
/** Example files: names only, never values. */
const ENV_TEMPLATE = /^\.env\.(?:example|sample|template)$/i;
/** The gateway's env name rule (`validateEnvMap`). */
export const ENV_KEY = /^[A-Z_][A-Z0-9_]*$/;

export type EnvRead =
  | { ok: true; env: Record<string, string> }
  | { ok: false; response: ReturnType<typeof errorResponse> };

/** Minimal dotenv parsing: `KEY=value`, optional `export`, quotes, `#` comments. */
export function parseEnvText(text: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2]!;
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote)) {
      value = value.slice(1, -1);
      if (quote === '"') value = value.replace(/\\n/g, "\n").replace(/\\"/g, '"');
    } else {
      value = value.replace(/\s+#.*$/, "").trim();
    }
    values.set(match[1]!, value);
  }
  return values;
}

const refuse = (code: string, message: string, action: string): EnvRead =>
  ({ ok: false, response: errorResponse(code, message, action) });

export async function readProjectEnv(projectPath: string, envFile: string, keys: readonly string[]): Promise<EnvRead> {
  if (!path.isAbsolute(projectPath)) {
    return refuse("PROJECT_PATH_REQUIRED", "The project folder must be given as a full path.", "Pass the app's project folder as an absolute path, e.g. /home/you/my-app.");
  }
  let root: string;
  try {
    root = await realpath(projectPath);
  } catch {
    return refuse("PROJECT_NOT_FOUND", "That project folder does not exist on this computer.", "Check the folder path and try again.");
  }
  let file: string;
  try {
    file = await realpath(path.resolve(root, envFile));
  } catch {
    return refuse(
      "ENV_FILE_NOT_FOUND",
      `There is no ${path.basename(envFile)} file in the project folder.`,
      "Ask the user to put the settings in a file named .env in the project folder (one NAME=value per line), then try again. Never put the values in chat."
    );
  }
  const name = path.basename(file);
  if (!file.startsWith(root + path.sep)) {
    return refuse("ENV_FILE_OUTSIDE_PROJECT", "The settings file must be inside the project folder.", "Use the .env file in the app's own project folder.");
  }
  if (!ENV_FILE.test(name)) {
    return refuse("ENV_FILE_NOT_ALLOWED", `Settings can only be read from a file named .env (or .env.<something>), not ${name}.`, "Put the settings in the project's .env file, then try again.");
  }
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return refuse("ENV_FILE_UNREADABLE", `The ${name} file could not be read.`, "Check that the file is readable, then try again.");
  }
  const values = parseEnvText(text);
  if (ENV_TEMPLATE.test(name)) {
    const listed = [...values.keys()];
    return refuse(
      "ENV_FILE_HAS_NO_VALUES",
      `${name} is an example file: it lists setting names${listed.length ? ` (${listed.join(", ")})` : ""}, not real values. Nothing was changed.`,
      "Ask the user to copy it to .env in the project folder and fill in the real values there, then call this again with env_file .env. Never put the values in chat."
    );
  }
  const missing = keys.filter((key) => !values.has(key));
  if (missing.length > 0) {
    return refuse(
      "ENV_KEYS_MISSING",
      `${name} does not contain ${missing.join(", ")}. Nothing was changed.`,
      `Ask the user to add ${missing.length === 1 ? "that line" : "those lines"} (NAME=value) to ${name}, then try again. Never put the values in chat.`
    );
  }
  return { ok: true, env: Object.fromEntries(keys.map((key) => [key, values.get(key)!])) };
}

/** Injected into tools shared with the remote toolset (template deploy), so they never import this module. */
export type ProjectEnvReader = typeof readProjectEnv;
