/**
 * varity_create_repo - Create GitHub repo with Varity template
 *
 * Enables true 60-second browser workflow by scaffolding templates via GitHub API
 */

import { z } from "zod";
import { execSync } from "node:child_process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { successResponse, errorResponse } from "../utils/responses.js";

const CreateRepoInputSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(100)
    .regex(
      /^[a-z0-9-]+$/,
      "Repository name must be lowercase letters, numbers, and hyphens only"
    ),
  description: z.string().optional(),
  template: z.enum(["saas-starter"]).default("saas-starter"),
  visibility: z.enum(["public", "private"]).default("public"),
  github_token: z
    .string()
    .optional()
    .describe("GitHub personal access token (classic) with repo scope"),
});

type CreateRepoInput = z.infer<typeof CreateRepoInputSchema>;

interface GitHubRepo {
  full_name: string;
  html_url: string;
  clone_url: string;
  ssh_url: string;
}

/**
 * Create GitHub repository via API
 */
async function createGitHubRepo(
  name: string,
  description: string | undefined,
  visibility: "public" | "private",
  token: string
): Promise<GitHubRepo> {
  // Use GitHub's template repository API — creates a full copy of the template
  // including all files, in one API call. No manual tree copying needed.
  const templateRepo = "varity-labs/varity-saas-template";
  const response = await fetch(
    `https://api.github.com/repos/${templateRepo}/generate`,
    {
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
        include_all_branches: false,
      }),
    }
  );

  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: response.statusText }));
    if (response.status === 422 && error.message?.includes("already exists")) {
      throw new Error(`Repository '${name}' already exists`);
    }
    throw new Error(
      error.message || `GitHub API error: ${response.statusText}`
    );
  }

  return response.json();
}

/**
 * Push template files to repo via GitHub API
 */
async function pushTemplateFiles(
  repoFullName: string,
  template: string,
  token: string
): Promise<void> {
  // Get template files from varity-saas-template repo
  const templateRepo = "varity-labs/varity-saas-template";

  // Get default branch SHA
  const refResponse = await fetch(
    `https://api.github.com/repos/${repoFullName}/git/refs/heads/main`,
    {
      headers: {
        Authorization: `token ${token}`,
        Accept: "application/vnd.github.v3+json",
      },
    }
  );

  if (!refResponse.ok) {
    throw new Error("Failed to get repository ref");
  }

  const refData = await refResponse.json();
  const latestCommitSha = refData.object.sha;

  // Get latest commit
  const commitResponse = await fetch(
    `https://api.github.com/repos/${repoFullName}/git/commits/${latestCommitSha}`,
    {
      headers: {
        Authorization: `token ${token}`,
        Accept: "application/vnd.github.v3+json",
      },
    }
  );

  if (!commitResponse.ok) {
    throw new Error("Failed to get commit");
  }

  const commitData = await commitResponse.json();
  const baseTreeSha = commitData.tree.sha;

  // Get template tree from varity-saas-template
  const templateTreeResponse = await fetch(
    `https://api.github.com/repos/${templateRepo}/git/trees/main?recursive=1`,
    {
      headers: {
        Accept: "application/vnd.github.v3+json",
      },
    }
  );

  if (!templateTreeResponse.ok) {
    throw new Error("Failed to fetch template files");
  }

  const templateTree = await templateTreeResponse.json();

  // Filter out .git directory and create new tree
  const filteredTree = templateTree.tree
    .filter((item: any) => !item.path.startsWith(".git"))
    .map((item: any) => ({
      path: item.path,
      mode: item.mode,
      type: item.type,
      sha: item.sha,
    }));

  // Create new tree
  const newTreeResponse = await fetch(
    `https://api.github.com/repos/${repoFullName}/git/trees`,
    {
      method: "POST",
      headers: {
        Authorization: `token ${token}`,
        Accept: "application/vnd.github.v3+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        base_tree: baseTreeSha,
        tree: filteredTree,
      }),
    }
  );

  if (!newTreeResponse.ok) {
    const errBody = await newTreeResponse.text().catch(() => "");
    throw new Error(
      newTreeResponse.status === 422
        ? `Template sync error — the Varity SaaS template needs to be updated. This is a known issue. As a workaround, use varity_init to scaffold locally, then push to GitHub manually with: git init && git remote add origin https://github.com/YOUR_USER/${repoFullName.split("/").pop()}.git && git push -u origin main`
        : `Failed to create repository: ${newTreeResponse.status} ${errBody.slice(0, 200)}. Ensure your GitHub token has the 'repo' scope.`
    );
  }

  const newTree = await newTreeResponse.json();

  // Create new commit
  const newCommitResponse = await fetch(
    `https://api.github.com/repos/${repoFullName}/git/commits`,
    {
      method: "POST",
      headers: {
        Authorization: `token ${token}`,
        Accept: "application/vnd.github.v3+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message: "Initialize Varity SaaS template",
        tree: newTree.sha,
        parents: [latestCommitSha],
      }),
    }
  );

  if (!newCommitResponse.ok) {
    throw new Error("Failed to create commit");
  }

  const newCommit = await newCommitResponse.json();

  // Update main branch to point to new commit
  const updateRefResponse = await fetch(
    `https://api.github.com/repos/${repoFullName}/git/refs/heads/main`,
    {
      method: "PATCH",
      headers: {
        Authorization: `token ${token}`,
        Accept: "application/vnd.github.v3+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        sha: newCommit.sha,
        force: false,
      }),
    }
  );

  if (!updateRefResponse.ok) {
    throw new Error("Failed to update branch");
  }
}

/**
 * Tool handler
 */
async function handleCreateRepo(input: CreateRepoInput) {
  // Resolve token BEFORE the outer try/catch so MISSING_TOKEN is never
  // accidentally wrapped in the generic "CREATE_FAILED" error message.
  let token = input.github_token || process.env.GITHUB_TOKEN;

  if (!token) {
    // Try to get token from the GitHub CLI if it's installed and authenticated
    try {
      const ghToken = execSync("gh auth token", { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
      if (ghToken) {
        token = ghToken;
      }
    } catch {
      // gh CLI not available or not authenticated — fall through to error
    }
  }

  if (!token) {
    return errorResponse(
      "MISSING_TOKEN",
      "GitHub token required. Either pass github_token parameter or set GITHUB_TOKEN environment variable.",
      "Get a token from https://github.com/settings/tokens (needs 'repo' scope). Tip: Install the GitHub CLI (gh) and run 'gh auth login' for automatic token detection."
    );
  }

  try {
    // Create repository
    const repo = await createGitHubRepo(
      input.name,
      input.description,
      input.visibility,
      token
    );

    // Template files are already in the repo — GitHub's template API copies everything.
    // No manual pushTemplateFiles needed.

    // Generate quick-start URLs
    const gitpodUrl = `https://gitpod.io/#${repo.html_url}`;
    const stackblitzUrl = `https://stackblitz.com/github/${repo.full_name}`;
    const codespaceUrl = `https://github.com/codespaces/new?hide_repo_select=true&ref=main&repo=${repo.full_name}`;

    return successResponse({
      repository: {
        name: repo.full_name,
        url: repo.html_url,
        clone_url: repo.clone_url,
        ssh_url: repo.ssh_url,
      },
      template: input.template,
      quick_start: {
        gitpod: gitpodUrl,
        stackblitz: stackblitzUrl,
        codespace: codespaceUrl,
      },
      next_steps: [
        `Option A — Local development: (1) Clone the repo: git clone ${repo.clone_url}, (2) Call varity_install_deps to install dependencies, (3) Call varity_dev_server to start the local server`,
        `Option B — Browser IDE (no local setup): Open ${gitpodUrl} — dependencies install automatically`,
        "Then deploy: Call varity_deploy to go live in ~60 seconds",
      ],
    }, `Repository created: ${repo.html_url}\n\nQuick start: ${gitpodUrl}`);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return errorResponse(
        "INVALID_INPUT",
        error.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join(", ")
      );
    }

    const message = error instanceof Error ? error.message : String(error);

    if (message.includes("already exists")) {
      // Auto-retry with sequential suffixes (name-2, name-3, ... name-9) so the
      // renamed repo looks intentional rather than random. Fall back to a random
      // suffix only if all sequential names are also taken.
      let altRepo: GitHubRepo | null = null;
      let altName = "";

      let takenCount = 1; // original name already exists
      for (let i = 2; i <= 99; i++) {
        altName = `${input.name}-${i}`;
        try {
          altRepo = await createGitHubRepo(altName, input.description, input.visibility, token!);
          break; // success — stop trying
        } catch (retryErr) {
          const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
          if (!retryMsg.includes("already exists")) {
            // Unexpected error — surface it immediately
            return errorResponse("CREATE_FAILED", `Failed to create repository: ${retryMsg}`);
          }
          // name-N is also taken — try the next number
          takenCount++;
        }
      }

      if (!altRepo) {
        // All sequential names taken — last resort: random suffix
        const suffix = Math.random().toString(36).substring(2, 6);
        altName = `${input.name}-${suffix}`;
        try {
          altRepo = await createGitHubRepo(altName, input.description, input.visibility, token!);
        } catch {
          return errorResponse(
            "REPO_EXISTS",
            `Repository '${input.name}' already exists and all auto-rename attempts failed.`,
            `Try a different name or delete the existing repo at https://github.com/settings/repositories`
          );
        }
      }

      const gitpodUrl = `https://gitpod.io/#${altRepo.html_url}`;
      const countNote = takenCount === 1
        ? `'${input.name}' already exists in your account`
        : `${takenCount} repos named '${input.name}' (and variants) already exist in your account`;
      return successResponse({
        created_name: altName,
        requested_name: input.name,
        repository: { name: altRepo.full_name, url: altRepo.html_url, clone_url: altRepo.clone_url, ssh_url: altRepo.ssh_url },
        template: input.template,
        name_collision_note: `⚠️ '${input.name}' was already taken — your repository was created as '${altName}'. Use '${altName}' everywhere: when cloning, sharing links, or referencing this repo. ${countNote}.`,
        quick_start: { gitpod: gitpodUrl, stackblitz: `https://stackblitz.com/github/${altRepo.full_name}`, codespace: `https://github.com/codespaces/new?hide_repo_select=true&ref=main&repo=${altRepo.full_name}` },
        next_steps: [
          `⚠️ Your repo was created as '${altName}' (not '${input.name}') — use this name when cloning or sharing`,
          `Option A — Local: (1) Clone: git clone ${altRepo.clone_url}, (2) Call varity_install_deps, (3) Call varity_dev_server`,
          `Option B — Browser IDE: Open ${gitpodUrl} — dependencies install automatically`,
          "Then deploy: Call varity_deploy to go live in ~60 seconds",
        ],
      }, `Repository created as '${altName}' (your requested name '${input.name}' was already taken).\n\nOpen to start building: ${gitpodUrl}`);
    }

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

    // Template sync / 422 errors already contain a specific, actionable message — surface directly.
    if (message.startsWith("Template sync error") || message.includes("422")) {
      return errorResponse("TEMPLATE_SYNC_ERROR", message);
    }

    return errorResponse("CREATE_FAILED", `Failed to create repository: ${message}`);
  }
}

/**
 * Register tool with MCP server
 */
export function registerCreateRepoTool(server: McpServer): void {
  server.registerTool(
    "varity_create_repo",
    {
      title: "Create GitHub Repository",
      description:
        "Create a new GitHub repository with Varity SaaS template. Enables 60-second app creation from browser - creates repo with full template code, ready to open in Gitpod/StackBlitz and deploy via varity_deploy. Requires GitHub personal access token (classic) with repo scope from https://github.com/settings/tokens. Note: if the requested name is already taken, the tool automatically tries sequential suffixes (my-app-2, my-app-3, … my-app-N) until it finds an available one. If you have many test repos, the suffix could be a larger number (e.g., my-app-10). The actual repo name created is always returned in the response — check it before sharing or cloning.",
      inputSchema: {
        name: z
          .string()
          .min(1)
          .max(100)
          .regex(
            /^[a-z0-9-]+$/,
            "Repository name must be lowercase letters, numbers, and hyphens only"
          )
          .describe("Repository name (lowercase, hyphens allowed, e.g. 'my-saas-app')"),
        description: z
          .string()
          .optional()
          .describe("Short description of your app (optional)"),
        template: z
          .enum(["saas-starter"])
          .default("saas-starter")
          .describe("Template to use (currently only saas-starter available)"),
        visibility: z
          .enum(["public", "private"])
          .default("public")
          .describe("Repository visibility"),
        github_token: z
          .string()
          .optional()
          .describe(
            "GitHub personal access token (optional if GITHUB_TOKEN env var is set). Get from https://github.com/settings/tokens - needs 'repo' scope."
          ),
      },
      annotations: {
        destructiveHint: true, // Creates external resource (GitHub repo)
      },
    },
    async ({ name, description, template, visibility, github_token }) => {
      return handleCreateRepo({ name, description, template, visibility, github_token });
    }
  );
}
