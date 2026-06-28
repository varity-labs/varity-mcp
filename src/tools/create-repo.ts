/**
 * varity_create_repo - Create a GitHub repo and push the local project to it.
 *
 * Creates an empty repository and pushes the local project directory to GitHub.
 * A GitHub URL is required for dynamic deployments, so this is the bridge when a
 * developer has code locally but no repository yet.
 */

import { z } from "zod";
import { execFileSync, execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { successResponse, errorResponse } from "../utils/responses.js";

interface GitHubRepo {
  full_name: string;
  html_url: string;
  clone_url: string;
  ssh_url: string;
}

/**
 * Create empty GitHub repository via API (no template).
 */
async function createEmptyGitHubRepo(
  name: string,
  description: string | undefined,
  visibility: "public" | "private",
  token: string
): Promise<GitHubRepo> {
  const response = await fetch("https://api.github.com/user/repos", {
    method: "POST",
    headers: {
      Authorization: `token ${token}`,
      Accept: "application/vnd.github.v3+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name,
      description: description || `Varity app - ${name}`,
      private: visibility === "private",
      auto_init: false,
    }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: response.statusText })) as { message?: string };
    if (response.status === 422 && error.message?.includes("already exists")) {
      throw new Error(`Repository '${name}' already exists`);
    }
    throw new Error(error.message || `GitHub API error: ${response.statusText}`);
  }

  return response.json();
}

const DEFAULT_IGNORES = [
  "node_modules/",
  "__pycache__/",
  "*.pyc",
  ".env",
  ".env.local",
  ".env.*.local",
  "dist/",
  "build/",
  ".venv/",
  "venv/",
  ".DS_Store",
];

function ensureGitignore(projectPath: string): void {
  const gitignorePath = path.join(projectPath, ".gitignore");

  let existing = "";
  try {
    existing = readFileSync(gitignorePath, "utf-8");
  } catch {
    // File doesn't exist, will create it
  }

  const existingLines = existing.split("\n").map((l) => l.trim());
  const missing = DEFAULT_IGNORES.filter((entry) => {
    const bare = entry.replace(/\/$/, "");
    return !existingLines.some((l) => l === entry || l === bare);
  });

  if (missing.length === 0) return;

  const separator = existing && !existing.endsWith("\n") ? "\n" : "";
  const header = existing ? "\n# Added by Varity\n" : "# Common ignores\n";
  writeFileSync(gitignorePath, existing + separator + header + missing.join("\n") + "\n");
}

/**
 * Push local project directory to GitHub repo.
 * Handles: git init, remote setup, initial commit, push.
 */
function pushLocalProject(projectPath: string, cloneUrl: string, token: string): void {
  // Embed token in URL for authentication (HTTPS push)
  const authUrl = cloneUrl.replace("https://", `https://${token}@`);
  const opts = { cwd: projectPath, stdio: "pipe" as const };

  // Init git if not already
  try { execFileSync("git", ["init"], opts); } catch { /* already init */ }

  // Set git user config for automated environment (needed if no global config)
  try { execFileSync("git", ["config", "user.email", "varity-mcp@varity.so"], opts); } catch { /* ok */ }
  try { execFileSync("git", ["config", "user.name", "Varity MCP"], opts); } catch { /* ok */ }

  // Set or update remote origin, authUrl passed as array arg, never shell-interpolated
  try {
    execFileSync("git", ["remote", "add", "origin", authUrl], opts);
  } catch {
    execFileSync("git", ["remote", "set-url", "origin", authUrl], opts);
  }

  ensureGitignore(projectPath);

  execFileSync("git", ["add", "-A"], opts);

  // Commit (skip if nothing to commit)
  try {
    execFileSync("git", ["commit", "-m", "Initial commit"], opts);
  } catch {
    // Nothing to commit or already committed, ok
  }

  // Push to main branch (rename if needed)
  try {
    execFileSync("git", ["branch", "-M", "main"], opts);
  } catch { /* ok */ }

  execFileSync("git", ["push", "-u", "origin", "main", "--force"], opts);

  // Remove token from remote URL immediately after push, token must not persist in .git/config
  execFileSync("git", ["remote", "set-url", "origin", cloneUrl], opts);
}

/**
 * Auto-retry with sequential suffixes if name is taken.
 */
async function createRepoWithRetry(
  createFn: (name: string) => Promise<GitHubRepo>,
  baseName: string
): Promise<{ repo: GitHubRepo; usedName: string; wasTaken: boolean }> {
  try {
    return { repo: await createFn(baseName), usedName: baseName, wasTaken: false };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("already exists")) throw err;

    // Try sequential suffixes
    for (let i = 2; i <= 99; i++) {
      const altName = `${baseName}-${i}`;
      try {
        return { repo: await createFn(altName), usedName: altName, wasTaken: true };
      } catch (retryErr) {
        const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
        if (!retryMsg.includes("already exists")) throw retryErr;
      }
    }
    throw new Error(`All names taken for '${baseName}'`);
  }
}

export function registerCreateRepoTool(server: McpServer): void {
  server.registerTool(
    "varity_create_repo",
    {
      title: "Create GitHub Repository",
      description:
        "Create a new GitHub repository and push your local project to it. " +
        "Pass the 'path' parameter with the local project directory. This creates an empty repo " +
        "and pushes your actual code to GitHub. " +
        "The GitHub URL is required for dynamic deployments, so call this before varity_deploy when you have code locally but no repo yet. " +
        "Requires a GitHub personal access token (classic) with repo scope from https://github.com/settings/tokens.",
      inputSchema: {
        name: z
          .string()
          .min(1)
          .max(100)
          .regex(/^[a-z0-9-]+$/, "Repository name must be lowercase letters, numbers, and hyphens only")
          .describe("Repository name (lowercase, hyphens allowed, e.g. 'my-app')"),
        description: z.string().optional().describe("Short description of your app (optional)"),
        path: z
          .string()
          .optional()
          .describe(
            "Absolute path to the local project directory to push to GitHub " +
            "(e.g. '/home/user/my-app'). Pushes the actual project code. " +
            "Required for apps that will use varity_deploy with dynamic hosting."
          ),
        visibility: z.enum(["public", "private"]).default("public").describe("Repository visibility"),
        github_token: z
          .string()
          .optional()
          .describe("GitHub personal access token (optional if GITHUB_TOKEN env var is set). Needs 'repo' scope."),
      },
      annotations: {
        destructiveHint: true,
      },
    },
    async ({ name, description, path: projectPath, visibility, github_token }) => {
      // Resolve token
      let token = github_token || process.env.GITHUB_TOKEN;
      if (!token) {
        try {
          const ghToken = execSync("gh auth token", { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
          if (ghToken) token = ghToken;
        } catch { /* gh CLI not available */ }
      }
      if (!token) {
        return errorResponse(
          "MISSING_TOKEN",
          "GitHub token required. Either pass github_token parameter or set GITHUB_TOKEN environment variable.",
          "Get a token from https://github.com/settings/tokens (needs 'repo' scope). Tip: Install the GitHub CLI (gh) and run 'gh auth login' for automatic token detection."
        );
      }

      try {
        if (projectPath) {
          // === PRIMARY FLOW: Push local project to GitHub repo ===
          // First try to push to existing repo (update flow)
          let repo: GitHubRepo;
          let usedName = name;
          let wasTaken = false;
          let isUpdate = false;

          try {
            // Check if repo already exists
            const userRes = await fetch("https://api.github.com/user", { headers: { Authorization: `token ${token}` } });
            const userData = await userRes.json() as { login: string };
            const checkRes = await fetch(`https://api.github.com/repos/${userData.login}/${name}`, {
              headers: { Authorization: `token ${token}` },
            });
            if (checkRes.ok) {
              // Repo exists, push update to it
              repo = await checkRes.json() as GitHubRepo;
              isUpdate = true;
            } else {
              // Repo doesn't exist, create it
              const result = await createRepoWithRetry(
                (n) => createEmptyGitHubRepo(n, description, visibility, token!),
                name
              );
              repo = result.repo;
              usedName = result.usedName;
              wasTaken = result.wasTaken;
            }
          } catch {
            // Fallback, create new
            const result = await createRepoWithRetry(
              (n) => createEmptyGitHubRepo(n, description, visibility, token!),
              name
            );
            repo = result.repo;
            usedName = result.usedName;
            wasTaken = result.wasTaken;
          }

          // Push local project to the repo (works for both new and existing)
          try {
            pushLocalProject(projectPath, repo.clone_url, token!);
          } catch (pushErr) {
            const pushMsg = pushErr instanceof Error ? pushErr.message : String(pushErr);
            return errorResponse(
              "PUSH_FAILED",
              `Repository ${isUpdate ? "exists" : "created"} at ${repo.html_url} but failed to push: ${pushMsg}`,
              "Push manually: git init && git remote add origin " + repo.clone_url + " && git add -A && git commit -m 'Update' && git push -u origin main --force"
            );
          }

          const gitpodUrl = `https://gitpod.io/#${repo.html_url}`;
          const nameNote = wasTaken
            ? `⚠️ '${name}' was already taken, repository created as '${usedName}'.`
            : undefined;

          return successResponse(
            {
              repository: {
                name: repo.full_name,
                url: repo.html_url,
                clone_url: repo.clone_url,
                ssh_url: repo.ssh_url,
              },
              repo_url: repo.clone_url,
              pushed_from: projectPath,
              ...(nameNote ? { name_collision_note: nameNote } : {}),
              next_steps: [
                `Repository: ${repo.html_url}`,
                "Code pushed successfully, ready to deploy",
                "Next: call varity_deploy to go live (the GitHub URL is now auto-configured)",
              ],
            },
            `Repository created and code pushed: ${repo.html_url}${nameNote ? ` (${nameNote})` : ""}`
          );

        } else {
          return errorResponse(
            "PATH_REQUIRED",
            "A project path is required.",
            "Pass the 'path' parameter with your local project directory so its code can be pushed to the new GitHub repository."
          );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        if (message.includes("401") || message.includes("Bad credentials")) {
          return errorResponse(
            "INVALID_TOKEN",
            "GitHub token is invalid or expired",
            "Create a new token at https://github.com/settings/tokens with 'repo' scope"
          );
        }
        if (message.includes("403") || message.includes("rate limit")) {
          return errorResponse(
            "RATE_LIMITED",
            "GitHub API rate limit exceeded",
            "Wait a few minutes or use an authenticated token"
          );
        }

        return errorResponse("CREATE_FAILED", `Failed to create repository: ${message}`);
      }
    }
  );
}
