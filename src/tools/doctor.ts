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
        if (vkResult.exitCode === 0 && vkResult.stdout.trim()) {
          const version = vkResult.stdout.trim();
          checks.push({
            name: "varitykit CLI",
            status: "pass",
            version,
            message: `varitykit ${version} detected`,
          });
        } else {
          // Binary exists but won't run — almost always a Python version mismatch (< 3.10)
          checks.push({
            name: "varitykit CLI",
            status: "fail",
            version: "unknown",
            message: "varitykit is installed but not working — likely a Python version mismatch (check the Python result above)",
            fix: "Ensure Python 3.10+ is active, then reinstall: pip install --upgrade varitykit",
          });
          nextSteps.push("Ensure Python 3.10+ is active (check the Python result), then reinstall: pip install --upgrade varitykit");
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

      // 4. Python — only required for varitykit CLI deploys, NOT for MCP tool usage
      try {
        const pyCmd = process.platform === "win32" ? "python" : "python3";
        const pyResult = await execCLI(pyCmd, ["--version"], { timeout: 5_000 });
        if (pyResult.exitCode === 0 && pyResult.stdout) {
          const version = pyResult.stdout.trim();
          // Parse "Python 3.8.10" → major=3, minor=8
          const verMatch = version.match(/Python\s+(\d+)\.(\d+)/i);
          const major = verMatch ? parseInt(verMatch[1]!, 10) : null;
          const minor = verMatch ? parseInt(verMatch[2]!, 10) : null;
          const meetsRequirement = major !== null && minor !== null && (major > 3 || (major === 3 && minor >= 10));
          if (meetsRequirement) {
            checks.push({ name: "Python", status: "pass", version, message: `${version} detected (used by varitykit CLI deploys)` });
          } else {
            checks.push({
              name: "Python",
              status: "warn",
              version,
              message: `Python: Not required for MCP tools (only needed for CLI deploys). Found ${version} — upgrade to 3.10+ if you use varitykit directly.`,
              fix: "Install Python 3.10+ from https://python.org (only needed for direct CLI usage)",
            });
            // Not added to nextSteps — Python is not required for MCP-based deployment
          }
        } else {
          checks.push({
            name: "Python",
            status: "warn",
            message: "Python: Not required for MCP tools (only needed for CLI deploys)",
            fix: "Install Python 3.10+ from https://python.org if you plan to use varitykit CLI directly",
          });
          // Not added to nextSteps — Python is not required for MCP-based deployment
        }
      } catch {
        checks.push({
          name: "Python",
          status: "warn",
          message: "Python: Not required for MCP tools (only needed for CLI deploys)",
          fix: "Install Python 3.10+ from https://python.org if you plan to use varitykit CLI directly",
        });
        // Not added to nextSteps — Python is not required for MCP-based deployment
      }

      // 5. Authentication — check for deploy_key in config
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

      // 6. GitHub token — required specifically for varity_create_repo
      // Treated as "warn" (not "fail") because deployment and all other tools work without it.
      // Token resolution order (same as varity_create_repo):
      //   1. GITHUB_TOKEN / GH_TOKEN env var
      //   2. `gh auth token` (GitHub CLI) — succeeds if gh CLI is installed and authenticated
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
          // gh CLI not available — that's fine
        }

        if (ghCliToken) {
          checks.push({
            name: "GitHub Token",
            status: "pass",
            message: "GitHub CLI authenticated — varity_create_repo will use 'gh auth token' automatically",
          });
        } else {
          checks.push({
            name: "GitHub Token",
            status: "warn",
            message: "No GitHub token found — varity_create_repo requires one. Options: (1) install gh CLI and run 'gh auth login', or (2) set GITHUB_TOKEN env var.",
            fix: "Option 1 (easiest): Install GitHub CLI (https://cli.github.com) and run 'gh auth login'. Option 2: Create a token at https://github.com/settings/tokens (needs 'repo' scope), then set: export GITHUB_TOKEN=ghp_...",
          });
          // Not added to nextSteps — only blocks varity_create_repo, not deployment
        }
      }

      // 7. RAM check — Next.js 15 builds peak at ~3 GB
      try {
        const { freemem } = await import("node:os");
        const freeGB = freemem() / (1024 * 1024 * 1024);
        if (freeGB < 3) {
          checks.push({
            name: "RAM",
            status: "warn",
            message: `Low RAM: ${freeGB.toFixed(1)} GB free. Next.js 15 builds peak at ~3 GB — varity_build/varity_deploy may be killed by the OS.`,
            fix: "Close other applications to free memory, or use a machine with more RAM before building.",
          });
        } else {
          checks.push({
            name: "RAM",
            status: "pass",
            message: `${freeGB.toFixed(1)} GB free (Next.js 15 builds peak at ~3 GB — you're good)`,
          });
        }
      } catch {
        // Can't check RAM — skip
      }

      // Tiered readiness:
      // - `ready` = Node.js + npm work → can use varity_init, varity_build, varity_deploy (MCP tools)
      // - `cli_deploy_ready` = also Python + varitykit + auth + sufficient RAM → can use `varitykit app deploy` CLI directly
      // Python / varitykit only block the CLI path, NOT the MCP-based varity_deploy tool.
      // RAM < 3 GB is treated as a build blocker: local Next.js builds OOM at that threshold,
      // so cli_deploy_ready must be false even though other checks are merely "warn".
      const coreChecks = checks.filter((c) => c.name === "Node.js" || c.name === "npm");
      const ready = coreChecks.every((c) => c.status === "pass");
      const ramCheck = checks.find((c) => c.name === "RAM");
      const ramSufficient = !ramCheck || (ramCheck.status as string) !== "warn";
      const cliDeployReady =
        ramSufficient &&
        checks.every((c) => c.status === "pass" || (c.status as string) === "warn");

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
          "Environment is ready! All prerequisites are met — you can build, develop, and deploy apps with Varity."
        );
      }

      if (ready && !cliDeployReady) {
        const cliFixList = cliIssues.map((c) => c.fix || c.message).filter(Boolean);

        if (!ramSufficient && cliIssues.length === 0) {
          // RAM is the only reason cli_deploy_ready is false — all other checks are pass/warn.
          // Surface this prominently so users don't proceed to an OOM kill.
          return successResponse(
            {
              ready: true,
              cli_deploy_ready: false,
              checks,
              note: "Environment ready, but available RAM is too low for a local Next.js build (~3 GB peak). Use varity_deploy — builds run on remote infrastructure so local RAM is not a constraint.",
            },
            "Environment ready, but RAM is too low for local builds — close other apps or use varity_deploy (builds run remotely, local RAM is not a constraint)."
          );
        }

        // Core tools work, but Python / varitykit / auth missing (and possibly RAM too)
        return successResponse(
          {
            ready: true,
            cli_deploy_ready: false,
            checks,
            note: `Development tools (varity_init, varity_build, varity_dev_server) are ready. Important: varity_deploy also requires Python 3.10+ and a working varitykit CLI — fix the following ${cliIssues.length} issue${cliIssues.length === 1 ? "" : "s"} before deploying:`,
            cli_issues: cliFixList,
          },
          `Ready for development (init, build, dev server work). Fix ${cliIssues.length} issue${cliIssues.length === 1 ? "" : "s"} before deploying: ${cliFixList.join("; ")}`
        );
      }

      // Core tools (Node.js / npm) are broken — nothing works
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
