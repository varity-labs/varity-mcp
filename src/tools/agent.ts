import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { successResponse, errorResponse } from "../utils/responses.js";
import { execVaritykit } from "../utils/cli-bridge.js";

/**
 * Curated AI-agent deploy templates available via `varitykit app deploy --agent <name>`.
 *
 * Source of truth: `cli/varitykit/templates/agents/agents.json` in the varitykit
 * Python CLI. This bundled copy mirrors that file so AI tools can answer
 * "what agents are available?" without shelling out. When agents are added
 * to the CLI, update this constant and ship a new MCP release.
 */
interface AgentMeta {
  name: string;
  description: string;
  primary_image: string;
  required_env: string[];
  optional_env: string[];
  exposed_ports: number[];
  resources: {
    cpu: number;
    memory: string;
    storage: string;
  };
  estimated_cost_per_month_usd: number;
  access: string;
  notes: string;
}

const AGENTS: Record<string, AgentMeta> = {
  hermes: {
    name: "Hermes Agent",
    description:
      "Self-hosted Telegram chatbot powered by an LLM (default: MiniMax-M2.5 via a hosted endpoint). " +
      "Connect a Telegram bot token and an LLM endpoint and chat with users through Telegram.",
    primary_image: "ghcr.io/sandeep-narahari/hermes-agent-akash:sha-0e91691",
    required_env: ["OPENAI_API_KEY", "TELEGRAM_BOT_TOKEN", "TELEGRAM_ALLOWED_USERS"],
    optional_env: ["OPENAI_BASE_URL", "LLM_MODEL", "GATEWAY_ALLOW_ALL_USERS", "HERMES_HOME"],
    exposed_ports: [8080],
    resources: { cpu: 1, memory: "2Gi", storage: "6Gi" },
    estimated_cost_per_month_usd: 16,
    access: "Web (port 8080) + Telegram",
    notes:
      "Get a Telegram bot token from @BotFather. TELEGRAM_ALLOWED_USERS is a comma-separated " +
      "list of Telegram user IDs allowed to chat with the bot.",
  },
  openclaw: {
    name: "OpenClaw",
    description:
      "Self-hosted Claude-compatible chat UI with persistent conversation storage. " +
      "Web app exposed on a single port; you set a setup password on first run.",
    primary_image: "ghcr.io/zjuuu/openclaw-docker:openclaw-v2026.4.21",
    required_env: ["SETUP_PASSWORD"],
    optional_env: ["OPENCLAW_CONFIG_PATH"],
    exposed_ports: [8080],
    resources: { cpu: 3, memory: "6Gi", storage: "15Gi" },
    estimated_cost_per_month_usd: 38,
    access: "Web (port 8080)",
    notes:
      "SETUP_PASSWORD protects the initial admin UI, choose something strong. " +
      "Persistent data volume is 10Gi at /data.",
  },
  "agent-zero": {
    name: "Agent Zero",
    description:
      "General-purpose AI agent framework runnable with zero configuration. " +
      "Web UI on port 80. Useful for evaluating agent frameworks without committing to a stack.",
    primary_image: "agent0ai/agent-zero:v0.9.8",
    required_env: [],
    optional_env: [],
    exposed_ports: [80],
    resources: { cpu: 1, memory: "2Gi", storage: "10Gi" },
    estimated_cost_per_month_usd: 14,
    access: "Web (port 80, served at varity.app/<name>/)",
    notes:
      "Zero required configuration, deploys with sensible defaults. " +
      "Configure the agent from the web UI after deploy.",
  },
  autoresearch: {
    name: "AutoResearch (GPU)",
    description:
      "GPU-backed research environment based on nvidia/cuda, SSH-accessible Linux box " +
      "for running CUDA workloads. Heavy resource footprint (8 CPU, 32Gi RAM, GPU). " +
      "Access is via SSH only, not HTTP.",
    primary_image: "nvidia/cuda:12.6.2-devel-ubuntu22.04",
    required_env: ["SSH_PUBKEY"],
    optional_env: ["NVIDIA_VISIBLE_DEVICES"],
    exposed_ports: [22],
    resources: { cpu: 8, memory: "32Gi", storage: "166Gi" },
    estimated_cost_per_month_usd: 280,
    access: "SSH (port 22). Paste your public key into SSH_PUBKEY when prompted.",
    notes:
      "Not a web app, this is a CUDA workstation accessible via " +
      "`ssh root@<provider-url>:<port>`. Only the SSH_PUBKEY env var is mandatory; " +
      "paste the contents of your `~/.ssh/id_ed25519.pub` (or similar) when prompted. " +
      "Large GPU workload pricing.",
  },
  "eliza-venice": {
    name: "ElizaOS, Venice",
    description:
      "ElizaOS AI agent framework configured with Venice (uncensored) LLM models, " +
      "designed for Twitter/X automation. Posts on a schedule, replies to mentions, " +
      "runs LLM-driven character interactions. Requires a Twitter account and a Venice API key.",
    primary_image: "kylecohen01/venice_eliza:1.1",
    required_env: [
      "TWITTER_USERNAME",
      "TWITTER_PASSWORD",
      "TWITTER_EMAIL",
      "VENICE_API_KEY",
      "CHAR_NAME",
      "CHAR_BIO",
    ],
    optional_env: ["TWITTER_DRY_RUN", "POST_INTERVAL_MIN", "POST_INTERVAL_MAX", "LLM_MODEL"],
    exposed_ports: [3000, 5173, 5174],
    resources: { cpu: 16, memory: "32Gi", storage: "64Gi" },
    estimated_cost_per_month_usd: 168,
    access: "Web (port 3000 main UI, 5173/5174 dev surfaces) + Twitter automation",
    notes:
      "Bring your own Twitter account credentials and Venice API key (https://venice.ai). " +
      "CHAR_* fields define the bot's personality. TWITTER_DRY_RUN=false means it WILL post, " +
      "set TWITTER_DRY_RUN=true on first run to test character behavior without publishing.",
  },
};

const AGENT_NAMES = Object.keys(AGENTS) as Array<keyof typeof AGENTS>;

export function registerAgentTools(server: McpServer): void {
  // ── varity_list_agents ────────────────────────────────────────────────
  server.registerTool(
    "varity_list_agents",
    {
      title: "List Available AI Agent Templates",
      description:
        "List the curated AI agent templates Varity can deploy with one command. " +
        "Available agents: hermes (Telegram bot, ~$16/mo), openclaw (Claude-compatible chat, ~$38/mo), " +
        "agent-zero (general-purpose, zero config, ~$14/mo), autoresearch (GPU CUDA workstation, ~$280/mo), " +
        "eliza-venice (Twitter automation, ~$168/mo). " +
        "Use this when a developer asks 'what AI agents can I deploy?' or wants to compare options. " +
        "Returns name, description, estimated monthly cost, required environment variables, exposed ports, and resource footprint. " +
        "After picking one, deploy with varity_deploy_agent.",
      inputSchema: {},
    },
    async () => {
      const agents = AGENT_NAMES.map((slug) => {
        const a = AGENTS[slug]!;
        return {
          slug,
          name: a.name,
          description: a.description,
          estimated_cost_per_month_usd: a.estimated_cost_per_month_usd,
          access: a.access,
          required_env: a.required_env,
          exposed_ports: a.exposed_ports,
          resources: a.resources,
        };
      });

      const summary = agents
        .map(
          (a) =>
            `• ${a.slug} (${a.name}), ~$${a.estimated_cost_per_month_usd}/mo. ${a.description}`
        )
        .join("\n");

      return successResponse(
        { agents, count: agents.length },
        `${agents.length} AI agent templates available:\n\n${summary}\n\n` +
          `Deploy any of these with varity_deploy_agent (or run varitykit app deploy --agent <name> from a terminal).`
      );
    }
  );

  // ── varity_agent_info ─────────────────────────────────────────────────
  server.registerTool(
    "varity_agent_info",
    {
      title: "Show AI Agent Template Details",
      description:
        "Show full details for a single AI agent template: image, ports, resources, required and optional environment variables, estimated monthly cost, access mode (web/SSH/Telegram), and operator notes. " +
        "Use this when the developer has picked an agent (or is comparing 2-3) and wants to know exactly what they'll need to provide before deploying. " +
        "Pass the agent slug from varity_list_agents (one of: hermes, openclaw, agent-zero, autoresearch, eliza-venice).",
      inputSchema: {
        name: z
          .enum(AGENT_NAMES as [string, ...string[]])
          .describe("The agent slug. One of: hermes, openclaw, agent-zero, autoresearch, eliza-venice."),
      },
    },
    async ({ name }) => {
      const agent = AGENTS[name];
      if (!agent) {
        return errorResponse(
          "AGENT_NOT_FOUND",
          `Unknown agent "${name}".`,
          `Run varity_list_agents to see available agents. Valid names: ${AGENT_NAMES.join(", ")}.`
        );
      }
      return successResponse(
        { slug: name, ...agent },
        `${agent.name}\n\n${agent.description}\n\n` +
          `Image: ${agent.primary_image}\n` +
          `Access: ${agent.access}\n` +
          `Exposed ports: ${agent.exposed_ports.join(", ")}\n` +
          `Resources: cpu=${agent.resources.cpu}, memory=${agent.resources.memory}, storage=${agent.resources.storage}\n` +
          `Estimated cost: ~$${agent.estimated_cost_per_month_usd}/month\n\n` +
          `Required env vars: ${agent.required_env.length ? agent.required_env.join(", ") : "(none)"}\n` +
          `Optional env vars: ${agent.optional_env.length ? agent.optional_env.join(", ") : "(none)"}\n\n` +
          `Notes: ${agent.notes}\n\n` +
          `Deploy with varity_deploy_agent.`
      );
    }
  );

  // ── varity_deploy_agent ───────────────────────────────────────────────
  server.registerTool(
    "varity_deploy_agent",
    {
      title: "Deploy an AI Agent Template",
      description:
        "Deploy a curated AI agent from one of the 5 templates (hermes, openclaw, agent-zero, autoresearch, eliza-venice), " +
        "accessible at https://varity.app/<your-name>/. " +
        "Use this when the developer says 'deploy hermes', 'I want a Telegram bot', 'spin up agent-zero', or similar. " +
        "Required environment variables (which the developer provides via the `env` parameter) vary per agent, call varity_agent_info first to see what's needed. " +
        "Pass `name` to give the deployment a memorable URL slug. Use varity_delete_deployment to stop the deployment and its billing later.",
      inputSchema: {
        agent: z
          .enum(AGENT_NAMES as [string, ...string[]])
          .describe(
            "The agent slug. One of: hermes, openclaw, agent-zero, autoresearch, eliza-venice. " +
              "Run varity_list_agents to see all options."
          ),
        name: z
          .string()
          .optional()
          .describe(
            "Memorable name for this deployment. Becomes the URL slug at varity.app/<name>/. " +
              "Defaults to <agent>-<random> if omitted."
          ),
        env: z
          .record(z.string(), z.string())
          .optional()
          .describe(
            "Environment variables to pass to the agent container, as a key-value object. " +
              "Pass everything from the agent's required_env list (call varity_agent_info to see which). " +
              "Example for hermes: { OPENAI_API_KEY: 'sk-...', TELEGRAM_BOT_TOKEN: '...', TELEGRAM_ALLOWED_USERS: '123,456' }"
          ),
      },
    },
    async ({ agent, name, env }) => {
      const agentMeta = AGENTS[agent];
      if (!agentMeta) {
        return errorResponse(
          "AGENT_NOT_FOUND",
          `Unknown agent "${agent}".`,
          `Run varity_list_agents to see available agents.`
        );
      }

      // Validate required env vars are present
      const providedKeys = new Set(env ? Object.keys(env) : []);
      const missing = agentMeta.required_env.filter((k) => !providedKeys.has(k));
      if (missing.length > 0) {
        return errorResponse(
          "MISSING_REQUIRED_ENV",
          `Missing required environment variables: ${missing.join(", ")}.`,
          `Call varity_agent_info with name="${agent}" to see what each variable is for, ` +
            `then call this tool again with the env parameter populated.`
        );
      }

      const args: string[] = ["deploy", "--agent", agent];
      if (name) args.push("--name", name);
      if (env) {
        for (const [k, v] of Object.entries(env)) {
          args.push("--env", `${k}=${v}`);
        }
      }

      const result = await execVaritykit("app", args, { timeout: 300_000 }); // 5min for agent deploys

      if (result.exitCode === 0) {
        return successResponse(
          {
            agent,
            name: name || null,
            deployed: true,
            cli_output: result.stdout,
          },
          `Deployed ${agentMeta.name}. The agent is starting up, it may take 1-3 minutes to become fully ready.\n\nCLI output:\n${result.stdout}`
        );
      }

      const errorOutput = (result.stderr || result.stdout || "").trim();
      return errorResponse(
        "DEPLOY_FAILED",
        `Agent deploy failed for ${agent}: ${errorOutput || "unknown error"}`,
        `Check that you are logged in (varity_login), that all required environment variables are correct, ` +
          `and that the developer portal account has sufficient credit. See varity_doctor for setup issues.`
      );
    }
  );
}
