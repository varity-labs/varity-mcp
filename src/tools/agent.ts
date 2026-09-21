import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { successResponse, errorResponse } from "../utils/responses.js";
import { execVaritykit, isOutdatedVaritykit, lifecycleTracking, VARITYKIT_UPGRADE_HINT } from "../utils/cli-bridge.js";

/** The installed varitykit predates the `app templates` command. */
class VaritykitOutdatedError extends Error {}

function catalogError(error: unknown) {
  if (error instanceof VaritykitOutdatedError) {
    return errorResponse(
      "VARITYKIT_OUTDATED",
      "The installed varitykit CLI is too old to read the template catalog (it has no `app templates` command).",
      VARITYKIT_UPGRADE_HINT
    );
  }
  return errorResponse(
    "TEMPLATE_CATALOG_UNAVAILABLE",
    `Could not load Varity templates: ${error instanceof Error ? error.message : "unknown error"}`,
    "Run varity_login or set VARITY_DEPLOY_KEY, then retry."
  );
}

interface TemplateMeta {
  id: string;
  name?: string;
  description?: string;
  category?: string;
  framework?: string;
  language?: string;
  tags?: string[];
  requiredEnv?: string[];
  private?: boolean;
  pricing?: { monthlyUsd?: number | null };
  hardware?: { cpu?: number; memory_gb?: number; ephemeral_gb?: number };
  resources?: Array<{ kind?: string; engine?: string; label?: string }>;
  certification?: { state?: string; reason?: string };
}

async function fetchTemplateCatalog(): Promise<TemplateMeta[]> {
  const result = await execVaritykit("app", ["templates", "--json"], { timeout: 120_000 });
  if (result.exitCode !== 0) {
    if (isOutdatedVaritykit(result)) throw new VaritykitOutdatedError();
    const detail = (result.stderr || result.stdout || "").trim() || "unknown error";
    throw new Error(detail);
  }
  const parsed = JSON.parse(result.stdout) as { templates?: TemplateMeta[] };
  return Array.isArray(parsed.templates) ? parsed.templates : [];
}

function findTemplate(templates: TemplateMeta[], id: string): TemplateMeta | undefined {
  const normalized = id.trim();
  return templates.find((t) => t.id === normalized);
}

function monthlyLabel(template: TemplateMeta): string {
  const monthly = template.pricing?.monthlyUsd;
  if (typeof monthly !== "number" || !Number.isFinite(monthly)) return "pricing unavailable from gateway catalog";
  return `~$${monthly.toLocaleString("en-US")}/mo estimate`;
}

function hardwareLabel(template: TemplateMeta): string {
  const hardware = template.hardware;
  if (!hardware) return "hardware profile unavailable";
  const parts = [
    typeof hardware.cpu === "number" ? `${hardware.cpu} CPU` : null,
    typeof hardware.memory_gb === "number" ? `${hardware.memory_gb} GiB RAM` : null,
    typeof hardware.ephemeral_gb === "number" ? `${hardware.ephemeral_gb} GiB ephemeral storage` : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : "hardware profile unavailable";
}

function summarizeTemplate(template: TemplateMeta): string {
  const required = template.requiredEnv?.length ? template.requiredEnv.join(", ") : "none";
  const access = template.private ? "private" : "public";
  return `${template.id} (${template.name ?? template.id}), ${access}, ${hardwareLabel(template)}. ${template.description ?? ""} Required env: ${required}.`;
}

async function listTemplates() {
  try {
    const templates = await fetchTemplateCatalog();
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
  try {
    const templates = await fetchTemplateCatalog();
    const template = findTemplate(templates, id);
    if (!template) {
      return errorResponse(
        "TEMPLATE_NOT_FOUND",
        `Unknown or uncertified template "${id}".`,
        `Run varity_list_templates to see certified template IDs.`
      );
    }
    return successResponse(
      { template },
      `${template.name ?? template.id}\n\n${template.description ?? ""}\n\n` +
        `Category: ${template.category ?? "unknown"}\n` +
        `Framework: ${template.framework ?? "unknown"}\n` +
        `Access: ${template.private ? "private" : "public"}\n` +
        `Hardware: ${hardwareLabel(template)}\n` +
        `Pricing: ${monthlyLabel(template)}\n` +
        `Required env vars: ${template.requiredEnv?.length ? template.requiredEnv.join(", ") : "(none)"}\n` +
        `Certification: ${template.certification?.state ?? "unknown"}`
    );
  } catch (error) {
    return catalogError(error);
  }
}

async function deployTemplate(templateId: string, name?: string) {
  let template: TemplateMeta | undefined;
  try {
    const templates = await fetchTemplateCatalog();
    template = findTemplate(templates, templateId);
    if (!template) {
      return errorResponse(
        "TEMPLATE_NOT_FOUND",
        `Unknown or uncertified template "${templateId}".`,
        `Run varity_list_templates to see certified template IDs.`
      );
    }
  } catch (error) {
    return catalogError(error);
  }

  const requiredEnv = template.requiredEnv ?? [];
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

  const args: string[] = ["deploy", "--template", template.id];
  if (name) args.push("--name", name);

  const result = await execVaritykit("app", args, { timeout: 300_000 });
  if (result.exitCode === 0) {
    const tracking = lifecycleTracking(result.stdout);
    return successResponse(
      {
        template: template.id,
        name: name || null,
        accepted: true,
        status: tracking.runId ? "deploying" : "outcome_unconfirmed",
        run_id: tracking.runId,
        status_command: tracking.statusCommand,
      },
      tracking.statusCommand
        ? `Template deploy accepted for ${template.name ?? template.id}. Track its terminal outcome with: ${tracking.statusCommand}`
        : `The template deploy command returned success for ${template.name ?? template.id} without a durable tracking reference. The terminal outcome is not proven; inspect varity_deploy_status before reporting completion.`
    );
  }

  const errorOutput = (result.stderr || result.stdout || "").trim();
  return errorResponse(
    "DEPLOY_FAILED",
    `Template deploy failed for ${template.id}: ${errorOutput || "unknown error"}`,
    "Check that you are logged in and inspect the CLI error before retrying."
  );
}

export function registerAgentTools(server: McpServer): void {
  server.registerTool(
    "varity_list_templates",
    {
      annotations: { readOnlyHint: true },
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
      annotations: { readOnlyHint: true },
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
      annotations: { destructiveHint: true },
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
      annotations: { readOnlyHint: true },
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
      annotations: { readOnlyHint: true },
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
      annotations: { destructiveHint: true },
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
