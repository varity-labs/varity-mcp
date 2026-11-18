import { realpath, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorResponse, successResponse } from "../utils/responses.js";

/**
 * Reads named settings from a project's own `.env` file on the user's machine
 * (stdio only; the remote toolset never imports this module). Values never
 * leave this module except as the returned map that is sent to Varity's
 * write-only env field; no response, error or log built here contains one.
 *
 * Allowed source (IF-SECRET-PATHS, plan V9-1): a file directly in the
 * project folder (`env_file` is a basename) whose name is `.env` or
 * `.env.<x>`, still inside that folder after symlinks are resolved.
 * `.env.example`, `.env.sample` and `.env.template` hold names only, so they
 * are never a value source. Every requested name must be present.
 *
 * The project folder is caller-chosen, so it must itself be trusted: inside
 * one of the MCP client's declared roots (`roots/list`), or, when the client
 * declares none, inside this server's working directory. And nothing is sent
 * until the user confirms the key names and the target app (MCP elicitation,
 * or a second call with `confirm: true` when the client cannot elicit).
 */

/** The env basenames IF-SECRET-PATHS classes as secret (gateway `SECRET_BASENAME_RE` env branch). */
const ENV_FILE = /^\.env(?:\..+)?$/i;
/** Example files: names only, never values. */
const ENV_TEMPLATE = /^\.env\.(?:example|sample|template)$/i;
/** The gateway's env name rule (`validateEnvMap`). */
export const ENV_KEY = /^[A-Z_][A-Z0-9_]*$/;

export type EnvRead =
  | { ok: true; env: Record<string, string> }
  | { ok: false; response: ReturnType<typeof errorResponse> | ReturnType<typeof successResponse> };

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

const inside = (child: string, parent: string) => child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);

export async function readProjectEnv(
  projectPath: string,
  envFile: string,
  keys: readonly string[],
  trustedRoots: readonly string[]
): Promise<EnvRead> {
  if (!path.isAbsolute(projectPath)) {
    return refuse("PROJECT_PATH_REQUIRED", "The project folder must be given as a full path.", "Pass the app's project folder as an absolute path, e.g. /home/you/my-app.");
  }
  if (/[\\/]/.test(envFile) || !ENV_FILE.test(envFile)) {
    return refuse("ENV_FILE_NOT_ALLOWED", "env_file must be the name of a .env file in the project folder (for example .env or .env.production), not a path.", "Put the settings in the project's .env file, then try again.");
  }
  let root: string;
  try {
    root = await realpath(projectPath);
  } catch {
    return refuse("PROJECT_NOT_FOUND", "That project folder does not exist on this computer.", "Check the folder path and try again.");
  }
  const trusted = (await Promise.all(trustedRoots.map((r) => realpath(r).catch(() => null)))).filter((r): r is string => r !== null);
  if (!trusted.some((r) => inside(root, r))) {
    return refuse(
      "PROJECT_OUTSIDE_WORKSPACE",
      "That folder is outside the project folders this editor has opened, so its settings are not read.",
      "Use the app's project folder that is open in the editor."
    );
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

/** The client's declared roots as paths, else the server's working directory. */
export async function trustedRoots(server: McpServer): Promise<string[]> {
  if (server.server.getClientCapabilities()?.roots) {
    try {
      const { roots } = await server.server.listRoots();
      const paths = roots.filter((r) => r.uri.startsWith("file://")).map((r) => fileURLToPath(r.uri));
      if (paths.length > 0) return paths;
    } catch {
      // An unreadable roots list falls back to the working directory below.
    }
  }
  return [process.cwd()];
}

/**
 * Ask before sending: only the key names and the app are shown. Returns null
 * when the user confirmed, else the response to return (nothing was sent).
 */
export async function confirmSend(
  server: McpServer, keys: readonly string[], target: string, confirm: boolean | undefined, note = "The app will restart."
) {
  const question = `Set ${keys.join(", ")} on ${target}? ${note}`;
  if (server.server.getClientCapabilities()?.elicitation) {
    try {
      const answer = await server.server.elicitInput({
        message: question,
        requestedSchema: { type: "object", properties: { confirm: { type: "boolean", title: "Yes, set these and restart the app" } }, required: ["confirm"] },
      });
      if (answer.action === "accept" && answer.content?.confirm === true) return null;
      return errorResponse("ENV_NOT_CONFIRMED", "The user did not confirm, so nothing was sent.", "Ask the user before trying again.");
    } catch {
      // A client that advertises elicitation but fails to answer falls back to confirm: true.
    }
  }
  if (confirm === true) return null;
  return successResponse(
    { confirmation_required: true, keys: [...keys], target, sent: false },
    `${question} Nothing has been sent yet. Ask the user; if they agree, call this tool again with the same arguments and confirm: true.`
  );
}

/** Roots check, read and confirmation as one step; injected into the template tools so the remote graph never imports this module. */
export type ProjectEnvReader = (
  projectPath: string, envFile: string, keys: readonly string[], target: string, confirm: boolean | undefined, note?: string
) => Promise<EnvRead>;

export function projectEnvReader(server: McpServer): ProjectEnvReader {
  return async (projectPath, envFile, keys, target, confirm, note) => {
    const read = await readProjectEnv(projectPath, envFile, keys, await trustedRoots(server));
    if (!read.ok) return read;
    const declined = await confirmSend(server, keys, target, confirm, note);
    return declined ? { ok: false, response: declined } : read;
  };
}
