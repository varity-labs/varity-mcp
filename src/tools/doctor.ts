import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { successResponse, errorResponse } from "../utils/responses.js";
import { execCLI, isCLIAvailable } from "../utils/cli-bridge.js";
import { getApiKey } from "../utils/config.js";

interface Check {
  name: string;
  status: "pass" | "fail";
  version?: string;
  message?: string;
  fix?: string;
}

/**
 * Parse a semver-like version string and return the major version number.
 * Handles formats like "v18.17.0", "18.17.0", "v20.11.1", etc.
 */
function parseMajorVersion(raw: string): number | null {
  const match = raw.trim().match(/v?(\d+)/);
  return match ? parseInt(match[1]!, 10) : null;
}

export function registerDoctorTool(server: McpServer): void {
  server.registerTool(
    "varity_doctor",
    {
      title: "Check Environment",
      description:
        "Check if the developer's environment is ready to build and deploy apps with Varity. " +
        "Verifies Node.js, npm, varitykit CLI, and authentication are properly configured. " +
        "Run this before varity_init or varity_deploy to catch missing prerequisites early.",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
      },
    },
    async () => {
      const checks: Check[] = [];
      const nextSteps: string[] = [];

      // 1. Node.js — require >= 18
      const nodeResult = await execCLI("node", ["--version"], { timeout: 10_000 });
      if (nodeResult.exitCode === 0 && nodeResult.stdout) {
        const major = parseMajorVersion(nodeResult.stdout);
        if (major !== null && major >= 18) {
          checks.push({
            name: "Node.js",
            status: "pass",
            version: nodeResult.stdout.trim(),
            message: `Node.js ${nodeResult.stdout.trim()} detected`,
          });
        } else {
          checks.push({
            name: "Node.js",
            status: "fail",
            version: nodeResult.stdout.trim(),
            message: `Node.js >= 18 is required (found ${nodeResult.stdout.trim()})`,
            fix: "Install Node.js 18+ from https://nodejs.org",
          });
          nextSteps.push("Install Node.js 18+ from https://nodejs.org");
        }
      } else {
        checks.push({
          name: "Node.js",
          status: "fail",
          message: "Node.js is not installed",
          fix: "Install Node.js 18+ from https://nodejs.org",
        });
        nextSteps.push("Install Node.js 18+ from https://nodejs.org");
      }

      // 2. npm
      const npmResult = await execCLI("npm", ["--version"], { timeout: 10_000 });
      if (npmResult.exitCode === 0 && npmResult.stdout) {
        checks.push({
          name: "npm",
          status: "pass",
          version: npmResult.stdout.trim(),
          message: `npm ${npmResult.stdout.trim()} detected`,
        });
      } else {
        checks.push({
          name: "npm",
          status: "fail",
          message: "npm is not installed",
          fix: "npm is included with Node.js — install Node.js 18+ from https://nodejs.org",
        });
        nextSteps.push("Install Node.js 18+ from https://nodejs.org (includes npm)");
      }

      // 3. varitykit CLI
      const hasVaritykit = await isCLIAvailable("varitykit");
      if (hasVaritykit) {
        const vkResult = await execCLI("varitykit", ["--version"], { timeout: 10_000 });
        const version = vkResult.exitCode === 0 ? vkResult.stdout.trim() : "unknown";
        checks.push({
          name: "varitykit CLI",
          status: "pass",
          version,
          message: `varitykit ${version} detected`,
        });
      } else {
        checks.push({
          name: "varitykit CLI",
          status: "fail",
          message: "varitykit CLI is not installed",
          fix: "pip install varitykit",
        });
        nextSteps.push("pip install varitykit");
      }

      // 4. Authentication — check for deploy_key in config
      const apiKey = await getApiKey();
      if (apiKey) {
        checks.push({
          name: "Authentication",
          status: "pass",
          message: "Authenticated (deploy key configured)",
        });
      } else {
        checks.push({
          name: "Authentication",
          status: "fail",
          message: "Not authenticated — no deploy key found in ~/.varitykit/config.json",
          fix: "varitykit auth login",
        });
        nextSteps.push("varitykit auth login");
      }

      // Determine overall readiness
      const ready = checks.every((c) => c.status === "pass");

      if (ready) {
        return successResponse(
          {
            ready: true,
            checks,
          },
          "Environment is ready! All prerequisites are met — you can build and deploy apps with Varity."
        );
      }

      return successResponse(
        {
          ready: false,
          checks,
          next_steps: nextSteps,
        },
        `Environment is not ready. ${nextSteps.length} issue${nextSteps.length === 1 ? "" : "s"} to fix before you can deploy.`
      );
    }
  );
}
