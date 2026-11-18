import { CHAT_AND_BUILD_URL } from "../utils/public-api.js";

/**
 * The stdio server's MCP `instructions` (journey 2.3.29 r3: clients put
 * instructions in the system prompt). Routes the user's own folder to
 * varity_deploy and, when Varity cannot take a folder yet, to Chat and
 * Build; it promises nothing this version does not do (R1 SP-1) and names no
 * other host (directory policy, PLAN-R1 M1). The hosted surface has no local
 * folder and keeps its own text (`toolsets/remote.ts`). At most 512
 * characters: some hosts read no more.
 */
export const SERVER_RULES =
  "To deploy the folder the user is working in, call varity_deploy with path set to the absolute project folder, " +
  "then varity_deploy_status with the returned id until it is live. " +
  `If varity_deploy answers UPLOAD_UNAVAILABLE, offer Varity's Chat and Build: ${CHAT_AND_BUILD_URL} ` +
  "Sign in with varity_login; never ask for a key in chat.";
