import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { publicApiRequest, VarityPublicApiError } from "../utils/public-api.js";
import { errorResponse, successResponse } from "../utils/responses.js";

const profileId = z.string().regex(/^gpo-[a-f0-9]{24}$/).describe("Profile id from varity_gpu_containers_profiles.");
const refresh = "Refresh varity_gpu_containers_profiles, then request a new quote with varity_gpu_containers_quote.";

/** Thin public-interface adapter: the owner selects runtime, seals price and runs lifecycle. */
export function registerGpuContainerTools(server: McpServer): void {
  const failure = (err: unknown) => err instanceof VarityPublicApiError
    ? errorResponse(err.code, err.message, err.action ?? refresh)
    : errorResponse("GPU_CONTAINER_REQUEST_FAILED", "The GPU container request failed.", "Retry the request.");

  server.registerTool("varity_gpu_containers_profiles", {
    title: "GPU Container Profiles",
    description: "Read current supported GPU container profiles, runtime, SSH requirements, prices and availability. Unknown facts remain unknown. Request an exact quote before creating.",
    annotations: { readOnlyHint: true },
    inputSchema: {},
  }, async () => {
    try {
      const catalog = await publicApiRequest<Record<string, unknown>>("GET",
        "/api/deployment-profiles?workload=gpu&execution_class=container&contract_version=gpu-container-profiles-v2");
      return successResponse(catalog, "GPU container profiles as reported by Varity. Availability can change; request an exact quote before creating.");
    } catch (err) { return failure(err); }
  });

  server.registerTool("varity_gpu_containers_quote", {
    title: "Quote a GPU Container",
    description: "Get an exact owner-bound GPU container quote for a supported profile. Review the served price, authorization and expiry with the customer; pass their approved quote token explicitly to varity_gpu_containers_create.",
    inputSchema: { profile_id: profileId },
  }, async ({ profile_id }) => {
    try {
      const quote = await publicApiRequest<Record<string, unknown>>("POST", "/api/pricing/accelerator-quote", {
        body: { execution_class: "container", profile_id },
      });
      return successResponse(quote, "Review this exact quote with the customer before creating. Use its quote_token as accelerator_quote_token in varity_gpu_containers_create.");
    } catch (err) { return failure(err); }
  });

  server.registerTool("varity_gpu_containers_create", {
    title: "Create a GPU Container",
    description: "Create a GPU container using a customer-approved exact quote token and the customer's SSH PUBLIC key. Only the matching private key holder can log in. Acceptance is not live workload proof. Use varity_deploy_status for SSH access and lifecycle, and varity_delete_deployment when finished; verify billing.state stopped afterward.",
    inputSchema: {
      name: z.string().min(1).max(63).regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/),
      profile_id: profileId,
      ssh_public_key: z.string().min(1).max(10_000)
        .regex(/^[\x20-\x7E]+$/, "Pass the SSH PUBLIC key on one line.")
        .refine((key) => !/PRIVATE KEY|BEGIN OPENSSH|BEGIN RSA|BEGIN EC/i.test(key), "Pass the PUBLIC key (.pub), never a private key."),
      accelerator_quote_token: z.string().min(16).max(8_192).describe("The customer-approved quote_token from varity_gpu_containers_quote; never invented or refreshed automatically."),
      idempotency_key: z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/).optional()
        .describe("Reuse the same key and request when retrying an ambiguous create."),
    },
  }, async ({ name, profile_id, ssh_public_key, accelerator_quote_token, idempotency_key }) => {
    try {
      const accepted = await publicApiRequest<Record<string, unknown>>("POST", "/api/deployments", {
        body: { name, execution_class: "container", profile_id, ssh_public_key, accelerator_quote_token },
        idempotencyKey: idempotency_key ?? `mcp-gpu-create:${randomUUID()}`,
      });
      return successResponse(accepted, "GPU container create accepted; this is not proof it is live. Poll varity_deploy_status for SSH access and lifecycle. Use the private key matching your supplied public key. Delete with varity_delete_deployment when finished, then confirm billing.state stopped with varity_deploy_status.");
    } catch (err) { return failure(err); }
  });
}
