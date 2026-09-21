import { z } from "zod";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { successResponse, errorResponse } from "../utils/responses.js";
import { execCLI, execVaritykit, stripAnsi } from "../utils/cli-bridge.js";

function isGitHubUrl(url: string): boolean {
  return /^https?:\/\/github\.com\/|^git@github\.com:/.test(url);
}

function parseMigratePreview(raw: string): {
  changes: string[];
  warnings: string[];
  nothingToMigrate: boolean;
} {
  const text = stripAnsi(raw);
  const changes: string[] = [];
  const warnings: string[] = [];

  if (
    text.includes("No Vercel-isms found") ||
    text.includes("Nothing to migrate") ||
    text.includes("(no changes)")
  ) {
    return { changes, warnings, nothingToMigrate: true };
  }

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^[~+-]\s/.test(trimmed) || trimmed.startsWith("→") || trimmed.startsWith("->")) {
      changes.push(trimmed);
    } else if (trimmed.startsWith("⚠") || trimmed.toLowerCase().startsWith("warning:")) {
      warnings.push(trimmed.replace(/^⚠\s*/, "").trim());
    }
  }
  return { changes, warnings, nothingToMigrate: false };
}

export function registerMigrateTool(server: McpServer): void {
  server.registerTool(
    "varity_migrate",
    {
      title: "Preview a Vercel Migration",
      description:
        "Clone a GitHub repository into a disposable directory and preview the transformations " +
        "the current varitykit migration owner would apply. This tool does not mutate the source " +
        "repository or deploy. Applying a migration requires a user-controlled local checkout so " +
        "the transformed source can be reviewed, committed, and pushed before deployment.",
      inputSchema: {
        github_url: z
          .string()
          .describe("GitHub repository URL to inspect, for example https://github.com/user/app."),
        dry_run: z
          .boolean()
          .optional()
          .default(true)
          .describe("Must remain true. URL-based migration is preview-only until transformed-source custody is explicit."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ github_url, dry_run }) => {
      if (!isGitHubUrl(github_url)) {
        return errorResponse(
          "INVALID_URL",
          `Not a valid GitHub URL: ${github_url}`,
          "Provide a URL like https://github.com/username/repository."
        );
      }

      if (!dry_run) {
        return errorResponse(
          "MIGRATION_SOURCE_CUSTODY_REQUIRED",
          "URL-based migration cannot safely apply or deploy changes because a transformed temporary clone is not the backend's repository source.",
          "Clone the repository into a user-controlled checkout, run `varitykit migrate --path <checkout> --no-deploy`, review and commit the changes, push them, then call varity_deploy."
        );
      }

      const cloneDir = await mkdtemp(join(tmpdir(), "varity-migrate-preview-")).catch(() => null);
      if (!cloneDir) {
        return errorResponse(
          "TMP_DIR_FAILED",
          "Failed to create a temporary directory for the migration preview.",
          "Check that the system temporary directory is writable."
        );
      }

      try {
        const cloneResult = await execCLI(
          "git",
          ["clone", "--depth=1", github_url, cloneDir],
          { timeout: 120_000 }
        );
        if (cloneResult.exitCode !== 0) {
          const detail = (cloneResult.stderr || cloneResult.stdout).slice(-1000);
          return errorResponse(
            "CLONE_FAILED",
            `Could not clone the repository for preview: ${detail}`,
            "Check the URL, repository visibility, and local Git authentication."
          );
        }

        const previewResult = await execVaritykit(
          "migrate",
          ["apply", cloneDir, "--dry-run"],
          { timeout: 120_000 }
        );
        if (previewResult.exitCode !== 0) {
          return errorResponse(
            "MIGRATION_PREVIEW_FAILED",
            `varitykit could not preview the migration: ${(previewResult.stderr || previewResult.stdout).slice(-1000)}`,
            "Upgrade varitykit if needed, inspect the reported error, and retry."
          );
        }

        const preview = parseMigratePreview(`${previewResult.stdout}\n${previewResult.stderr}`);
        return successResponse(
          {
            dry_run: true,
            github_url,
            nothing_to_migrate: preview.nothingToMigrate,
            changes_that_would_apply: preview.changes,
            warnings: preview.warnings,
            source_mutated: false,
            deployed: false,
            next_step: preview.nothingToMigrate
              ? "No migration changes were identified. Inspect the project normally before deployment."
              : "Clone into a user-controlled checkout, run `varitykit migrate --path <checkout> --no-deploy`, review and commit the changes, push them, then call varity_deploy.",
          },
          preview.nothingToMigrate
            ? "Migration preview found no Vercel-specific changes. No source was mutated and nothing was deployed."
            : `Migration preview found ${preview.changes.length} change(s). No source was mutated and nothing was deployed.`
        );
      } finally {
        await rm(cloneDir, { recursive: true, force: true }).catch(() => {});
      }
    }
  );
}
