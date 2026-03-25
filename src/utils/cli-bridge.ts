import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface CLIResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Execute a CLI command and return structured output.
 * Used to bridge MCP tool calls to existing varitykit CLI.
 */
export async function execCLI(
  command: string,
  args: string[] = [],
  options: { timeout?: number; cwd?: string } = {}
): Promise<CLIResult> {
  const timeout = options.timeout ?? 120_000; // 2 min default

  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      timeout,
      cwd: options.cwd,
      env: { ...process.env, FORCE_COLOR: "0" },
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
    const whichCmd = process.platform === "win32" ? "where" : "which";
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
 */
export async function execVaritykit(
  subcommand: string,
  args: string[] = [],
  options: { timeout?: number; cwd?: string } = {}
): Promise<CLIResult> {
  return execCLI("varitykit", [subcommand, ...args], options);
}
