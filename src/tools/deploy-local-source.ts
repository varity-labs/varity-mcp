import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { errorResponse } from "../utils/responses.js";
import type { LocalSource } from "./deploy.js";

/**
 * The stdio deploy source: a project directory's Git `origin` remote. Reads
 * the invoking user's filesystem, so only the local toolset injects it into
 * `registerDeployTool`.
 */

/** The `origin` remote of `<project>/.git/config`, as an https URL the backend can clone. */
export async function detectGitRemote(projectPath: string): Promise<string | null> {
  let config: string;
  try {
    config = await readFile(join(projectPath, ".git", "config"), "utf-8");
  } catch {
    return null;
  }
  let inOrigin = false;
  let url: string | null = null;
  for (const raw of config.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      inOrigin = line === '[remote "origin"]';
    } else if (inOrigin && line.startsWith("url") && line.includes("=")) {
      url = line.slice(line.indexOf("=") + 1).trim();
      break;
    }
  }
  if (!url) return null;
  if (url.startsWith("git@")) {
    // git@github.com:owner/repo.git -> https://github.com/owner/repo
    const [host, path] = [url.slice(4, url.indexOf(":")), url.slice(url.indexOf(":") + 1)];
    url = `https://${host}/${path}`;
  }
  return url.replace(/\.git$/, "");
}

export const localDeploySource: LocalSource = async (path) => {
  const cwd = path || process.cwd();
  try {
    await access(cwd);
  } catch {
    return errorResponse(
      "PATH_NOT_FOUND",
      `Project directory does not exist: ${cwd}`,
      "Check the path and ensure the project directory exists."
    );
  }
  const repoUrl = await detectGitRemote(cwd);
  if (!repoUrl) {
    return errorResponse(
      "NO_DEPLOY_SOURCE",
      `No deploy source found for ${cwd}: it has no Git origin remote.`,
      "Varity builds in the cloud from a source it can reach. Push the project with varity_create_repo and pass its repo_url, or pass a prebuilt image."
    );
  }
  return { repoUrl };
};
