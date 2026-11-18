import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, parse, resolve, sep } from "node:path";
import { PackRefused, packFolder } from "./pack.js";
import { errorResponse } from "../utils/responses.js";
import type { LocalSource } from "./deploy.js";

/**
 * The stdio deploy source: a project directory, its Git `origin` remote, and
 * the folder packer for an upload. Reads the invoking user's filesystem, so
 * only the local toolset injects it into `registerDeployTool`.
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

/**
 * Resolves the project folder and its `origin` remote (null when it has none).
 * An upload needs an explicit path: the server's working directory is rarely
 * the project, and the home directory or filesystem root is never one.
 */
export const localDeploySource: LocalSource = {
  async resolve(path) {
    const folder = resolve(path || process.cwd());
    try {
      await access(folder);
    } catch {
      return errorResponse(
        "PATH_NOT_FOUND",
        `Project directory does not exist: ${folder}`,
        "Check the path and ensure the project directory exists."
      );
    }
    return { folder, repoUrl: await detectGitRemote(folder), explicit: Boolean(path) };
  },
  pack: (folder) => {
    const home = resolve(homedir());
    if (folder === home || folder === parse(folder).root || home.startsWith(folder + sep)) {
      throw new PackRefused(
        "NOT_A_PROJECT_FOLDER",
        `${folder} is a home or root folder, not a project, so nothing was uploaded.`,
        "Pass the absolute path of the project folder itself."
      );
    }
    return packFolder(folder);
  },
};
