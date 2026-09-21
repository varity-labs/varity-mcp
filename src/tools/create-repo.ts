/**
 * varity_create_repo - Create a GitHub repo and push the local project to it.
 *
 * Creates an empty repository and pushes the local project directory to GitHub.
 * A GitHub URL is required for dynamic deployments, so this is the bridge when a
 * developer has code locally but no repository yet.
 */

import { z } from "zod";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
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
  ".env*",
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

const PREFLIGHT_SKIP_DIRECTORIES = new Set([
  ".git",
]);

function findEnvPaths(projectPath: string, directory = projectPath): string[] {
  const matches: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = path.join(directory, entry.name);
    const relativePath = path.relative(projectPath, absolutePath).split(path.sep).join("/");
    if (entry.name.startsWith(".env")) {
      matches.push(relativePath);
      continue;
    }
    if (entry.isDirectory() && !PREFLIGHT_SKIP_DIRECTORIES.has(entry.name)) {
      matches.push(...findEnvPaths(projectPath, absolutePath));
    }
  }
  return matches;
}

function refuseEnvPaths(paths: string[]): void {
  if (paths.length === 0) return;
  throw new Error(
    `Refusing to commit or push secret-bearing .env* paths: ${paths.sort().join(", ")}. ` +
    "Remove them from the project and Git index, and store only reviewed, non-secret examples under a different name."
  );
}

function trackedEnvPaths(projectPath: string, env: NodeJS.ProcessEnv): string[] {
  try {
    return execFileSync("git", ["ls-files", "-z"], {
      cwd: projectPath,
      env,
      encoding: "utf8",
      stdio: "pipe",
    }).split("\0").filter((file) => path.posix.basename(file).startsWith(".env"));
  } catch {
    return [];
  }
}

function refuseRepositoryHooks(projectPath: string, env: NodeJS.ProcessEnv): void {
  try {
    const configuredHooksPath = execFileSync("git", ["config", "--path", "--get", "core.hooksPath"], {
      cwd: projectPath,
      env,
      encoding: "utf8",
      stdio: "pipe",
    }).trim();
    if (configuredHooksPath) {
      throw new Error(`configured hooks path ${configuredHooksPath}`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("configured hooks path ")) throw error;
  }

  try {
    const hooksDirectory = execFileSync("git", ["rev-parse", "--git-path", "hooks"], {
      cwd: projectPath,
      env,
      encoding: "utf8",
      stdio: "pipe",
    }).trim();
    const absoluteHooksDirectory = path.resolve(projectPath, hooksDirectory);
    if (!existsSync(absoluteHooksDirectory)) return;
    const activeHooks = readdirSync(absoluteHooksDirectory).filter((name) => {
      if (name.endsWith(".sample")) return false;
      return (statSync(path.join(absoluteHooksDirectory, name)).mode & 0o111) !== 0;
    });
    if (activeHooks.length > 0) throw new Error(`active hooks: ${activeHooks.sort().join(", ")}`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("active hooks: ")) throw error;
  }
}

/**
 * Push local project directory to GitHub repo.
 * Handles: git init, remote setup, initial commit, push.
 */
export function pushLocalProject(projectPath: string, cloneUrl: string, token: string): void {
  const childEnv = { ...process.env };
  for (const name of Object.keys(childEnv)) {
    if (
      name.startsWith("GIT_TRACE") ||
      name === "GIT_TEMPLATE_DIR" ||
      name === "GITHUB_TOKEN" ||
      name === "GH_TOKEN"
    ) {
      delete childEnv[name];
    }
  }

  // Preflight before git init, config, remote, ignore, or index mutation. The
  // filesystem scan covers ignored/untracked files; the index scan independently
  // proves that already-tracked .env* paths cannot pass.
  refuseEnvPaths([...new Set([...findEnvPaths(projectPath), ...trackedEnvPaths(projectPath, childEnv)])]);

  // Arbitrary repository hooks run as the MCP host user. Refuse a credentialed
  // push when hooks are configured instead of leaking the push credential or
  // bypassing hooks with --no-verify.
  try {
    refuseRepositoryHooks(projectPath, childEnv);
  } catch (error) {
    throw new Error(`Refusing credentialed push while Git hooks are configured: ${error instanceof Error ? error.message : String(error)}.`);
  }

  // Local Git commands must not inherit ambient API credentials. The normal
  // hook-free push receives an ephemeral HTTP header instead: the secret never
  // enters a command argument or the stored remote URL.
  const basicCredential = Buffer.from(`x-access-token:${token}`).toString("base64");
  const localOpts = {
    cwd: projectPath,
    stdio: "pipe" as const,
    env: childEnv,
  };
  const pushOpts = {
    ...localOpts,
    env: {
      ...localOpts.env,
      GIT_TERMINAL_PROMPT: "0",
      // GIT_CONFIG_PARAMETERS is supported by the repository's Git 2.25 host;
      // the newer GIT_CONFIG_COUNT/KEY/VALUE protocol is not.
      GIT_CONFIG_PARAMETERS:
        `'http.https://github.com/.extraheader=AUTHORIZATION: basic ${basicCredential}' ` +
        `'credential.helper='`,
    },
  };

  // Init git if not already
  try { execFileSync("git", ["init", "--template="], localOpts); } catch { /* already init */ }

  // Set git user config for automated environment (needed if no global config)
  try { execFileSync("git", ["config", "user.email", "varity-mcp@varity.so"], localOpts); } catch { /* ok */ }
  try { execFileSync("git", ["config", "user.name", "Varity MCP"], localOpts); } catch { /* ok */ }

  // Store only the credential-free clone URL.
  try {
    execFileSync("git", ["remote", "add", "origin", cloneUrl], localOpts);
  } catch {
    execFileSync("git", ["remote", "set-url", "origin", cloneUrl], localOpts);
  }

  ensureGitignore(projectPath);

  execFileSync("git", ["add", "--", "."], localOpts);

  // .gitignore does not protect files that were already tracked. Inspect the
  // actual index after staging and refuse every .env* path before any commit
  // or network operation. This intentionally fails closed for sample files as
  // well: callers can rename reviewed examples before asking the tool to push.
  const trackedPaths = execFileSync("git", ["ls-files", "-z"], {
    ...localOpts,
    encoding: "utf8",
  }).split("\0").filter(Boolean);
  const secretPaths = trackedPaths.filter((file) => path.posix.basename(file).startsWith(".env"));
  refuseEnvPaths(secretPaths);

  // Commit only when this invocation staged a change. Other commit failures
  // remain failures rather than being misclassified as "nothing to commit".
  try {
    execFileSync("git", ["diff", "--cached", "--quiet"], localOpts);
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status !== 1) throw error;
    execFileSync("git", ["commit", "-m", "Initial commit"], localOpts);
  }

  // A normal push fails closed on divergence; this tool never overwrites a
  // remote branch or renames the user's current local branch.
  try {
    refuseRepositoryHooks(projectPath, childEnv);
  } catch (error) {
    throw new Error(`Refusing credentialed push while Git hooks are configured: ${error instanceof Error ? error.message : String(error)}.`);
  }
  execFileSync("git", ["push", "-u", "origin", "HEAD:main"], pushOpts);
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
        "Requires GitHub CLI authentication or a GITHUB_TOKEN/GH_TOKEN environment variable with repository access.",
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
        visibility: z.enum(["public", "private"]).default("private").describe("Repository visibility"),
      },
      annotations: {
        destructiveHint: true,
      },
    },
    async ({ name, description, path: projectPath, visibility }) => {
      // Credentials are read from the MCP host, never accepted in tool arguments.
      let token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
      if (!token) {
        try {
          const ghToken = execFileSync("gh", ["auth", "token"], {
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"],
          }).trim();
          if (ghToken) token = ghToken;
        } catch { /* gh CLI not available */ }
      }
      if (!token) {
        return errorResponse(
          "MISSING_TOKEN",
          "GitHub authentication is required, but no GitHub CLI session or GITHUB_TOKEN/GH_TOKEN environment variable was found.",
          "Run `gh auth login`, or set GITHUB_TOKEN/GH_TOKEN in the MCP process environment. Do not pass credentials in chat or tool arguments."
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
              "Inspect the local Git status and remote history, confirm Git authentication is configured, then push without force after resolving any divergence: git push -u origin HEAD:main"
            );
          }

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
