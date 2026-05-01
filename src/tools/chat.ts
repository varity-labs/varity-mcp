import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { successResponse, errorResponse } from "../utils/responses.js";

const AKASH_ML_BASE_URL =
  process.env["AKASH_ML_BASE_URL"] ?? "https://chatapi.akash.network/api/v1";
const AKASH_ML_DEFAULT_MODEL =
  process.env["AKASH_ML_MODEL"] ?? "Meta-Llama-3.3-70B-Instruct";

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface ChatCompletionResponse {
  id: string;
  object: string;
  model: string;
  choices: Array<{
    index: number;
    message: ChatMessage;
    finish_reason: string;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

async function callAkashML(
  messages: ChatMessage[],
  model: string,
  maxTokens: number,
  apiKey: string
): Promise<ChatCompletionResponse> {
  const response = await fetch(`${AKASH_ML_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model, messages, max_tokens: maxTokens }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "(no body)");
    throw new Error(`AI inference error ${response.status}: ${body}`);
  }

  return response.json() as Promise<ChatCompletionResponse>;
}

export function registerChatTool(server: McpServer): void {
  server.registerTool(
    "varity_chat",
    {
      title: "Varity AI Chat",
      description:
        "Send a message to Varity's built-in AI (Llama 3.3 70B) and get a response. " +
        "No API key required — Varity provides AI inference at no per-token charge for apps deployed on Varity. " +
        "Use this to test AI capabilities for your deployed app, prototype prompts, or run inference " +
        "during development without configuring a separate AI provider. " +
        "Equivalent to Netlify AI Gateway but included with every Varity deployment.",
      inputSchema: {
        query: z
          .string()
          .min(1, "query cannot be empty")
          .describe("The user message / prompt to send to the AI"),
        system: z
          .string()
          .optional()
          .describe(
            "Optional system prompt to set the AI's behavior or persona"
          ),
        model: z
          .string()
          .optional()
          .default(AKASH_ML_DEFAULT_MODEL)
          .describe(
            `Model to use (default: ${AKASH_ML_DEFAULT_MODEL}). Other available models depend on Varity's current AI provider.`
          ),
        max_tokens: z
          .coerce.number()
          .int()
          .min(1)
          .max(4096)
          .optional()
          .default(1024)
          .describe("Maximum tokens in the response (default: 1024, max: 4096)"),
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    async ({ query, system, model, max_tokens }) => {
      const apiKey = process.env["AKASH_ML_API_KEY"];
      if (!apiKey) {
        return errorResponse(
          "AI_NOT_CONFIGURED",
          "Varity AI inference is not configured on this server.",
          "This feature requires the AKASH_ML_API_KEY environment variable to be set on the MCP server. " +
            "If you are using the hosted Varity MCP, please contact support. " +
            "If you are self-hosting, set AKASH_ML_API_KEY in your environment."
        );
      }

      const messages: ChatMessage[] = [];
      if (system) {
        messages.push({ role: "system", content: system });
      }
      messages.push({ role: "user", content: query });

      let completion: ChatCompletionResponse;
      try {
        completion = await callAkashML(messages, model, max_tokens, apiKey);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return errorResponse(
          "AI_INFERENCE_FAILED",
          `AI inference request failed: ${msg}`,
          "Check that the Varity AI service is reachable. If this persists, contact support."
        );
      }

      const choice = completion.choices[0];
      if (!choice) {
        return errorResponse(
          "AI_EMPTY_RESPONSE",
          "AI returned no choices in the response.",
          "Retry the request. If the issue persists, try a shorter prompt or reduce max_tokens."
        );
      }

      return successResponse(
        {
          response: choice.message.content,
          model: completion.model,
          finish_reason: choice.finish_reason,
          usage: completion.usage,
          provider: "Varity AI (included with your deployment)",
        },
        choice.message.content
      );
    }
  );
}
