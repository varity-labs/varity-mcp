import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function registerPrompts(server: McpServer): void {
  server.prompt(
    "deploy",
    {
      project_path: z
        .string()
        .optional()
        .describe("Path to the project"),
    },
    ({ project_path }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `Deploy the app${project_path ? ` at ${project_path}` : ""}.

Steps:
1. Call varity_doctor to verify the environment
2. Call varity_build to compile the project
3. Call varity_deploy to deploy to production
4. Call varity_open_browser to view the live app`,
          },
        },
      ],
    })
  );
}
