import { CHAT_AND_BUILD_URL } from "../utils/public-api.js";

/**
 * `varity_deploy`'s model-visible copy: its description, the `path` and
 * `source` texts, and the no-folder remedies its results reuse. Behaviour
 * stays in `deploy.ts`; this module only holds words.
 */

export const NO_FOLDER_YET = "Varity can't take a folder from this computer yet.";

export const NO_GITHUB_PATH =
  `The way to get a site online today without GitHub is Varity's Chat and Build: describe the app, and Varity builds it ` +
  `and publishes it to a live address. No GitHub needed: ${CHAT_AND_BUILD_URL}`;

const CHAT_AND_BUILD_LINE =
  "The way to get it online today without GitHub is Varity's Chat and Build: describe the app, and Varity builds it " +
  `and publishes it to a live address: ${CHAT_AND_BUILD_URL}`;

/**
 * The error message itself (P1 T3, r3): one quoted paragraph to say verbatim
 * (the pattern that held for sign-in), then the developer options, public
 * GitHub only if asked.
 */
export function sayExactly(paragraph: string): string {
  return (
    `Tell the user exactly this: "${paragraph} ${CHAT_AND_BUILD_LINE}" ` +
    "For developers, a ready-made Varity template or a prebuilt container image also works. " +
    "Only if the user asks: make the code public on GitHub and deploy it from there."
  );
}

export const UPLOAD_UNAVAILABLE_ACTION =
  `Tell the user plainly: "${NO_FOLDER_YET} ${NO_GITHUB_PATH}" ` +
  "For developers: a ready-made Varity template (varity_list_templates) or a prebuilt container image (image argument). " +
  "Last, and only if the user decides to make the code public: push it to a public GitHub repository " +
  "(varity_create_repo, then make it public) and deploy its repo_url; ask first.";

/** Validator reasons the gateway serves in `field` on 422 `source_archive_refused`, in plain words. */
export const ARCHIVE_REFUSALS: Readonly<Record<string, string>> = {
  secret_path: "it contains a file that looks like a secret (a key, credential or .env file)",
  unsafe_path: "a file path points outside the project folder",
  unsupported_entry: "it contains something other than plain files",
  too_many_entries: "it has too many files",
  too_large_uncompressed: "its files are too large in total",
  ratio_exceeded: "its files compress unusually far",
  duplicate_path: "it lists the same path twice",
  empty_archive: "it contains no files",
  unsupported_format: "the archive format was not accepted",
};

export const NEEDS_PATH =
  "Pass path as the absolute path of the project folder (the server's working directory is rarely the project), then deploy again.";

/** What happens to a folder (PLAN-R1 M5), as a clause and as a sentence; true only behind the release gate in ARCHITECTURE.md ## Verification. */
const FOLDER_RULE = "a folder without a readable GitHub repository is saved as a private copy Varity keeps (deleted with the deployment) and built.";
const FOLDER_RULE_SENTENCE = "A folder without a readable GitHub repository is saved as a private copy Varity keeps (deleted with the deployment) and built.";

export const PATH_DESCRIPTION =
  "Absolute path to the project directory (e.g. '/home/user/my-app'). " +
  "Used to read the Git `origin` remote when repo_url and image are omitted; " +
  `${FOLDER_RULE} ` +
  "If omitted, the MCP server's working directory is used (which is rarely the correct project root).";

export const SOURCE_DESCRIPTION =
  "Set to \"upload\" to try sending the project folder at path straight to Varity. " +
  "Tried automatically when the folder has no Git origin remote or its repository is private. " +
  "If Varity cannot take the folder yet, nothing is sent or charged and the answer says so.";

/** The tool description; `local` adds the folder rules (stdio only). */
export function deployDescription(local: boolean): string {
  return (
    "Submit a Git repository, a local project folder, or a prebuilt container image to Varity's deployment owner. " +
    (local ? `${FOLDER_RULE_SENTENCE} If it answers UPLOAD_UNAVAILABLE, ${NO_FOLDER_YET} ` : "") +
    "The control plane detects the framework, selects hosting, builds, and manages lifecycle state. " +
    "Use this when a developer wants to deploy, publish, ship, or make their app live. " +
    "If the developer wants to deploy a certified template rather than their own code, " +
    "use varity_deploy_template instead. To ship new code for an app that is already deployed, push it and call " +
    "varity_deploy again with the same app_name: the same owner and workload shape updates that app in place at " +
    "the latest commit (varity_redeploy does not pick up new commits). " +
    (local ? "For a folder, call varity_deploy again with the same path and app_name: it sends the folder again and updates that app in place. " : "") +
    "To stop a deployment and its billing, use varity_delete_deployment."
  );
}

export function repoUrlHint(local: boolean): string {
  return local
    ? "If omitted, auto-detected from .git/config. Use the repo_url returned by varity_create_repo as the value here."
    : "Pass repo_url or image.";
}
