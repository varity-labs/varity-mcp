import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function registerPrompts(server: McpServer): void {
  server.prompt(
    "build-app",
    {
      description: z
        .string()
        .describe(
          "What the app should do (e.g., 'invoice tracker for consulting clients')"
        ),
    },
    ({ description }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `Build a Varity app: ${description}

Follow this exact sequence:
1. Read the varity://sdk/patterns resource to understand the project structure
2. Read varity://sdk/database and varity://sdk/auth for the API reference
3. Call varity_doctor to verify the environment is ready
4. Call varity_init to scaffold the project (dependencies install automatically)
5. Define your data model — call varity_add_collection for each entity your app needs
6. Read varity://sdk/ui-components for available components and their props
7. Write the dashboard pages following the CRUD page pattern from the patterns resource
8. Call varity_build to verify everything compiles
9. Call varity_deploy to deploy to production
10. Call varity_open_browser to show the live app

Key facts:
- Database is zero-config — just define collections and use them
- Auth is zero-config — PrivyStack handles everything
- All credentials are auto-injected on deploy
- Use only components from @varity-labs/ui-kit
- The entire backend auto-configures — no manual setup needed`,
          },
        },
      ],
    })
  );

  server.prompt(
    "add-feature",
    {
      feature: z.string().describe("What feature to add"),
      project_path: z
        .string()
        .optional()
        .describe("Path to the existing project"),
    },
    ({ feature, project_path }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `Add this feature to the Varity app${project_path ? ` at ${project_path}` : ""}: ${feature}

Steps:
1. Read the existing project files: src/types/index.ts, src/lib/database.ts, src/lib/hooks.ts
2. Read varity://sdk/database for the Collection API reference
3. Read varity://sdk/ui-components for available components
4. If this feature needs new data, call varity_add_collection to create the collection, types, hook, and page
5. Write or modify dashboard pages using the patterns from varity://sdk/patterns
6. Call varity_build to verify everything compiles
7. Call varity_deploy to ship the update`,
          },
        },
      ],
    })
  );

  server.prompt(
    "deploy-and-monetize",
    {
      project_path: z
        .string()
        .optional()
        .describe("Path to the project"),
      price: z
        .string()
        .optional()
        .describe("Monthly price in USD (e.g., '49')"),
    },
    ({ project_path, price }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `Deploy and monetize the Varity app${project_path ? ` at ${project_path}` : ""}.

Steps:
1. Call varity_doctor to verify the environment
2. Call varity_build to compile the project
3. Call varity_deploy to deploy to production
4. Call varity_submit_to_store with ${price ? `price $${price}/month` : "your chosen price"}
5. Call varity_open_browser to view the live app
6. Share the App Store listing with your client

Revenue split: 90% to you, 10% to Varity.`,
          },
        },
      ],
    })
  );
}
