import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { successResponse, errorResponse } from "../utils/responses.js";
import {
  deployTemplate as postTemplateDeploy,
  getTemplate,
  listTemplates as getTemplates,
  VarityPublicApiError,
  type PublicRunAcceptance,
} from "../utils/public-api.js";
import { acceptanceSummary, lifecycleAcceptance } from "../utils/lifecycle-acceptance.js";
import { monthlyMaximum } from "../utils/money.js";

/**
 * Template tools are a thin projection of the gateway-owned catalog through
 * the one public-API client: `GET /api/templates`, `GET /api/templates/:id`
 * and `POST /api/templates/:id/deploy` (no CLI subprocess).
 */

function catalogError(error: unknown, id?: string) {
  if (id !== undefined && error instanceof VarityPublicApiError && error.code === "template_not_found") {
    return templateNotFound(id);
  }
  if (error instanceof VarityPublicApiError) {
    return errorResponse(error.code, `Could not load Varity templates: ${error.message}`, error.action ?? "Run varity_doctor, then retry.");
  }
  return errorResponse(
    "TEMPLATE_CATALOG_UNAVAILABLE",
    "Could not load Varity templates.",
    "Run varity_doctor, then retry."
  );
}

function templateNotFound(id: string) {
  return errorResponse(
    "TEMPLATE_NOT_FOUND",
    `Unknown or uncertified template "${id}".`,
    `Run varity_list_templates to see certified template IDs.`
  );
}

export interface TemplateMeta {
  id: string;
  name?: string;
  description?: string;
  category?: string;
  framework?: string;
  language?: string;
  tags?: string[];
  requiredEnv?: string[];
  required_env?: string[];
  private?: boolean;
  pricing?: { monthlyUsd?: number | null };
  hardware?: { cpu?: number; memory_gb?: number; ephemeral_gb?: number };
  /** The template's persistent volume, billed with it. */
  volume?: { sizeGb?: number; path?: string } | null;
  resources?: Array<{ kind?: string; engine?: string; label?: string }>;
  certification?: { state?: string; reason?: string };
}

/** The served catalog carries both `requiredEnv` and `required_env`. */
function requiredEnvOf(template: TemplateMeta): string[] {
  return template.requiredEnv ?? template.required_env ?? [];
}

export async function templateDeployAccepted(template: TemplateMeta, name: string | undefined, accepted: PublicRunAcceptance) {
  const acceptance = await lifecycleAcceptance(accepted);
  return successResponse(
    {
      template: template.id,
      name: name || null,
      accepted: true,
      id: accepted.id ?? null,
      app_name: accepted.app_name ?? null,
      ...acceptance,
    },
    `${acceptanceSummary(`Template deploy of ${template.name ?? template.id}`, accepted.id, acceptance)} Price: ${monthlyLabel(template)}.`
  );
}

function monthlyLabel(template: TemplateMeta): string {
  const monthly = template.pricing?.monthlyUsd;
  if (typeof monthly !== "number" || !Number.isFinite(monthly)) return "price unavailable";
  return monthlyMaximum(monthly);
}

function hardwareLabel(template: TemplateMeta): string {
  const hardware = template.hardware;
  if (!hardware) return "hardware profile unavailable";
  const parts = [
    typeof hardware.cpu === "number" ? `${hardware.cpu} CPU` : null,
    typeof hardware.memory_gb === "number" ? `${hardware.memory_gb} GiB RAM` : null,
    typeof hardware.ephemeral_gb === "number" ? `${hardware.ephemeral_gb} GiB ephemeral storage` : null,
    typeof template.volume?.sizeGb === "number" ? `${template.volume.sizeGb} GiB persistent volume` : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : "hardware profile unavailable";
}

function summarizeTemplate(template: TemplateMeta): string {
  const requiredEnv = requiredEnvOf(template);
  const required = requiredEnv.length ? requiredEnv.join(", ") : "none";
  const access = template.private ? "private" : "public";
  return `${template.id} (${template.name ?? template.id}), ${access}, ${hardwareLabel(template)}, ${monthlyLabel(template)}. ${template.description ?? ""} Required env: ${required}.`;
}

async function listTemplates() {
  try {
    const templates = await getTemplates<TemplateMeta>();
    const summary = templates.map(summarizeTemplate).join("\n");
    return successResponse(
      { templates, count: templates.length },
      `${templates.length} certified Varity templates available:\n\n${summary}\n\nDeploy with varity_deploy_template or varity_deploy_agent.`
    );
  } catch (error) {
    return catalogError(error);
  }
}

async function templateInfo(id: string) {
  let template: TemplateMeta;
  try {
    template = await getTemplate<TemplateMeta>(id.trim());
  } catch (error) {
    return catalogError(error, id);
  }
  const requiredEnv = requiredEnvOf(template);
  return successResponse(
    { template },
    `${template.name ?? template.id}\n\n${template.description ?? ""}\n\n` +
      `Category: ${template.category ?? "unknown"}\n` +
      `Framework: ${template.framework ?? "unknown"}\n` +
      `Access: ${template.private ? "private" : "public"}\n` +
      `Hardware: ${hardwareLabel(template)}\n` +
      `Pricing: ${monthlyLabel(template)}\n` +
      `Required env vars: ${requiredEnv.length ? requiredEnv.join(", ") : "(none)"}\n` +
      `Certification: ${template.certification?.state ?? "unknown"}`
  );
}

export async function deployTemplate(templateId: string, name?: string) {
  let template: TemplateMeta;
  try {
    template = await getTemplate<TemplateMeta>(templateId.trim());
  } catch (error) {
    return catalogError(error, templateId);
  }

  const requiredEnv = requiredEnvOf(template);
  if (template.private || requiredEnv.length > 0) {
    const restriction = [
      template.private ? "private access" : null,
      requiredEnv.length > 0 ? `required environment variables (${requiredEnv.join(", ")})` : null,
    ].filter(Boolean).join(" and ");
    return errorResponse(
      "SECURE_ENV_CONFIGURATION_REQUIRED",
      `Template ${template.id} uses ${restriction}, which this MCP deployment tool does not configure.`,
      "Configure and deploy private or secret-bearing templates through the Developer Portal or another approved secret-safe interface. Never place secret values in chat or MCP arguments."
    );
  }

  try {
    return await templateDeployAccepted(template, name, await postTemplateDeploy(template.id, name));
  } catch (error) {
    if (error instanceof VarityPublicApiError) {
      return errorResponse(error.code, error.message, error.action ?? "Check the request with varity_template_info and retry.");
    }
    return errorResponse("DEPLOY_FAILED", `Template deploy failed for ${template.id}.`, "Retry the request.");
  }
}

export function registerAgentTools(server: McpServer): void {
  server.registerTool(
    "varity_list_templates",
    {
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      title: "List Certified Varity Templates",
      description:
        "List the certified Varity deploy templates from the gateway-owned catalog. Use this before deploying a template.",
      inputSchema: {},
    },
    async () => listTemplates()
  );

  server.registerTool(
    "varity_template_info",
    {
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      title: "Show Varity Template Details",
      description:
        "Show full details for a certified Varity template: required env, resources, access mode, hardware profile, and certification state.",
      inputSchema: {
        template: z.string().describe("Template ID from varity_list_templates."),
      },
    },
    async ({ template }) => templateInfo(template)
  );

  server.registerTool(
    "varity_deploy_template",
    {
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      title: "Deploy a Varity Template",
      description:
        "Deploy a public certified Varity template that declares no required environment variables. Private or secret-bearing templates are refused; call varity_template_info first.",
      inputSchema: {
        template: z.string().describe("Template ID from varity_list_templates."),
        name: z
          .string()
          .optional()
          .describe("Memorable deployment name. Defaults to <template>-derived name if omitted."),
      },
    },
    async ({ template, name }) => deployTemplate(template, name)
  );

  server.registerTool(
    "varity_list_agents",
    {
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      title: "List Available AI Agent Templates",
      description:
        "Backward-compatible alias for varity_list_templates. Returns the gateway-owned certified template catalog, not a hardcoded MCP list.",
      inputSchema: {},
    },
    async () => listTemplates()
  );

  server.registerTool(
    "varity_agent_info",
    {
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      title: "Show AI Agent Template Details",
      description:
        "Backward-compatible alias for varity_template_info. Pass a certified template ID from varity_list_templates.",
      inputSchema: {
        name: z.string().describe("Template ID from varity_list_templates."),
      },
    },
    async ({ name }) => templateInfo(name)
  );

  server.registerTool(
    "varity_deploy_agent",
    {
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      title: "Deploy an AI Agent Template",
      description:
        "Backward-compatible alias for varity_deploy_template. Deploys only public certified templates with no required environment variables; private or secret-bearing templates are refused.",
      inputSchema: {
        agent: z.string().describe("Template ID from varity_list_templates."),
        name: z
          .string()
          .optional()
          .describe("Memorable deployment name. Defaults to <template>-derived name if omitted."),
      },
    },
    async ({ agent, name }) => deployTemplate(agent, name)
  );
}
