import { z } from "zod";
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { successResponse, errorResponse } from "../utils/responses.js";

/** Track running dev servers by resolved project path. */
const runningServers = new Map<
  string,
  { pid: number; port: number; path: string }
>();

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
          .describe("Port to run the dev server on (default: 3000)"),
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
        // Check if a server is already running for this path
        const existing = runningServers.get(projectPath);
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

        // Spawn `npm run dev` as a detached background process
        const child = spawn("npm", ["run", "dev", "--", "--port", String(port)], {
          cwd: projectPath,
          detached: true,
          stdio: "ignore",
          env: { ...process.env, PORT: String(port) },
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

        // Store the server entry
        runningServers.set(projectPath, { pid, port, path: projectPath });

        // Wait 3 seconds for the server to spin up, then verify it's alive
        await new Promise((r) => setTimeout(r, 3000));

        if (isProcessAlive(pid)) {
          return successResponse(
            {
              running: true,
              url: `http://localhost:${port}`,
              pid,
            },
            `Dev server started at http://localhost:${port} (PID ${pid}).`
          );
        }

        // Process died during startup
        runningServers.delete(projectPath);
        return errorResponse(
          "START_FAILED",
          "Dev server process exited immediately after starting.",
          "Check for errors by running `npm run dev` manually in the project directory."
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
          process.kill(entry.pid);
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
      const entry = runningServers.get(projectPath);
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

      // Clean up stale entry if present
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
