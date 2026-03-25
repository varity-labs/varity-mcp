/**
 * varity_create_repo - Create GitHub repo with Varity template
 *
 * Enables true 60-second browser workflow by scaffolding templates via GitHub API
 */

import { z } from "zod";
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
      auto_init: true, // Initialize with README
    }),
  });

  if (!response.ok) {
    const error = await response.json();
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
    throw new Error("Failed to create tree");
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
  try {
    // Validate GitHub token
    const token = input.github_token || process.env.GITHUB_TOKEN;
    if (!token) {
      return errorResponse(
        "MISSING_TOKEN",
        "GitHub token required. Either pass github_token parameter or set GITHUB_TOKEN environment variable.",
        "Get a token from https://github.com/settings/tokens (needs 'repo' scope)"
      );
    }

    // Create repository
    const repo = await createGitHubRepo(
      input.name,
      input.description,
      input.visibility,
      token
    );

    // Push template files
    await pushTemplateFiles(repo.full_name, input.template, token);

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
        `1. Open in browser IDE: ${gitpodUrl}`,
        "2. Wait for environment to load (installs dependencies automatically)",
        '3. In Claude.ai/ChatGPT, prompt: "Deploy this app"',
        "4. MCP will call varity_deploy and return live URL",
        "5. Your app is live in ~60 seconds total!",
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
      return errorResponse(
        "REPO_EXISTS",
        `Repository '${input.name}' already exists in your account`,
        "Choose a different name or delete the existing repository"
      );
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
        "Create a new GitHub repository with Varity SaaS template. Enables 60-second app creation from browser - creates repo with full template code, ready to open in Gitpod/StackBlitz and deploy via varity_deploy. Requires GitHub personal access token (classic) with repo scope from https://github.com/settings/tokens",
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
