import { CHAT_AND_BUILD_URL } from "../utils/public-api.js";

/**
 * The stdio server's MCP `instructions` (journey 2.3.29 r3: clients put
 * instructions in the system prompt). Routes the user's own folder to
 * varity_deploy and, when Varity cannot take a folder, to Chat and Build;
 * it names no other host (directory policy, PLAN-R1 M1). The
 * hosted surface has no local folder and keeps its own text
 * (`toolsets/remote.ts`). At most 512 characters: some hosts read no more.
 */
export const SERVER_RULES =
  "Varity deploys the folder the user is working in: call varity_deploy with path set to the absolute project folder. " +
  "Varity packs it (honouring .gitignore, keeping secret files on this computer), keeps a private copy and builds it; " +
  "then call varity_deploy_status with the returned id until it is live. Sign in with varity_login; never ask for a key in chat. " +
  `If varity_deploy answers UPLOAD_UNAVAILABLE, offer Varity's Chat and Build: ${CHAT_AND_BUILD_URL}`;
