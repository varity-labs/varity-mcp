import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { successResponse, errorResponse } from "../utils/responses.js";
import { execVaritykit, isOutdatedVaritykit, VARITYKIT_UPGRADE_HINT } from "../utils/cli-bridge.js";

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

async function deployTemplate(templateId: string, name?: string, env?: Record<string, string>) {
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

  const providedKeys = new Set(env ? Object.keys(env) : []);
  const missing = (template.requiredEnv ?? []).filter((key) => !providedKeys.has(key));
  if (missing.length > 0) {
    return errorResponse(
      "MISSING_REQUIRED_ENV",
      `Missing required environment variables: ${missing.join(", ")}.`,
      `Call varity_template_info with template="${template.id}" to see the template contract.`
    );
  }

  const args: string[] = ["deploy", "--template", template.id];
  if (name) args.push("--name", name);
  if (env) {
    for (const [key, value] of Object.entries(env)) {
      args.push("--env", `${key}=${value}`);
    }
  }

  const result = await execVaritykit("app", args, { timeout: 300_000 });
  if (result.exitCode === 0) {
    return successResponse(
      {
        template: template.id,
        name: name || null,
        deployed: true,
        cli_output: result.stdout,
      },
      `Deployed ${template.name ?? template.id}. It may take a few minutes to become fully ready.\n\nCLI output:\n${result.stdout}`
    );
  }

  const errorOutput = (result.stderr || result.stdout || "").trim();
  return errorResponse(
    "DEPLOY_FAILED",
    `Template deploy failed for ${template.id}: ${errorOutput || "unknown error"}`,
    "Check that you are logged in, that required environment variables are correct, and that the account has sufficient credit."
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
        "Deploy a certified Varity template through varitykit. Call varity_template_info first for required environment variables.",
      inputSchema: {
        template: z.string().describe("Template ID from varity_list_templates."),
        name: z
          .string()
          .optional()
          .describe("Memorable deployment name. Defaults to <template>-derived name if omitted."),
        env: z
          .record(z.string(), z.string())
          .optional()
          .describe("Environment variables to pass to the template container as key-value strings."),
      },
    },
    async ({ template, name, env }) => deployTemplate(template, name, env)
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
        "Backward-compatible alias for varity_deploy_template. Deploys a certified Varity template by ID.",
      inputSchema: {
        agent: z.string().describe("Template ID from varity_list_templates."),
        name: z
          .string()
          .optional()
          .describe("Memorable deployment name. Defaults to <template>-derived name if omitted."),
        env: z
          .record(z.string(), z.string())
          .optional()
          .describe("Environment variables to pass to the template container as key-value strings."),
      },
    },
    async ({ agent, name, env }) => deployTemplate(agent, name, env)
  );
}
