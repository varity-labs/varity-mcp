import { hostname } from "node:os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { successResponse, errorResponse } from "../utils/responses.js";
import { execFile } from "node:child_process";
import { readSavedSignIn, resolveDeployKey, SignInFileError, updateSignIn, type DeployKeySource } from "../utils/config.js";
import { INFRASTRUCTURE } from "../utils/endpoints.js";
import {
  checkAuthorizationServer,
  isHeadless,
  LoginError,
  revokeCurrentKey,
  startDeviceSignIn,
  startLoopbackSignIn,
  type Grant,
} from "../utils/oauth-login.js";
import { DEPLOY_KEY_URL, publicApiGet, runInCallContext, VarityPublicApiError } from "../utils/public-api.js";

/** How long one varity_login call waits for the browser before answering `pending` (d1-auth §3.9). */
export const LOGIN_WAIT_MS = 120_000;
const PROGRESS_EVERY_MS = 10_000;

/** What the agent says to the user before and while sign-in runs (non-coder wording). */
export const BROWSER_SIGN_IN_LINE = "I'll open a browser tab: confirm there to connect Varity.";
const DEVELOPER_OPTION =
  `For CI or scripts, developers can instead create a deploy key at ${DEPLOY_KEY_URL} and set it as VARITY_DEPLOY_KEY in the MCP server environment.`;

export function configuredCredentialResponse() {
  return successResponse(
    {
      credential_present: true,
      authentication_verified: false,
      next_step: "Call varity_doctor to verify the complete deployment setup.",
    },
    "A Varity deploy credential is configured but has not been verified. Call varity_doctor before deploying."
  );
}

function connectedResponse(fresh: boolean) {
  return successResponse(
    { authenticated: true, signed_in: true, source: "sign-in file" },
    fresh
      ? "Varity is connected on this computer. Tell the user it worked and continue their task; no restart is needed."
      : "Varity is already connected on this computer. Continue the user's task."
  );
}

type Outcome = { ok: true } | { ok: false; error: LoginError };

interface Session {
  kind: "browser" | "device";
  browserOpened: boolean;
  url: string;
  userCode: string | null;
  outcome: Outcome | null;
  settled: Promise<Outcome>;
  cancel: () => void;
}

/** The one in-flight sign-in of this process; a later varity_login call resumes it. */
let session: Session | null = null;
/** A start in progress, set before the first await so concurrent calls share it. */
let starting: Promise<Session | ToolResult> | null = null;
type ToolResult = ReturnType<typeof successResponse> | ReturnType<typeof errorResponse>;

/** Forget (and stop) an in-flight sign-in: logout, and tests. */
export function resetLoginSessionForTests(): void {
  session?.cancel();
  session = null;
  starting = null;
}

/**
 * The platform opener, run without a shell: on Windows `cmd /c start` would
 * split the sign-in URL at "&", so the URL protocol handler is called directly.
 */
export function browserCommand(platform: string, url: string): { command: string; args: string[] } {
  if (platform === "win32") return { command: "rundll32", args: ["url.dll,FileProtocolHandler", url] };
  if (platform === "darwin") return { command: "open", args: [url] };
  return { command: "xdg-open", args: [url] };
}

function defaultOpenBrowser(url: string): Promise<boolean> {
  const { command, args } = browserCommand(process.platform, url);
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 10_000, windowsHide: true }, (error) => resolve(!error));
  });
}

export interface LoginToolDeps {
  baseUrl?: string;
  openBrowser?: (url: string) => Promise<boolean>;
  waitMs?: number;
  headless?: () => boolean;
}

/** Confirm a key with one owner-scoped read: "valid", "rejected" (401/403) or "unknown". */
export async function checkKey(key: string): Promise<"valid" | "rejected" | "unknown"> {
  try {
    await runInCallContext(
      { credentials: async () => key, transport: "stdio", clientInfo: () => undefined },
      () => publicApiGet("/api/deployments")
    );
    return "valid";
  } catch (error) {
    const status = error instanceof VarityPublicApiError ? error.status : undefined;
    return status === 401 || status === 403 ? "rejected" : "unknown";
  }
}

/**
 * Save the minted key through the one writer, then revoke the browser key it
 * replaces (d1-auth §3.6). Only a key an earlier browser sign-in saved (it has
 * a `deploy_key_id`) is revoked, with itself as the bearer. A key that cannot
 * be saved is revoked, so no live key is left behind.
 */
async function keep(baseUrl: string, grant: Grant): Promise<void> {
  const previous = await readSavedSignIn();
  try {
    await updateSignIn(
      grant.deployKeyId ? { deploy_key: grant.deployKey, deploy_key_id: grant.deployKeyId } : { deploy_key: grant.deployKey },
      grant.deployKeyId ? [] : ["deploy_key_id"]
    );
  } catch (error) {
    await revokeCurrentKey(baseUrl, grant.deployKey).catch(() => false);
    const reason = error instanceof SignInFileError
      ? error.message
      : "Check that your home folder is writable, then try again.";
    throw new LoginError(`Varity signed you in, but this computer could not save the sign-in, so it was cancelled. ${reason}`, "SIGN_IN_NOT_SAVED");
  }
  if (previous.deployKey && previous.deployKeyId && previous.deployKey !== grant.deployKey) {
    await revokeCurrentKey(baseUrl, previous.deployKey).catch(() => false);
  }
}

function settle(baseUrl: string, done: Promise<Grant>): Promise<Outcome> {
  return done
    .then((grant) => keep(baseUrl, grant))
    .then(
      (): Outcome => ({ ok: true }),
      (error: unknown): Outcome => ({
        ok: false,
        error: error instanceof LoginError ? error : new LoginError("Sign-in did not complete. Call varity_login to try again."),
      })
    );
}

async function startSession(baseUrl: string, deps: Required<LoginToolDeps>): Promise<Session> {
  await checkAuthorizationServer(baseUrl);
  if (deps.headless()) {
    // The server names the key "<client> on <label>": send the host name only.
    const device = await startDeviceSignIn(baseUrl, { label: hostname() });
    return {
      kind: "device",
      browserOpened: false,
      url: device.verificationUri,
      userCode: device.userCode,
      outcome: null,
      settled: settle(baseUrl, device.done),
      cancel: device.cancel,
    };
  }
  const loopback = await startLoopbackSignIn(baseUrl);
  let opened = false;
  try {
    opened = await deps.openBrowser(loopback.url);
  } catch {
    opened = false;
  }
  return {
    kind: "browser",
    browserOpened: opened,
    url: loopback.url,
    userCode: null,
    outcome: null,
    settled: settle(baseUrl, loopback.done),
    cancel: loopback.cancel,
  };
}

function pendingResponse(current: Session) {
  if (current.kind === "device") {
    return successResponse(
      { authenticated: false, status: "pending", sign_in_url: current.url, code: current.userCode },
      `Tell the user: "Open ${current.url} in any browser and confirm the code ${current.userCode} to connect Varity. ` +
        `Only approve a code you started here." When they have confirmed, call varity_login again; it picks up this same sign-in. ` +
        "Never ask the user for a key."
    );
  }
  const say = current.browserOpened
    ? `"${BROWSER_SIGN_IN_LINE.replace("I'll open", "I opened")}"`
    : `"Open this link and confirm there to connect Varity: ${current.url}"`;
  return successResponse(
    { authenticated: false, status: "pending", browser_opened: current.browserOpened, sign_in_url: current.url },
    `Tell the user: ${say} When they have confirmed, call varity_login again; it picks up this same sign-in. Never ask the user for a key.`
  );
}

/** When browser sign-in is down, the deploy key is the way in for everyone (J-21), not a developer aside. */
export const KEY_SIGN_IN_LINE =
  "Browser sign-in isn't available right now. You can connect with a deploy key instead: " +
  `create one at ${DEPLOY_KEY_URL} and add it as VARITY_DEPLOY_KEY in your editor's MCP settings. Keep the key out of the chat.`;

export function failureResponse(error: LoginError) {
  if (error.code === "SIGN_IN_UNAVAILABLE") {
    return errorResponse(error.code, KEY_SIGN_IN_LINE, `Tell the user exactly this: "${KEY_SIGN_IN_LINE}"`);
  }
  return errorResponse(error.code, error.message, `Call varity_login to start a new browser sign-in. ${DEVELOPER_OPTION}`);
}

/** Check an existing key, then start one sign-in and make it the process's session. */
async function begin(deps: Required<LoginToolDeps>): Promise<Session | ToolResult> {
  const resolved = await resolveDeployKey();
  if (resolved) {
    const verdict = await checkKey(resolved.key);
    if (verdict === "valid") return connectedResponse(false);
    if (verdict === "unknown") return configuredCredentialResponse();
    if (resolved.source !== "config:~/.varitykit/config.json") {
      const name = resolved.source.slice("env:".length);
      return errorResponse(
        "DEPLOY_KEY_REJECTED",
        `Varity rejected the key set as ${name} in the MCP server environment, and that setting overrides browser sign-in.`,
        `Remove ${name} from the MCP server configuration, then call varity_login to connect in the browser. ` +
          `Developers can instead replace it with a new deploy key from ${DEPLOY_KEY_URL}.`
      );
    }
    // A rejected saved sign-in (revoked or expired): sign in again and replace it.
  }
  let started: Session;
  try {
    started = await startSession(deps.baseUrl, deps);
  } catch (error) {
    return failureResponse(error instanceof LoginError ? error : new LoginError("Sign-in could not start. Call varity_login to try again."));
  }
  session = started;
  void started.settled.then((outcome) => { started.outcome = outcome; });
  return started;
}

async function waitFor(current: Session, waitMs: number, progress: (elapsedMs: number) => Promise<void>): Promise<Outcome | null> {
  if (current.outcome) return current.outcome;
  const started = Date.now();
  let timer: NodeJS.Timeout | undefined;
  let ticker: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      current.settled,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), waitMs);
        ticker = setInterval(() => { void progress(Date.now() - started).catch(() => undefined); }, PROGRESS_EVERY_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    clearInterval(ticker);
  }
}

type Extra = {
  _meta?: { progressToken?: string | number };
  sendNotification?: (notification: {
    method: "notifications/progress";
    params: { progressToken: string | number; progress: number; total?: number; message?: string };
  }) => Promise<void>;
};

export function registerLoginTool(server: McpServer, overrides: LoginToolDeps = {}): void {
  const deps: Required<LoginToolDeps> = {
    baseUrl: (overrides.baseUrl ?? INFRASTRUCTURE.GATEWAY).replace(/\/+$/, ""),
    openBrowser: overrides.openBrowser ?? defaultOpenBrowser,
    waitMs: overrides.waitMs ?? LOGIN_WAIT_MS,
    headless: overrides.headless ?? (() => isHeadless(process.env)),
  };
  server.registerTool(
    "varity_login",
    {
      title: "Connect Varity",
      description:
        "Connect Varity on this computer with a browser sign-in, so deploys work. Before calling, tell the user: " +
        `"${BROWSER_SIGN_IN_LINE}" Confirming in the browser is the only step: there is no key to type or copy, ` +
        "and nothing needs restarting. The call waits up to 2 minutes; if it returns status \"pending\", relay its message " +
        "to the user and call varity_login again to finish the same sign-in. On a machine without a browser it returns a " +
        "link and a short code for the user to confirm on any device. Never ask the user for a key; credentials are never " +
        "accepted as tool input.",
      inputSchema: {},
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (_args: unknown, extra?: Extra) => {
      const progressToken = extra?._meta?.progressToken;
      const progress = async (elapsedMs: number) => {
        if (progressToken === undefined || !extra?.sendNotification) return;
        await extra.sendNotification({
          method: "notifications/progress",
          params: {
            progressToken,
            progress: Math.round(elapsedMs / 1000),
            total: Math.round(deps.waitMs / 1000),
            message: "Waiting for you to confirm in the browser tab.",
          },
        });
      };

      // A sign-in that already failed while nobody was waiting starts over.
      if (session?.outcome && !session.outcome.ok) session = null;
      if (!session) {
        starting ??= begin(deps).finally(() => { starting = null; });
        const begun = await starting;
        if (!("settled" in begun)) return begun;
        // A code or link the user must act on first is returned at once.
        if (begun.kind === "device" || !begun.browserOpened) return pendingResponse(begun);
      }
      if (!session) return failureResponse(new LoginError("Sign-in was stopped. Call varity_login to start again."));

      const current = session;
      const outcome = await waitFor(current, deps.waitMs, progress);
      if (!outcome) return pendingResponse(current);
      if (session === current) session = null;
      return outcome.ok ? connectedResponse(true) : failureResponse(outcome.error);
    }
  );
}

const SOURCE_WORDS: Readonly<Record<DeployKeySource, string>> = {
  "env:VARITY_DEPLOY_KEY": "VARITY_DEPLOY_KEY in the MCP server environment",
  "config:~/.varitykit/config.json": "the older api_key field in ~/.varitykit/config.json",
  "env:VARITY_API_KEY": "VARITY_API_KEY in the MCP server environment",
};

/** After the browser sign-in is gone, which key (if any) still connects this computer. */
async function stillConnectedBy(): Promise<string | null> {
  const resolved = await resolveDeployKey();
  return resolved ? SOURCE_WORDS[resolved.source] : null;
}

/**
 * `varity_logout`: revoke this computer's saved sign-in key on Varity, then
 * remove it (d1-auth §3.6). A key whose revocation outcome is unknown is kept,
 * so the user is never told they are signed out while the key still works.
 */
export function registerLogoutTool(server: McpServer, overrides: Pick<LoginToolDeps, "baseUrl"> = {}): void {
  const baseUrl = (overrides.baseUrl ?? INFRASTRUCTURE.GATEWAY).replace(/\/+$/, "");
  server.registerTool(
    "varity_logout",
    {
      title: "Sign Out of Varity",
      description:
        "Sign this computer out of Varity: the saved sign-in is revoked on Varity, so it stops working everywhere, then " +
        "removed from this computer. Use only when the user asks to sign out or disconnect. A key set in the MCP server " +
        "environment is not changed.",
      inputSchema: {},
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      resetLoginSessionForTests(); // an unfinished or unseen sign-in never outlives a sign-out
      const saved = await readSavedSignIn();
      if (!saved.deployKey) {
        const remaining = await stillConnectedBy();
        return remaining
          ? successResponse(
              { signed_in: false, still_connected_by: remaining },
              `There is no browser sign-in to remove, but this computer is still connected to Varity through ${remaining}. ` +
                `To disconnect fully, remove it there (or revoke it in the Deploy keys tab: ${DEPLOY_KEY_URL}).`
            )
          : successResponse({ signed_in: false }, "This computer is not signed in to Varity, so there was nothing to sign out of.");
      }
      let revoked: boolean;
      try {
        revoked = await revokeCurrentKey(baseUrl, saved.deployKey);
      } catch (error) {
        const message = error instanceof LoginError ? error.message : "Varity could not be reached.";
        return errorResponse(
          "SIGN_OUT_NOT_CONFIRMED",
          `${message} You are still signed in; nothing was removed.`,
          "Try varity_logout again in a few minutes."
        );
      }
      if (!revoked && (await checkKey(saved.deployKey)) !== "rejected") {
        return errorResponse(
          "SIGN_OUT_NOT_CONFIRMED",
          "Varity did not confirm the sign-out, and the saved sign-in may still work. Nothing was removed.",
          `Try varity_logout again, or revoke the key in the Deploy keys tab: ${DEPLOY_KEY_URL}`
        );
      }
      try {
        await updateSignIn({}, ["deploy_key", "deploy_key_id"]);
      } catch {
        return errorResponse(
          "SIGN_OUT_INCOMPLETE",
          "The sign-in was revoked on Varity, but this computer could not remove it from ~/.varitykit/config.json.",
          "Check that your home folder is writable, then call varity_logout again."
        );
      }
      const done = revoked
        ? "Signed out. The sign-in was revoked on Varity and removed from this computer."
        : "Signed out. Varity no longer accepted the saved sign-in, and it was removed from this computer.";
      const remaining = await stillConnectedBy();
      return successResponse(
        remaining
          ? { signed_in: false, revoked_on_varity: revoked, still_connected_by: remaining }
          : { signed_in: false, revoked_on_varity: revoked },
        remaining
          ? `${done} This computer is still connected to Varity through ${remaining}; to disconnect fully, remove it there ` +
            `(or revoke it in the Deploy keys tab: ${DEPLOY_KEY_URL}).`
          : done
      );
    }
  );
}
