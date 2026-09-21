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
2. Fix any deployment prerequisites reported by varity_doctor
3. Call varity_deploy once; it delegates build and deployment to varitykit
4. Track the returned run when available, or call varity_deploy_status
5. Open the URL only after the deployment owner reports it live`,
          },
        },
      ],
    })
  );
}
