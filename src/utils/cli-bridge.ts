import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const isWindows = process.platform === "win32";

export interface CLIResult {
  stdout: string;
  stderr: string;
  exitCode: number;
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

  // On Windows, run through cmd.exe to resolve .cmd/.bat wrappers
  const execCommand = isWindows ? (process.env.ComSpec || "cmd.exe") : command;
  const execArgs = isWindows ? ["/c", command, ...args] : args;

  try {
    const { stdout, stderr } = await execFileAsync(execCommand, execArgs, {
      timeout,
      cwd: options.cwd,
      // FORCE_COLOR=0 disables colors for Node.js tools (chalk/supports-color).
      // NO_COLOR=1 is the cross-ecosystem standard (https://no-color.org/) and
      // is what Python/Rich actually respects, FORCE_COLOR="0" is a non-empty
      // string, so Python's `bool("0")` is True, causing Rich to *enable* ANSI
      // output instead of disabling it.  Both vars together cover all toolchains.
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1", ...(options.env ?? {}) },
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
 * Execute `npx` command (for create-varity-app, etc.)
 */
export async function execNpx(
  pkg: string,
  args: string[] = [],
  options: { timeout?: number; cwd?: string } = {}
): Promise<CLIResult> {
  return execCLI("npx", ["--yes", pkg, ...args], options);
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
  options: { timeout?: number; cwd?: string; env?: NodeJS.ProcessEnv } = {}
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
