import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { successResponse, errorResponse } from "../utils/responses.js";
import { execCLI, isCLIAvailable } from "../utils/cli-bridge.js";
import { getApiKey } from "../utils/config.js";
import { publicApiGet, VarityPublicApiError } from "../utils/public-api.js";

export interface Check {
  name: string;
  status: "pass" | "fail" | "warn";
  version?: string;
  message?: string;
  fix?: string;
}

export function classifyReadiness(checks: Check[]): {
  developmentReady: boolean;
  cliDeployReady: boolean;
  developmentIssues: Check[];
  cliIssues: Check[];
} {
  const developmentChecks = checks.filter((check) =>
    check.name === "Node.js" || check.name === "npm"
  );
  const cliDeployChecks = checks.filter((check) =>
    check.name === "varitykit CLI" || check.name === "Authentication"
  );
  return {
    developmentReady: developmentChecks.every((check) => check.status === "pass"),
    cliDeployReady: cliDeployChecks.every((check) => check.status === "pass"),
    developmentIssues: developmentChecks.filter((check) => check.status === "fail"),
    cliIssues: cliDeployChecks.filter((check) => check.status === "fail"),
  };
}

export async function verifyAuthentication(
  apiKey: string | null,
  verify: () => Promise<unknown> = () => publicApiGet<{ deployments?: unknown[] }>("/api/deployments")
): Promise<Check> {
  if (!apiKey) {
    return {
      name: "Authentication",
      status: "fail",
      message: "Not authenticated, no deploy key found in ~/.varitykit/config.json",
      fix: "varitykit auth login",
    };
  }
  try {
    await verify();
    return {
      name: "Authentication",
      status: "pass",
      message: "Authentication verified by the Varity public interface",
    };
  } catch (error) {
    const ownerError = error instanceof VarityPublicApiError ? error : null;
    const authenticationFailure = ownerError?.status === 401 || ownerError?.status === 403;
    const detail = ownerError?.message
      ?? "The Varity public interface could not validate deployment readiness.";
    return {
      name: "Authentication",
      status: "fail",
      message: authenticationFailure
        ? `Authentication was rejected by the Varity public interface: ${detail}`
        : `Deployment readiness could not be verified: ${detail}`,
      fix: authenticationFailure
        ? (ownerError?.action ?? "Run `varitykit auth login` in a trusted terminal, then retry varity_doctor.")
        : (ownerError?.action ?? "Check your connection and retry varity_doctor."),
    };
  }
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
        "Check local-development and CLI-deployment readiness independently. " +
        "Node.js and npm qualify local JavaScript tools; varitykit and authentication qualify deployment. " +
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

      // 4. Authentication. Key presence is not proof: validate it through an
      // owner-scoped read before declaring the deployment adapter ready.
      const apiKey = await getApiKey();
      const authentication = await verifyAuthentication(apiKey);
      checks.push(authentication);
      if (authentication.status === "fail") nextSteps.push(authentication.fix ?? "varitykit auth login");

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

      const {
        developmentReady,
        cliDeployReady,
        developmentIssues,
        cliIssues,
      } = classifyReadiness(checks);

      if (developmentReady && cliDeployReady) {
        return successResponse(
          {
            ready: true,
            cli_deploy_ready: true,
            checks,
          },
          "Environment is ready! All prerequisites are met, you can build, develop, and deploy apps with Varity."
        );
      }

      if (developmentReady && !cliDeployReady) {
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

      if (!developmentReady && cliDeployReady) {
        const developmentFixes = developmentIssues.map((c) => c.fix || c.message).filter(Boolean);
        return successResponse(
          {
            ready: false,
            cli_deploy_ready: true,
            checks,
            note: "varity_deploy is ready because varitykit and authentication work. Local JavaScript build and development tools still require Node.js and npm.",
            development_issues: developmentFixes,
          },
          `Ready to deploy through varitykit. Fix ${developmentIssues.length} local-development issue${developmentIssues.length === 1 ? "" : "s"} before using JavaScript build or dev-server tools: ${developmentFixes.join("; ")}`
        );
      }

      const developmentFixes = developmentIssues.map((c) => c.fix || c.message).filter(Boolean);
      const cliFixes = cliIssues.map((c) => c.fix || c.message).filter(Boolean);
      return successResponse(
        {
          ready: false,
          cli_deploy_ready: false,
          checks,
          next_steps: nextSteps,
        },
        `Local development and CLI deployment are not ready. Development: ${developmentFixes.join("; ")}. Deployment: ${cliFixes.join("; ")}.`
      );
    }
  );
}
