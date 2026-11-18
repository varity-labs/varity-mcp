import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  SOURCE_CAPS,
  buildSourceArchive,
  isSecretPath,
  isUnsafeName,
  type ArchiveFile,
} from "../utils/source-archive.js";

/**
 * Packs a project folder into an upload source archive (stdio only: it reads
 * the invoking user's filesystem). Honors every `.gitignore` in the tree plus
 * the default excludes, never follows a symlink, and keeps secret files
 * (IF-SECRET-PATHS) on the machine. The server validates the archive again and
 * is authoritative; these checks exist so a refusal happens before upload and
 * names what was left out.
 */

/** Dependencies, build output and VCS data the cloud build recreates or never needs. */
const DEFAULT_EXCLUDES = [
  ".git/",
  "node_modules/",
  "__pycache__/",
  "*.pyc",
  "dist/",
  "build/",
  ".next/",
  ".venv/",
  "venv/",
  ".DS_Store",
];

interface Rule {
  base: string;
  pattern: RegExp;
  negate: boolean;
  directoryOnly: boolean;
}

function globToRegex(glob: string): string {
  let out = "";
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i]!;
    if (char === "*") {
      if (glob[i + 1] === "*") {
        const slash = glob[i + 2] === "/";
        out += slash ? "(?:.*/)?" : ".*";
        i += slash ? 2 : 1;
      } else {
        out += "[^/]*";
      }
    } else if (char === "?") {
      out += "[^/]";
    } else if (char === "[") {
      const end = glob.indexOf("]", i + 1);
      if (end === -1) {
        out += "\\[";
      } else {
        out += `[${glob.slice(i + 1, end).replace(/^!/, "^").replace(/\\/g, "\\\\")}]`;
        i = end;
      }
    } else if (char === "\\" && i + 1 < glob.length) {
      out += glob[i + 1]!.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
      i += 1;
    } else {
      out += char.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
    }
  }
  return out;
}

/** `.gitignore` lines as rules scoped to `base` (the directory holding the file, "" for the root). */
export function parseIgnore(text: string, base: string): Rule[] {
  const rules: Rule[] = [];
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.replace(/(?<!\\)\s+$/, "");
    if (!line || line.startsWith("#")) continue;
    const negate = line.startsWith("!");
    if (negate) line = line.slice(1);
    if (line.startsWith("\\#") || line.startsWith("\\!")) line = line.slice(1);
    const directoryOnly = line.endsWith("/");
    if (directoryOnly) line = line.replace(/\/+$/, "");
    if (!line) continue;
    const anchored = line.includes("/");
    line = line.replace(/^\//, "");
    const body = globToRegex(line);
    rules.push({
      base,
      pattern: new RegExp(anchored ? `^${body}$` : `^(?:.*/)?${body}$`),
      negate,
      directoryOnly,
    });
  }
  return rules;
}

function ignored(rules: readonly Rule[], path: string, isDirectory: boolean): boolean {
  let result = false;
  for (const rule of rules) {
    if (rule.directoryOnly && !isDirectory) continue;
    if (rule.base && !path.startsWith(`${rule.base}/`)) continue;
    const relative = rule.base ? path.slice(rule.base.length + 1) : path;
    if (rule.pattern.test(relative)) result = !rule.negate;
  }
  return result;
}

export interface PackedFolder {
  archive: Buffer;
  fileCount: number;
  uncompressedBytes: number;
  /** Files and folders left out (gitignored, dependencies, build output, links). */
  excludedCount: number;
  /** Secret files kept on the machine, by relative path only. */
  secretPaths: string[];
}

/** A pack that cannot be uploaded; `message` is plain copy for the user. */
export class PackRefused extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly action: string,
  ) {
    super(message);
  }
}

const MB = 1024 * 1024;

/** A path safe to show: control characters replaced. */
function printable(path: string): string {
  return path.replace(/[\u0000-\u001f\u007f-\u009f]/g, "?");
}

export async function packFolder(root: string): Promise<PackedFolder> {
  const files: ArchiveFile[] = [];
  const secretPaths: string[] = [];
  let excludedCount = 0;
  let uncompressedBytes = 0;
  const defaults = parseIgnore(DEFAULT_EXCLUDES.join("\n"), "");

  async function walk(directory: string, relativeDirectory: string, inherited: Rule[]): Promise<void> {
    let rules = inherited;
    try {
      const text = await readFile(join(directory, ".gitignore"), "utf8");
      rules = [...inherited, ...parseIgnore(text, relativeDirectory)];
    } catch {
      // no .gitignore here
    }
    const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
    for (const entry of entries) {
      const path = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const absolute = join(directory, entry.name);
      const isDirectory = entry.isDirectory();
      // A .git directory, or the .git file of a worktree or submodule: never source.
      if (entry.name.toLowerCase() === ".git") continue;
      if (isSecretPath(path)) {
        secretPaths.push(printable(isDirectory ? `${path}/` : path));
        continue;
      }
      if (ignored(defaults, path, isDirectory) || ignored(rules, path, isDirectory)) {
        excludedCount += 1;
        continue;
      }
      if (isDirectory) {
        await walk(absolute, path, rules);
        continue;
      }
      // Never follow a link: it could point outside the project (e.g. at ~/.ssh).
      if (!entry.isFile()) {
        excludedCount += 1;
        continue;
      }
      if (isUnsafeName(path)) {
        throw new PackRefused(
          "UNSAFE_FILE_NAME",
          `The file name "${printable(path)}" contains a character Varity cannot store, so nothing was uploaded.`,
          "Rename that file (no backslashes or control characters) and deploy again.",
        );
      }
      if (files.length + 1 > SOURCE_CAPS.maxEntries) {
        throw new PackRefused(
          "TOO_MANY_FILES",
          `This folder has more than ${SOURCE_CAPS.maxEntries.toLocaleString("en-US")} files to upload, so nothing was uploaded.`,
          "Add large generated or data folders to .gitignore, then deploy again.",
        );
      }
      // Size first, so one huge file is refused without being read into memory.
      const stats = await lstat(absolute);
      uncompressedBytes += stats.size;
      if (uncompressedBytes > SOURCE_CAPS.maxUncompressedBytes) {
        throw new PackRefused(
          "FOLDER_TOO_LARGE",
          `This folder is larger than ${SOURCE_CAPS.maxUncompressedBytes / MB} MB of files to upload, so nothing was uploaded.`,
          "Add large generated, media or data folders to .gitignore, then deploy again.",
        );
      }
      files.push({ path, data: await readFile(absolute), executable: (stats.mode & 0o111) !== 0 });
    }
  }

  await walk(root, "", []);
  if (files.length === 0) {
    throw new PackRefused(
      "NOTHING_TO_UPLOAD",
      "This folder has no files to upload after leaving out ignored and secret files, so nothing was uploaded.",
      "Check that the path points at the project folder.",
    );
  }
  const { archive, tarBytes } = await buildSourceArchive(files);
  if (archive.length > SOURCE_CAPS.maxCompressedBytes) {
    throw new PackRefused(
      "FOLDER_TOO_LARGE",
      `This folder compresses to ${(archive.length / MB).toFixed(1)} MB, over the ${SOURCE_CAPS.maxCompressedBytes / MB} MB upload limit, so nothing was uploaded.`,
      "Add large generated, media or data folders to .gitignore, then deploy again.",
    );
  }
  // The server measures the whole tar stream (headers included) with one record of slack.
  if (tarBytes > SOURCE_CAPS.maxRatio * archive.length + 20 * 512) {
    throw new PackRefused(
      "FOLDER_NOT_UPLOADABLE",
      "This folder holds files that compress unusually far (more than 100 to 1), which Varity refuses, so nothing was uploaded.",
      "Add large generated or padding files to .gitignore, then deploy again.",
    );
  }
  return { archive, fileCount: files.length, uncompressedBytes, excludedCount, secretPaths };
}
