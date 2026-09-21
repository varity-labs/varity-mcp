import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { successResponse, errorResponse } from "../utils/responses.js";
import { execCLI, isCLIAvailable } from "../utils/cli-bridge.js";
import { getApiKey } from "../utils/config.js";

interface Check {
  name: string;
  status: "pass" | "fail" | "warn";
  version?: string;
  message?: string;
  fix?: string;
}

/** Node floor that agrees with package.json `engines.node` (">=22.11.0"). */
const NODE_MAJOR = 22;
const NODE_MINOR = 11;

/**
 * Parse a semver-like version string and return its major/minor numbers.
 * Handles formats like "v22.11.0", "22.11.0", "v24.0.1", etc.
 */
function parseNodeVersion(raw: string): { major: number; minor: number } | null {
  const match = raw.trim().match(/v?(\d+)(?:\.(\d+))?/);
  if (!match) return null;
  return { major: parseInt(match[1]!, 10), minor: match[2] ? parseInt(match[2], 10) : 0 };
}

export function registerDoctorTool(server: McpServer): void {
  server.registerTool(
    "varity_doctor",
    {
      title: "Check Environment",
      description:
        "Check if the developer's environment is ready to build and deploy apps with Varity. " +
        "Verifies Node.js, npm, varitykit CLI, and authentication are properly configured. " +
        "Run this before varity_deploy to catch missing prerequisites early.",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
      },
    },
    async () => {
      const checks: Check[] = [];
      const nextSteps: string[] = [];

      // 1. Node.js, require >= 22.11 (matches package.json engines)
      const nodeResult = await execCLI("node", ["--version"], { timeout: 10_000 });
      if (nodeResult.exitCode === 0 && nodeResult.stdout) {
        const detected = parseNodeVersion(nodeResult.stdout);
        const meetsFloor =
          detected !== null &&
          (detected.major > NODE_MAJOR ||
            (detected.major === NODE_MAJOR && detected.minor >= NODE_MINOR));
        if (meetsFloor) {
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
            message: `Node.js >= ${NODE_MAJOR}.${NODE_MINOR} is required (found ${nodeResult.stdout.trim()})`,
            fix: `Install Node.js ${NODE_MAJOR}.${NODE_MINOR}+ from https://nodejs.org`,
          });
          nextSteps.push(`Install Node.js ${NODE_MAJOR}.${NODE_MINOR}+ from https://nodejs.org`);
        }
      } else {
        checks.push({
          name: "Node.js",
          status: "fail",
          message: "Node.js is not installed",
          fix: `Install Node.js ${NODE_MAJOR}.${NODE_MINOR}+ from https://nodejs.org`,
        });
        nextSteps.push(`Install Node.js ${NODE_MAJOR}.${NODE_MINOR}+ from https://nodejs.org`);
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
          fix: `npm is included with Node.js, install Node.js ${NODE_MAJOR}.${NODE_MINOR}+ from https://nodejs.org`,
        });
        nextSteps.push(`Install Node.js ${NODE_MAJOR}.${NODE_MINOR}+ from https://nodejs.org (includes npm)`);
      }

      // 3. varitykit CLI
      const hasVaritykit = await isCLIAvailable("varitykit");
      if (hasVaritykit) {
        const vkResult = await execCLI("varitykit", ["--version"], { timeout: 10_000 });
        if (vkResult.exitCode === 0 && vkResult.stdout.trim()) {
          const version = vkResult.stdout.trim();
          checks.push({
            name: "varitykit CLI",
            status: "pass",
            version,
            message: `varitykit ${version} detected`,
          });
        } else {
          // The executable exists but its own runtime or dependencies cannot start.
          checks.push({
            name: "varitykit CLI",
            status: "fail",
            version: "unknown",
            message: "varitykit is installed but its runtime or dependencies could not start.",
            fix: "Reinstall in an isolated environment: pipx install --force varitykit",
          });
          nextSteps.push("Reinstall varitykit in an isolated environment: pipx install --force varitykit");
        }
      } else {
        checks.push({
          name: "varitykit CLI",
          status: "fail",
          message: "varitykit CLI is not installed",
          fix: "pip install varitykit",
        });
        nextSteps.push("pip install varitykit");
      }

      // 4. Authentication, check for deploy_key in config
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
          message: "Not authenticated, no deploy key found in ~/.varitykit/config.json",
          fix: "varitykit auth login",
        });
        nextSteps.push("varitykit auth login");
      }

      // 5. GitHub token, required specifically for varity_create_repo
      // Treated as "warn" (not "fail") because deployment and all other tools work without it.
      // Token resolution order (same as varity_create_repo):
      //   1. GITHUB_TOKEN / GH_TOKEN env var
      //   2. `gh auth token` (GitHub CLI), succeeds if gh CLI is installed and authenticated
      const githubToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
      if (githubToken) {
        checks.push({
          name: "GitHub Token",
          status: "pass",
          message: "GitHub token configured (varity_create_repo ready)",
        });
      } else {
        // Mirror varity_create_repo's fallback: try gh auth token
        let ghCliToken = false;
        try {
          const ghResult = await execCLI("gh", ["auth", "token"], { timeout: 5_000 });
          ghCliToken = ghResult.exitCode === 0 && !!ghResult.stdout.trim();
        } catch {
          // gh CLI not available, that's fine
        }

        if (ghCliToken) {
          checks.push({
            name: "GitHub Token",
            status: "pass",
            message: "GitHub CLI authenticated, varity_create_repo will use 'gh auth token' automatically",
          });
        } else {
          checks.push({
            name: "GitHub Token",
            status: "warn",
            message: "No GitHub authentication found; varity_create_repo requires a GitHub CLI session or GITHUB_TOKEN/GH_TOKEN environment variable.",
            fix: "Run `gh auth login`, or set GITHUB_TOKEN/GH_TOKEN in the MCP process environment. Do not pass a token in chat.",
          });
          // Not added to nextSteps, only blocks varity_create_repo, not deployment
        }
      }

      // Tiered readiness:
      // - `ready` = Node.js + npm work, so local JavaScript development tools can run.
      // - `cli_deploy_ready` = varitykit + auth also pass, so the
      //   MCP's varity_deploy adapter can call varitykit successfully.
      const coreChecks = checks.filter((c) => c.name === "Node.js" || c.name === "npm");
      const ready = coreChecks.every((c) => c.status === "pass");
      const deployChecks = checks.filter((c) =>
        ["Node.js", "npm", "varitykit CLI", "Authentication"].includes(c.name)
      );
      const cliDeployReady = deployChecks.every((c) => c.status === "pass");

      const coreIssues = checks.filter((c) => (c.name === "Node.js" || c.name === "npm") && c.status === "fail");
      const cliIssues = checks.filter(
        (c) => !["Node.js", "npm"].includes(c.name) && (c.status === "fail")
      );

      if (ready && cliDeployReady) {
        return successResponse(
          {
            ready: true,
            cli_deploy_ready: true,
            checks,
          },
          "Environment is ready! All prerequisites are met, you can build, develop, and deploy apps with Varity."
        );
      }

      if (ready && !cliDeployReady) {
        const cliFixList = cliIssues.map((c) => c.fix || c.message).filter(Boolean);

        // Local development works, but the varitykit-backed deploy path is incomplete.
        return successResponse(
          {
            ready: true,
            cli_deploy_ready: false,
            checks,
            note: `Development tools (varity_build, varity_dev_server) are ready. Important: varity_deploy also requires a working varitykit CLI, fix the following ${cliIssues.length} issue${cliIssues.length === 1 ? "" : "s"} before deploying:`,
            cli_issues: cliFixList,
          },
          `Ready for development (init, build, dev server work). Fix ${cliIssues.length} issue${cliIssues.length === 1 ? "" : "s"} before deploying: ${cliFixList.join("; ")}`
        );
      }

      // Core tools (Node.js / npm) are broken, nothing works
      return successResponse(
        {
          ready: false,
          cli_deploy_ready: false,
          checks,
          next_steps: nextSteps,
        },
        `Environment is not ready. Fix ${coreIssues.length} core issue${coreIssues.length === 1 ? "" : "s"} to begin development: ${coreIssues.map((c) => c.fix || c.message).join("; ")}`
      );
    }
  );
}
