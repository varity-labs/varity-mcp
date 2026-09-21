/**
 * varity_create_repo - Create a GitHub repo and push the local project to it.
 *
 * Creates an empty repository and pushes the local project directory to GitHub.
 * A GitHub URL is required for dynamic deployments, so this is the bridge when a
 * developer has code locally but no repository yet.
 */

import { z } from "zod";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { successResponse, errorResponse } from "../utils/responses.js";

interface GitHubRepo {
  full_name: string;
  html_url: string;
  clone_url: string;
  ssh_url: string;
  private: boolean;
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
    const error = await response.json().catch(() => ({ message: response.statusText })) as {
      message?: string;
      errors?: Array<{ code?: string; message?: string }>;
    };
    const nameAlreadyExists = error.errors?.some((item) =>
      item.code === "already_exists" || item.message?.toLowerCase().includes("already exists")
    );
    if (response.status === 422 && (nameAlreadyExists || error.message?.toLowerCase().includes("already exists"))) {
      throw new Error(`Repository '${name}' already exists`);
    }
    throw new Error(error.message || `GitHub API error: ${response.statusText}`);
  }

  return response.json();
}

const DEFAULT_EXCLUDES = [
  ".git/",
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

const SENSITIVE_BASENAMES = new Set([
  ".git-credentials",
  ".npmrc",
  ".pypirc",
  ".netrc",
  ".dockercfg",
  "credentials",
  "credentials.json",
  "application_default_credentials.json",
  "service-account.json",
  "service_account.json",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
]);
const SENSITIVE_DIRECTORIES = new Set([".aws", ".azure", ".kube"]);
const SENSITIVE_EXTENSIONS = new Set([".pem", ".key", ".p12", ".pfx", ".jks", ".keystore"]);

function isSensitivePath(relativePath: string): boolean {
  const normalized = relativePath.split(path.sep).join("/");
  const lowerNormalized = normalized.toLowerCase();
  const segments = normalized.split("/");
  const basename = segments.at(-1) ?? "";
  const lower = basename.toLowerCase();
  return (
    basename.startsWith(".env") ||
    SENSITIVE_BASENAMES.has(lower) ||
    SENSITIVE_EXTENSIONS.has(path.posix.extname(lower)) ||
    segments.some((segment) => SENSITIVE_DIRECTORIES.has(segment.toLowerCase())) ||
    lowerNormalized.includes(".config/gcloud/") ||
    lowerNormalized === ".docker/config.json" ||
    lowerNormalized.endsWith("/.docker/config.json") ||
    lowerNormalized === ".config/gh/hosts.yml" ||
    lowerNormalized.endsWith("/.config/gh/hosts.yml") ||
    /(?:^|[-_])service[-_]?account\.json$/i.test(basename) ||
    /^(?:secret|secrets)\.json$/i.test(basename)
  );
}

function findSensitivePaths(projectPath: string, directory = projectPath): string[] {
  const matches: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = path.join(directory, entry.name);
    const relativePath = path.relative(projectPath, absolutePath).split(path.sep).join("/");
    if (isSensitivePath(relativePath)) {
      matches.push(relativePath);
      continue;
    }
    if (entry.isDirectory() && entry.name !== ".git") {
      matches.push(...findSensitivePaths(projectPath, absolutePath));
    }
  }
  return matches;
}

function refuseSensitivePaths(paths: string[]): void {
  if (paths.length === 0) return;
  throw new Error(
    `Refusing to push credential-bearing paths: ${paths.sort().join(", ")}. ` +
    "Remove them from the project and Git index, and store only reviewed, non-secret examples under different names."
  );
}

function isGitRepository(projectPath: string, env: NodeJS.ProcessEnv): boolean {
  try {
    return execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: projectPath,
      env,
      encoding: "utf8",
      stdio: "pipe",
    }).trim() === "true";
  } catch {
    return false;
  }
}

function gitRepositoryRoot(projectPath: string, env: NodeJS.ProcessEnv): string {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: projectPath,
    env,
    encoding: "utf8",
    stdio: "pipe",
  }).trim();
}

function sanitizedGitEnvironment(): NodeJS.ProcessEnv {
  const childEnv = { ...process.env };
  for (const name of Object.keys(childEnv)) {
    if (
      name.startsWith("GIT_") ||
      name === "GITHUB_TOKEN" ||
      name === "GH_TOKEN"
    ) {
      delete childEnv[name];
    }
  }
  return childEnv;
}

export interface PreparedLocalProject {
  push(cloneUrl: string, token: string): void;
  cleanup(): void;
}

/** Build a reviewed, hook-free snapshot before any remote repository exists. */
export function prepareLocalProject(projectPath: string): PreparedLocalProject {
  const childEnv = sanitizedGitEnvironment();
  refuseSensitivePaths(findSensitivePaths(projectPath));
  const localOpts = {
    cwd: projectPath,
    stdio: "pipe" as const,
    env: childEnv,
  };

  if (isGitRepository(projectPath, childEnv)) {
    const repositoryRoot = gitRepositoryRoot(projectPath, childEnv);
    if (path.resolve(repositoryRoot) !== path.resolve(projectPath)) {
      throw new Error(`Refusing to push parent repository ${repositoryRoot}; pass its exact root path.`);
    }
  }

  const isolatedGitDirectory = mkdtempSync(path.join(tmpdir(), "varity-mcp-repository-"));
  try {
    const isolatedGlobalConfig = path.join(isolatedGitDirectory, "global-config");
    writeFileSync(isolatedGlobalConfig, "");
    const isolatedEnv = {
      ...childEnv,
      GIT_DIR: isolatedGitDirectory,
      GIT_WORK_TREE: projectPath,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: isolatedGlobalConfig,
    };
    const isolatedOpts = { ...localOpts, env: isolatedEnv };
    execFileSync("git", ["init", "--template="], isolatedOpts);
    const isolatedHooksDirectory = path.join(isolatedGitDirectory, "hooks-disabled");
    mkdirSync(isolatedHooksDirectory);
    execFileSync("git", ["config", "core.hooksPath", isolatedHooksDirectory], isolatedOpts);
    execFileSync("git", ["config", "user.email", "varity-mcp@varity.so"], isolatedOpts);
    execFileSync("git", ["config", "user.name", "Varity MCP"], isolatedOpts);
    mkdirSync(path.join(isolatedGitDirectory, "info"), { recursive: true });
    writeFileSync(path.join(isolatedGitDirectory, "info", "exclude"), `${DEFAULT_EXCLUDES.join("\n")}\n`);
    execFileSync("git", ["add", "--", "."], isolatedOpts);
    const stagedPaths = execFileSync("git", ["ls-files", "-z"], {
      ...isolatedOpts,
      encoding: "utf8",
    }).split("\0").filter(Boolean);
    refuseSensitivePaths(stagedPaths.filter((file) => isSensitivePath(file)));
    execFileSync("git", ["commit", "-m", "Initial commit"], isolatedOpts);
    let cleaned = false;
    return {
      push(cloneUrl: string, token: string): void {
        const basicCredential = Buffer.from(`x-access-token:${token}`).toString("base64");
        execFileSync("git", ["push", cloneUrl, "HEAD:main"], {
          ...isolatedOpts,
          env: {
            ...isolatedEnv,
            GIT_TERMINAL_PROMPT: "0",
            // Supported by the repository's Git 2.25 host. The isolated
            // hooks/config boundary prevents child processes from observing it.
            GIT_CONFIG_PARAMETERS:
              `'http.https://github.com/.extraheader=AUTHORIZATION: basic ${basicCredential}' ` +
              `'credential.helper='`,
          },
        });
      },
      cleanup(): void {
        if (cleaned) return;
        cleaned = true;
        rmSync(isolatedGitDirectory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    rmSync(isolatedGitDirectory, { recursive: true, force: true });
    throw error;
  }
}

/** Prepare, push, and clean an isolated snapshot without mutating the caller. */
export function pushLocalProject(projectPath: string, cloneUrl: string, token: string): void {
  const prepared = prepareLocalProject(projectPath);
  try {
    prepared.push(cloneUrl, token);
  } finally {
    prepared.cleanup();
  }
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
          let prepared: PreparedLocalProject;
          try {
            prepared = prepareLocalProject(projectPath);
          } catch (preflightError) {
            return errorResponse(
              "LOCAL_PROJECT_REFUSED",
              `The local project could not be prepared safely: ${preflightError instanceof Error ? preflightError.message : String(preflightError)}`,
              "Review the path and reported credential-bearing files. No GitHub repository was created."
            );
          }
          try {
          // This tool creates a new repository. A same-name repository is never
          // reused: retry with a suffix so requested visibility cannot be
          // bypassed by an existing public repository.
          const result = await createRepoWithRetry(
            (n) => createEmptyGitHubRepo(n, description, visibility, token!),
            name
          );
          const { repo, usedName, wasTaken } = result;
          if (repo.private !== (visibility === "private")) {
            return errorResponse(
              "VISIBILITY_MISMATCH",
              `GitHub created ${repo.html_url} with visibility that does not match the request. No code was pushed.`,
              "Inspect the repository visibility in GitHub before taking any further action."
            );
          }

          // Push the preflighted snapshot only after repository creation.
          try {
            prepared.push(repo.clone_url, token!);
          } catch (pushErr) {
            const pushMsg = pushErr instanceof Error ? pushErr.message : String(pushErr);
            return errorResponse(
              "PUSH_FAILED",
              `Repository created at ${repo.html_url} but failed to push: ${pushMsg}`,
              "Inspect the local Git status and remote history, confirm Git authentication is configured, then push the reviewed commit without force after resolving any divergence."
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
                "Next: pass repo_url from this result to varity_deploy",
              ],
            },
            `Repository created and code pushed: ${repo.html_url}${nameNote ? ` (${nameNote})` : ""}`
          );
          } finally {
            prepared.cleanup();
          }

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
