import { z } from "zod";
import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { access, readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { successResponse, errorResponse } from "../utils/responses.js";

/**
 * Persist the chosen port to varity.config.json so subsequent starts
 * always use the same port without passing it manually each time.
 * Silently no-ops if the config file doesn't exist or can't be written.
 */
async function persistPortToConfig(projectPath: string, port: number): Promise<void> {
  const configPath = resolve(projectPath, "varity.config.json");
  try {
    const raw = await readFile(configPath, "utf-8");
    const config = JSON.parse(raw);
    if (config.dev?.port === port) return; // already set — no write needed
    config.dev = { ...(config.dev ?? {}), port };
    await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
  } catch {
    // Config missing or malformed — silently skip; port tip still shown in response
  }
}

const SERVERS_FILE = join(homedir(), ".varitykit", "dev-servers.json");

/** Track running dev servers by resolved project path. */
const runningServers = new Map<
  string,
  { pid: number; port: number; path: string }
>();

interface PersistedServer { pid: number; port: number; path: string; startedAt: string; }

async function loadPersistedServers(): Promise<Record<string, PersistedServer>> {
  try { return JSON.parse(await readFile(SERVERS_FILE, "utf-8")); } catch { return {}; }
}

async function savePersistedServers(data: Record<string, PersistedServer>): Promise<void> {
  await mkdir(join(homedir(), ".varitykit"), { recursive: true });
  await writeFile(SERVERS_FILE, JSON.stringify(data, null, 2));
}

async function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createNetServer();
    s.once("error", () => resolve(false));
    s.once("listening", () => { s.close(); resolve(true); });
    s.listen(port);
  });
}

/**
 * Check whether a process with the given PID is still alive.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function registerDevServerTool(server: McpServer): void {
  server.registerTool(
    "varity_dev_server",
    {
      title: "Development Server",
      description:
        "Start, stop, or check the local development server. " +
        "Returns the localhost URL for previewing the app.",
      inputSchema: {
        action: z
          .enum(["start", "stop", "status"])
          .describe("Action to perform: start, stop, or check status of the dev server"),
        path: z
          .string()
          .optional()
          .describe("Project directory (default: current working directory)"),
        port: z
          .number()
          .optional()
          .default(3000)
          .describe(
            "Port to run the dev server on (default: 3000). " +
            "If this port is busy, the server auto-selects the next available port and persists it " +
            "to varity.config.json so future starts use the same port automatically. " +
            "You can also set this explicitly (e.g. port: 3031) to always start on a specific port."
          ),
      },
    },
    async ({ action, path, port }) => {
      const projectPath = resolve(path || process.cwd());

      // Validate that the project directory exists
      try {
        await access(projectPath);
      } catch {
        return errorResponse(
          "PATH_NOT_FOUND",
          `Project directory does not exist: ${projectPath}`,
          "Check the path and ensure the project has been created (use varity_init first)."
        );
      }

      if (action === "start") {
        // Pre-flight: check node_modules exists so we give a specific error
        // instead of a cryptic "process exited immediately" message.
        const nodeModulesPath = resolve(projectPath, "node_modules");
        try {
          await access(nodeModulesPath);
        } catch {
          return errorResponse(
            "MISSING_DEPS",
            "node_modules not found in the project directory.",
            "Run varity_install_deps first to install dependencies, then start the dev server again."
          );
        }

        // Check if a server is already running for this path (in-memory or persisted)
        let existing = runningServers.get(projectPath);
        if (!existing) {
          const persisted = await loadPersistedServers();
          const saved = persisted[projectPath];
          if (saved && isProcessAlive(saved.pid)) {
            runningServers.set(projectPath, { pid: saved.pid, port: saved.port, path: saved.path });
            existing = runningServers.get(projectPath);
          }
        }
        if (existing && isProcessAlive(existing.pid)) {
          return successResponse(
            {
              running: true,
              url: `http://localhost:${existing.port}`,
              pid: existing.pid,
              already_running: true,
            },
            `Dev server is already running at http://localhost:${existing.port} (PID ${existing.pid}).`
          );
        }

        // Auto-discover a free port starting from the requested port (tries up to 100 ports)
        let selectedPort = port;
        let portFound = false;
        for (let i = 0; i < 100; i++) {
          if (await isPortAvailable(selectedPort)) {
            portFound = true;
            break;
          }
          selectedPort++;
        }
        if (!portFound) {
          return errorResponse(
            "PORT_IN_USE",
            `Ports ${port}–${port + 99} are all in use.`,
            "Try port 4000 specifically (pass port: 4000), or free up a port and try again."
          );
        }

        // Spawn `npm run dev` as a detached background process
        const child = spawn("npm", ["run", "dev", "--", "--port", String(selectedPort)], {
          cwd: projectPath,
          detached: true,
          stdio: "ignore",
          env: { ...process.env, PORT: String(selectedPort) },
        });

        // Allow the parent to exit independently of the child
        child.unref();

        const pid = child.pid;
        if (!pid) {
          return errorResponse(
            "START_FAILED",
            "Failed to start the dev server — could not obtain a process ID.",
            "Try running `npm run dev` manually in the project directory."
          );
        }

        // Store the server entry (memory + disk)
        runningServers.set(projectPath, { pid, port: selectedPort, path: projectPath });
        const persisted = await loadPersistedServers();
        persisted[projectPath] = { pid, port: selectedPort, path: projectPath, startedAt: new Date().toISOString() };
        await savePersistedServers(persisted).catch(() => {});

        // Wait 3 seconds for the server to spin up, then verify it's alive
        await new Promise((r) => setTimeout(r, 3000));

        if (isProcessAlive(pid)) {
          const portChanged = selectedPort !== port;
          const freePortTip =
            `To reclaim port ${port}: call varity_dev_server({ action: "stop" }) to stop the current server, ` +
            `then call varity_dev_server({ action: "start", port: ${port} }).`;

          // When the port changed, persist the selected port to varity.config.json
          // so future `varity_dev_server` calls start on the same port automatically.
          let portPersisted = false;
          if (portChanged) {
            await persistPortToConfig(projectPath, selectedPort).then(() => { portPersisted = true; }).catch(() => {});
          }

          return successResponse(
            {
              running: true,
              url: `http://localhost:${selectedPort}`,
              pid,
              next_steps: [
                `Open your app in the browser: call varity_open_browser({ url: "http://localhost:${selectedPort}" })`,
                ...(portChanged
                  ? [
                      `To restart on the default port ${port}: (1) call varity_dev_server({ action: "stop" }), (2) call varity_dev_server({ action: "start", port: ${port} }).`,
                    ]
                  : []),
              ],
              ...(portChanged
                ? {
                    warning: `⚠️ Port ${port} was busy — your dev server is running at http://localhost:${selectedPort}. Update any bookmarks, saved localhost links, and tutorial references from localhost:${port} to localhost:${selectedPort}.`,
                    port_pin_tip: portPersisted
                      ? `Port ${selectedPort} saved to varity.config.json — future starts will use this port automatically.`
                      : `To always start on the same port, pass port: ${selectedPort} when calling varity_dev_server start (e.g., { action: "start", port: ${selectedPort} }).`,
                    free_port_command: freePortTip,
                  }
                : {}),
            },
            portChanged
              ? `⚠️ Port ${port} was busy — dev server started at http://localhost:${selectedPort}.\n\nTo open your app: call varity_open_browser({ url: "http://localhost:${selectedPort}" })\n\n${freePortTip}`
              : `Dev server started at http://localhost:${selectedPort}.\n\nTo open your app: call varity_open_browser({ url: "http://localhost:${selectedPort}" })`
          );
        }

        // Process died during startup — surface actionable causes
        runningServers.delete(projectPath);
        return errorResponse(
          "START_FAILED",
          "The dev server process exited immediately after starting.",
          "Common causes: (1) broken binary permissions — fix with `rm -rf node_modules && npm install`; (2) syntax error in the project — check TypeScript errors; (3) disk full — check with `df -h`. Run `npm run dev` in the project directory to see the full error output."
        );
      }

      if (action === "stop") {
        const entry = runningServers.get(projectPath);
        if (!entry) {
          return errorResponse(
            "NOT_RUNNING",
            `No dev server is tracked for ${projectPath}.`,
            "Start one first with action: 'start'."
          );
        }

        try {
          if (process.platform === "win32") {
            const { execSync } = await import("node:child_process");
            execSync(`taskkill /pid ${entry.pid} /f /t`, { stdio: "ignore" });
          } else {
            process.kill(entry.pid);
          }
        } catch {
          // Process may already be gone — that's fine
        }

        runningServers.delete(projectPath);

        return successResponse(
          { stopped: true, pid: entry.pid },
          `Dev server stopped (PID ${entry.pid}).`
        );
      }

      // action === "status"
      let entry = runningServers.get(projectPath);

      // If not in memory, check persisted servers on disk (handles MCP server restarts)
      if (!entry) {
        const persisted = await loadPersistedServers();
        const saved = persisted[projectPath];
        if (saved && isProcessAlive(saved.pid)) {
          runningServers.set(projectPath, { pid: saved.pid, port: saved.port, path: saved.path });
          entry = runningServers.get(projectPath);
        }
      }

      if (entry && isProcessAlive(entry.pid)) {
        return successResponse(
          {
            running: true,
            url: `http://localhost:${entry.port}`,
            pid: entry.pid,
          },
          `Dev server is running at http://localhost:${entry.port} (PID ${entry.pid}).`
        );
      }

      // Clean up stale in-memory entry if present
      if (entry) {
        runningServers.delete(projectPath);
      }

      return successResponse(
        { running: false },
        `No dev server is running for ${projectPath}.`
      );
    }
  );
}
