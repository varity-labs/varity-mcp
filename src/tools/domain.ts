import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorResponse, successResponse } from "../utils/responses.js";
import {
  attachCustomDomain,
  removeCustomDomain,
  verifyCustomDomain,
  VarityPublicApiError,
  type CustomDomainAnswer,
  type CustomDomainClaim,
} from "../utils/public-api.js";

/**
 * Custom domains over the gateway's owner-scoped `PUT|DELETE
 * /api/deployments/:id/domain` and `POST .../domain/verify` (gateway
 * `routes/custom-domains.ts`). The DNS record to add is read from the served
 * claim (`recordType`, `recordName`, `expectedCname` | `expectedA` +
 * `challenge`), never computed here.
 */

const NOT_SUPPORTED =
  "This app has no public web address to point a domain at (for example, it failed to deploy or it does not serve a website or API).";

/** The DNS records the user adds at their domain registrar, in plain words. */
export function dnsInstructions(claim: CustomDomainClaim): string | null {
  const hostname = claim.hostname ?? "";
  if (claim.recordType === "a") {
    if (!claim.expectedA || !claim.challenge?.name || !claim.challenge.value) return null;
    const txtName = claim.challenge.name.endsWith(`.${hostname}`)
      ? claim.challenge.name.slice(0, -(hostname.length + 1))
      : claim.challenge.name;
    return `At the company where ${hostname} is registered, add two DNS records: ` +
      `an A record with Host "${claim.recordName ?? "@"}" and Value "${claim.expectedA}", ` +
      `and a TXT record with Host "${txtName}" and Value "${claim.challenge.value}".`;
  }
  if (!claim.expectedCname) return null;
  const name = claim.recordName ?? hostname;
  return `At the company where the domain is registered, add a CNAME record with Host "${name}" and Value "${claim.expectedCname}" for ${hostname}.`;
}

/** Where the claim stands (served `state` and `dns.status`), in plain words. */
export function domainState(claim: CustomDomainClaim): string {
  const hostname = claim.hostname ?? "the domain";
  switch (claim.state) {
    case "active":
      return `${hostname} is live at https://${hostname}.`;
    case "certificate_pending":
      return `The DNS record for ${hostname} is correct; the secure (https) certificate is being set up. Check again in a few minutes with varity_domain_verify.`;
    case "error":
      return `Setting up ${hostname} hit a problem${claim.errorCode ? ` (${claim.errorCode})` : ""}. Check the DNS record below, then run varity_domain_verify again.`;
    default:
      return claim.dns?.status === "mismatch"
        ? `A DNS record for ${hostname} was found but does not match yet. Check it against the record below; DNS changes can take a while to show.`
        : `Varity is waiting for the DNS record for ${hostname}. Once it is added, run varity_domain_verify (DNS changes can take a while to show).`;
  }
}

function answer(deployment: string, served: CustomDomainAnswer, lead: string) {
  if (served.supported === false) return errorResponse("custom_domains_not_supported", NOT_SUPPORTED, "Deploy a website or API first, then add the domain.");
  const claim = served.domain;
  if (!claim) return errorResponse("custom_domain_unavailable", "Varity did not return the domain's details.", "Retry in a moment.");
  const dns = claim.state === "active" ? null : dnsInstructions(claim);
  return successResponse(
    { deployment, domain: claim, ...(dns ? { dns_instructions: dns } : {}) },
    [lead, domainState(claim), dns].filter(Boolean).join(" ")
  );
}

function failure(err: unknown) {
  if (err instanceof VarityPublicApiError && err.code === "custom_domains_not_supported") {
    return errorResponse(err.code, NOT_SUPPORTED, "Deploy a website or API first, then add the domain.");
  }
  if (err instanceof VarityPublicApiError) {
    return errorResponse(err.code, err.message, err.action ?? "Check the deployment with varity_deploy_status, then retry.");
  }
  return errorResponse("custom_domain_unavailable", "The custom domain request failed.", "Retry in a moment.");
}

const deploymentInput = z
  .string()
  .regex(/^[a-zA-Z0-9_-]+$/, "Invalid deployment id or app name")
  .describe("The deployment id or app name.");

export function registerDomainTools(server: McpServer): void {
  server.registerTool(
    "varity_domain_add",
    {
      title: "Add a Custom Domain",
      description:
        "Point the user's own domain (e.g. app.example.com or example.com) at a deployed app. Returns the exact DNS record " +
        "to add at their domain registrar, in plain words. Then call varity_domain_verify.",
      inputSchema: {
        deployment: deploymentInput,
        hostname: z.string().min(3).max(253).describe("The domain or subdomain, e.g. app.example.com."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ deployment, hostname }) => {
      try {
        return answer(deployment, await attachCustomDomain(deployment, hostname), `Added ${hostname} to ${deployment}.`);
      } catch (err) {
        return failure(err);
      }
    }
  );

  server.registerTool(
    "varity_domain_verify",
    {
      title: "Check a Custom Domain",
      description:
        "Check whether the DNS record for an app's custom domain is in place and whether the domain is live.",
      inputSchema: { deployment: deploymentInput },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ deployment }) => {
      try {
        return answer(deployment, await verifyCustomDomain(deployment), "");
      } catch (err) {
        return failure(err);
      }
    }
  );

  server.registerTool(
    "varity_domain_remove",
    {
      title: "Remove a Custom Domain",
      description:
        "Stop serving an app at its custom domain. The app keeps its Varity web address; the DNS record can then be deleted at the registrar.",
      inputSchema: { deployment: deploymentInput },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ deployment }) => {
      try {
        await removeCustomDomain(deployment);
        return successResponse(
          { deployment, removed: true },
          `The custom domain was removed from ${deployment}. The app still serves at its Varity address; the DNS record can now be deleted at the registrar.`
        );
      } catch (err) {
        return failure(err);
      }
    }
  );
}
