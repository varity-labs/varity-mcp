import { z } from "zod";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { successResponse, errorResponse } from "../utils/responses.js";
import { execCLI, execVaritykit } from "../utils/cli-bridge.js";
import { getDeploymentsDir } from "../utils/config.js";

function isGitHubUrl(url: string): boolean {
  return /^https?:\/\/github\.com\/|^git@github\.com:/.test(url);
}

/** Strip ANSI escape codes from CLI output for clean parsing. */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1B\[[0-9;]*[mGKHF]/g, "").replace(/\x1B\[\?[0-9]+[hl]/g, "");
}

/** Extract the deployed URL from varitykit deploy output or the deployments dir. */
async function extractDeployUrl(output: string): Promise<string> {
  // Try reading the latest deployment record first (most reliable)
  try {
    const deploymentsDir = getDeploymentsDir();
    const files = await readdir(deploymentsDir);
    const jsonFiles = files.filter((f) => f.endsWith(".json")).sort().reverse();
    if (jsonFiles.length > 0) {
      const latest = JSON.parse(await readFile(join(deploymentsDir, jsonFiles[0]!), "utf-8"));
      // Always surface the clean varity.app URL. Never a raw provider/IPFS host.
      if (latest.custom_domain?.url) return latest.custom_domain.url;
      const slug = latest.custom_domain?.subdomain || latest.app_name || latest.project_name;
      if (slug) return `https://varity.app/${slug}/`;
      if (typeof latest.url === "string" && latest.url.startsWith("https://varity.app")) {
        return latest.url;
      }
    }
  } catch {
    // fall through to regex
  }
  // Fallback: grep the output for a varity.app URL only.
  const match = output.match(/https?:\/\/varity\.app\/[^\s)]+/i);
  return match?.[0] ?? "";
}

/** Parse the `varitykit migrate apply` output into a structured summary. */
function parseMigrateApplyOutput(raw: string): {
  changes_applied: string[];
  warnings: string[];
  nothing_to_migrate: boolean;
} {
  const text = stripAnsi(raw);
  const changes_applied: string[] = [];
  const warnings: string[] = [];

  if (
    text.includes("No Vercel-isms found") ||
    text.includes("Nothing to migrate") ||
    text.includes("(no changes)")
  ) {
    return { changes_applied, warnings, nothing_to_migrate: true };
  }

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (/^~\s/.test(trimmed)) {
      const path = trimmed.replace(/^~\s+(?:modified:\s*)?/, "").trim();
      if (path) changes_applied.push("Modified: " + path);
    } else if (/^-\s/.test(trimmed) && !trimmed.startsWith("->")) {
      const path = trimmed.replace(/^-\s+(?:removed:\s*)?/, "").trim();
      if (path) changes_applied.push("Removed: " + path);
    } else if (/^\+\s/.test(trimmed)) {
      const path = trimmed.replace(/^\+\s+(?:created:\s*)?/, "").trim();
      if (path) changes_applied.push("Created: " + path);
    } else if (/^removed\s+\S/.test(trimmed)) {
      changes_applied.push(trimmed);
    } else if (trimmed.startsWith("→") || trimmed.startsWith("->")) {
      changes_applied.push(trimmed.replace(/^[-→>]+\s*/, "").trim());
    } else if (/^[^:]+:\s+\S+\s*→/.test(trimmed)) {
      changes_applied.push(trimmed);
    } else if (trimmed.startsWith("⚠") || trimmed.toLowerCase().startsWith("warning:")) {
      warnings.push(trimmed.replace(/^⚠\s*/, "").trim());
    } else if (trimmed.startsWith("•")) {
      warnings.push(trimmed.replace(/^•\s*/, "").trim());
    }
  }

  return { changes_applied, warnings, nothing_to_migrate: false };
}

export function registerMigrateTool(server: McpServer): void {
  server.registerTool(
    "varity_migrate",
    {
      title: "Migrate from Vercel to Varity",
      description:
        "Migrate a Vercel project to Varity in one step: clones the GitHub repository, " +
        "removes Vercel-specific artifacts (vercel.json, @vercel/* packages, image optimizer config, " +
        "env var renames), and deploys the transformed app to Varity infrastructure. " +
        "Returns a live deployment URL and a migration report. " +
        "Works with Next.js projects. Use this when a developer wants to move their Vercel app to Varity.",
      inputSchema: {
        github_url: z
          .string()
          .describe(
            "GitHub repository URL to migrate (e.g. 'https://github.com/user/my-vercel-app'). " +
            "The repository will be cloned to a temporary directory, transformed, and deployed."
          ),
        dry_run: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            "If true, show what would change without deploying. Useful for previewing migration impact."
          ),
      },
      annotations: {
        destructiveHint: true,
      },
    },
    async ({ github_url, dry_run }) => {
      // Validate URL
      if (!isGitHubUrl(github_url)) {
        return errorResponse(
          "INVALID_URL",
          `Not a valid GitHub URL: ${github_url}`,
          "Provide a URL like https://github.com/username/repo-name"
        );
      }

      // Create temp directory for the clone
      const cloneDir = await mkdtemp(join(tmpdir(), "varity-migrate-")).catch(() => null);
      if (!cloneDir) {
        return errorResponse(
          "TMP_DIR_FAILED",
          "Failed to create a temporary directory for cloning.",
          "Check that the system has write access to the temp directory."
        );
      }

      // Clone the repository (shallow clone for speed)
      const cloneResult = await execCLI(
        "git",
        ["clone", "--depth=1", github_url, cloneDir],
        { timeout: 120_000 }
      );

      if (cloneResult.exitCode !== 0) {
        await rm(cloneDir, { recursive: true, force: true }).catch(() => {});
        const errText = cloneResult.stderr || cloneResult.stdout;
        if (errText.includes("not found") || errText.includes("does not exist") || errText.includes("Repository not found")) {
          return errorResponse(
            "REPO_NOT_FOUND",
            `Repository not found or not accessible: ${github_url}`,
            "Ensure the repository exists and is public. For private repos, ensure git credentials are configured."
          );
        }
        return errorResponse(
          "CLONE_FAILED",
          `Failed to clone ${github_url}: ${errText.slice(0, 500)}`,
          "Check the URL and your network connection."
        );
      }

      // Step 2: Apply Vercel → Varity codemods
      const applyArgs = dry_run
        ? ["apply", cloneDir, "--dry-run"]
        : ["apply", cloneDir];

      const applyResult = await execVaritykit("migrate", applyArgs, { timeout: 60_000 });
      const migrationSummary = parseMigrateApplyOutput(
        applyResult.stdout + "\n" + applyResult.stderr
      );

      // For dry runs, return immediately without deploying
      if (dry_run) {
        await rm(cloneDir, { recursive: true, force: true }).catch(() => {});
        return successResponse(
          {
            dry_run: true,
            github_url,
            nothing_to_migrate: migrationSummary.nothing_to_migrate,
            changes_that_would_apply: migrationSummary.changes_applied,
            warnings: migrationSummary.warnings,
            ...(migrationSummary.nothing_to_migrate
              ? {
                  note: "Scanned the cloned repository and found no Vercel-specific artifacts " +
                    "(no vercel.json, no @vercel/* dependencies, no Vercel environment variables). " +
                    "This repository root is already compatible with Varity. " +
                    "If your app lives in a subdirectory, provide the full GitHub URL to that path.",
                }
              : {}),
          },
          migrationSummary.nothing_to_migrate
            ? "No Vercel-specific artifacts found, this app is already Varity-compatible."
            : `Dry run complete. ${migrationSummary.changes_applied.length} change(s) would be applied. Run with dry_run=false to migrate and deploy.`
        );
      }

      // Step 3: Install dependencies after codemods removed @vercel/* packages
      await execCLI("npm", ["install", "--legacy-peer-deps"], { cwd: cloneDir, timeout: 120_000 });

      // Step 3.5: Verify the transformed app builds before deploying
      try {
        const pkgJson = JSON.parse(await readFile(join(cloneDir, "package.json"), "utf-8"));
        if (pkgJson?.scripts?.build) {
          const buildResult = await execCLI("npm", ["run", "build"], {
            cwd: cloneDir,
            timeout: 300_000,
            env: { NODE_OPTIONS: "--max-old-space-size=4096" },
          });
          if (buildResult.exitCode !== 0) {
            await rm(cloneDir, { recursive: true, force: true }).catch(() => {});
            const buildOutput = (buildResult.stdout + "\n" + buildResult.stderr).slice(-2000);
            return errorResponse(
              "BUILD_FAILED",
              `Migration codemods applied, but the app failed to build:\n${buildOutput}`,
              "Common causes: TypeScript errors or missing peer dependencies after removing @vercel/* packages. Fix the errors in your source repo and try migrating again."
            );
          }
        }
      } catch {
        // package.json unreadable, proceed to deploy anyway
      }

      // Step 4: Deploy via varitykit app deploy
      const deployResult = await execVaritykit(
        "app",
        [
          "deploy",
          "--mode", "auto",
          "--hosting", "dynamic",
          "--path", cloneDir,
          "--repo-url", github_url,
        ],
        { timeout: 300_000 }
      );

      const deployOutput = deployResult.stdout + "\n" + deployResult.stderr;

      if (deployResult.exitCode !== 0) {
        // Cleanup on deploy failure
        await rm(cloneDir, { recursive: true, force: true }).catch(() => {});
        return errorResponse(
          "DEPLOY_FAILED",
          `Migration codemods applied but deployment failed: ${deployOutput.slice(-500)}`,
          "Codemods were applied to the cloned repo but the deploy step failed. " +
          "Fix the error above and try varity_migrate again."
        );
      }

      const deployUrl = await extractDeployUrl(deployOutput);

      // Cleanup temp directory on success
      await rm(cloneDir, { recursive: true, force: true }).catch(() => {});

      return successResponse(
        {
          github_url,
          deployment_url: deployUrl || "Check varity_deploy_status for the live URL",
          nothing_to_migrate: migrationSummary.nothing_to_migrate,
          changes_applied: migrationSummary.changes_applied,
          warnings: migrationSummary.warnings,
          tmp_clone_cleaned: true,
          infrastructure: {
            hosting: "Dynamic cloud hosting, auto-configured",
          },
          next_steps: [
            ...(deployUrl ? [`App live at: ${deployUrl}`] : []),
            "Review the warnings above and manually fix anything flagged.",
          ],
        },
        deployUrl
          ? `Migration complete! ${migrationSummary.changes_applied.length} Vercel artifact(s) transformed. Live at: ${deployUrl}`
          : `Migration complete! ${migrationSummary.changes_applied.length} Vercel artifact(s) transformed. Run varity_deploy_status for the URL.`
      );
    }
  );
}
