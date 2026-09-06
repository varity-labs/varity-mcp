import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const isWindows = process.platform === "win32";

/**
 * Terminal escape sequences the varitykit CLI can emit.
 *
 * This is the union of the three copies that previously lived in deploy.ts,
 * deploy-logs.ts and migrate.ts. Two of them shared one pattern; migrate.ts had
 * diverged and was the only one stripping CSI private-mode sequences
 * (cursor hide/show). Unioning keeps every call site's previous coverage.
 */
const ANSI_RE =
  /\x1b\[[0-9;]*[mGKHF]|\x1b\[\?[0-9]+[hl]|\x1b\][^\x07]*\x07|\x1b[()][0-9A-Z]/g;

/** Remove terminal escape sequences before parsing CLI output. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

export interface CLIResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface LifecycleTracking {
  runId: string | null;
  statusCommand: string | null;
}

const DURABLE_RUN_ID_RE =
  /\bvaritykit app status ([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\b/i;

/**
 * Project only the durable tracking reference from lifecycle CLI output.
 * The CLI deliberately does not emit environment values, and the MCP must not
 * return the rest of stdout as an invented lifecycle result.
 */
export function lifecycleTracking(stdout: string): LifecycleTracking {
  const runId = stdout.match(DURABLE_RUN_ID_RE)?.[1] ?? null;
  return {
    runId,
    statusCommand: runId ? `varitykit app status ${runId}` : null,
  };
}

/**
 * Execute a CLI command and return structured output.
 * Used to bridge MCP tool calls to existing varitykit CLI.
 *
 * On Windows, routes through cmd.exe /c to resolve .cmd/.bat wrappers
 * (npm, npx, pip, etc. are .cmd files that execFile cannot find directly).
 */
export async function execCLI(
  command: string,
  args: string[] = [],
  options: { timeout?: number; cwd?: string; env?: NodeJS.ProcessEnv } = {}
): Promise<CLIResult> {
  const timeout = options.timeout ?? 120_000; // 2 min default
  const env: NodeJS.ProcessEnv = { ...process.env, ...(options.env ?? {}) };
  // The MCP adapter consumes CLI stdout as data. Do not let parent terminal/npm
  // color settings leak into child commands, especially Python/Rich where
  // FORCE_COLOR="0" is still truthy and produces ANSI-decorated JSON.
  delete env.FORCE_COLOR;
  env.NO_COLOR = "1";
  env.CLICOLOR = "0";
  env.PY_COLORS = "0";

  // On Windows, run through cmd.exe to resolve .cmd/.bat wrappers
  const execCommand = isWindows ? (process.env.ComSpec || "cmd.exe") : command;
  const execArgs = isWindows ? ["/c", command, ...args] : args;

  try {
    const { stdout, stderr } = await execFileAsync(execCommand, execArgs, {
      timeout,
      cwd: options.cwd,
      env,
      maxBuffer: 10 * 1024 * 1024, // 10 MB
    });

    return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode: 0 };
  } catch (error: unknown) {
    const e = error as { stdout?: string; stderr?: string; code?: number | string };
    // Use || (not ??) so empty-string stderr still falls back to the Error message
    const stderr = e.stderr?.trim() || String(error);
    return {
      stdout: e.stdout?.trim() ?? "",
      stderr,
      exitCode: typeof e.code === "number" ? e.code : 1,
    };
  }
}

/**
 * True when varitykit rejected a subcommand it does not know: the installed
 * CLI predates the feature the MCP is bridging to. Surfacing this as an
 * upgrade instruction beats the raw click usage text.
 */
export function isOutdatedVaritykit(result: CLIResult): boolean {
  return result.exitCode !== 0 && /No such command/i.test(`${result.stderr}\n${result.stdout}`);
}

export const VARITYKIT_UPGRADE_HINT =
  "Upgrade the CLI: `pipx upgrade varitykit` (or `pip install -U varitykit`), then retry.";

/**
 * Check if a CLI tool is available on the system.
 */
export async function isCLIAvailable(command: string): Promise<boolean> {
  try {
    const whichCmd = isWindows ? "where" : "which";
    const { exitCode } = await execCLI(whichCmd, [command], { timeout: 5_000 });
    return exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Execute `varitykit` CLI command.
 *
 * On Windows, pip installs varitykit to %APPDATA%\Python\Scripts which is
 * NOT always in the default PATH. If `varitykit` isn't found (ENOENT), we
 * fall back to `python -m varitykit` which works as long as the varitykit
 * Python package is importable, the install-location doesn't matter.
 */
export async function execVaritykit(
  subcommand: string,
  args: string[] = [],
  options: { timeout?: number; cwd?: string } = {}
): Promise<CLIResult> {
  const result = await execCLI("varitykit", [subcommand, ...args], options);
  if (
    result.exitCode !== 0 &&
    (/ENOENT|command not found|is not recognized/i.test(result.stderr) ||
      /ENOENT|command not found|is not recognized/i.test(result.stdout))
  ) {
    return execCLI("python", ["-m", "varitykit", subcommand, ...args], options);
  }
  return result;
}
