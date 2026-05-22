import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { successResponse, errorResponse } from "../utils/responses.js";
import { INFRASTRUCTURE } from "../utils/config.js";

// Live docs cache, fetched once on first search, supplements hardcoded index
let liveDocsContent: string | null = null;
let fetchAttempted = false;

async function getLiveDocsContent(): Promise<string | null> {
  if (fetchAttempted) return liveDocsContent;
  fetchAttempted = true;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch("https://docs.varity.so/llms.txt", { signal: controller.signal });
    clearTimeout(timeout);
    if (res.ok) {
      liveDocsContent = await res.text();
    }
  } catch {
    // Offline or timeout, hardcoded index is the fallback
  }
  return liveDocsContent;
}

/**
 * Complete documentation index for offline/fallback usage.
 * URLs verified against docs.varity.so (Astro Starlight, March 2026).
 *
 * Coverage: 56 of 56 pages indexed (100%)
 */

interface DocsEntry {
  title: string;
  section: string;
  url: string;
  content: string;
  keywords: string[];
}

const DOCS_INDEX: DocsEntry[] = [
  // ─── Home ──────────────────────────────────────────────────────────
  {
    title: "Varity Documentation",
    section: "Home",
    url: `${INFRASTRUCTURE.DOCS}`,
    content: `Official Varity documentation. Build and deploy apps with one command. Auth, database, storage, and payments included out of the box.`,
    keywords: ["home", "docs", "documentation", "start", "index"],
  },
  {
    title: "Component Showcase",
    section: "Home",
    url: `${INFRASTRUCTURE.DOCS}/component-showcase`,
    content: `Live examples of all Varity documentation components including CodeBlock, Callout, Tabs, StepHike, Card, and Accordion elements.`,
    keywords: ["component", "showcase", "examples", "demo"],
  },

  // ─── Getting Started ───────────────────────────────────────────────
  {
    title: "Introduction",
    section: "Getting Started",
    url: `${INFRASTRUCTURE.DOCS}/getting-started/introduction`,
    content: `Varity is a developer platform to build and deploy any Node or Python app, AI agent, or LLM. 60-80% cheaper than Vercel, Render, or Railway, with auth, storage, and hosting included.

Build real-world apps without managing infrastructure. Deploy with one command. Your bill stays flat no matter how much traffic you get.`,
    keywords: ["introduction", "what is varity", "overview", "about", "why"],
  },
  {
    title: "Installation",
    section: "Getting Started",
    url: `${INFRASTRUCTURE.DOCS}/getting-started/installation`,
    content: `Install the Varity SDK, UI Kit, and CLI:

npm install @varity-labs/sdk @varity-labs/ui-kit @varity-labs/types
pip install varitykit

Requirements: Node.js 18+, Python 3.8+, npm/pnpm/yarn

Verify installation:
varitykit doctor`,
    keywords: ["install", "installation", "setup", "requirements", "npm", "pip"],
  },
  {
    title: "Quick Start",
    section: "Getting Started",
    url: `${INFRASTRUCTURE.DOCS}/getting-started/quickstart`,
    content: `Get your first Varity app running in 5 minutes:

1. Create app: npx create-varity-app my-app
2. Start dev: cd my-app && npm run dev
3. Deploy: varitykit app deploy

Your app is live with auth, database, and payments included, zero configuration.`,
    keywords: ["quickstart", "quick start", "start", "begin", "getting started", "first app"],
  },
  {
    title: "Next.js Quick Start",
    section: "Getting Started",
    url: `${INFRASTRUCTURE.DOCS}/getting-started/quickstart-nextjs`,
    content: `Build a full-stack Next.js app with Varity in 5 minutes.

Uses the SaaS Starter template with:
- Next.js 14 + App Router
- Authentication (email, Google, GitHub)
- Dashboard with sidebar
- Database integration
- Settings pages

Create: npx create-varity-app my-app
Deploy: varitykit app deploy`,
    keywords: ["nextjs", "next.js", "next", "app router", "framework", "react"],
  },
  {
    title: "React Quick Start",
    section: "Getting Started",
    url: `${INFRASTRUCTURE.DOCS}/getting-started/quickstart-react`,
    content: `Set up a React + Vite app with Varity authentication and database.

Step-by-step guide for:
- Adding auth to React apps
- Connecting to the database
- Deploying your app

Works with Create React App, Vite, or any React setup.`,
    keywords: ["react", "vite", "cra", "create-react-app", "spa"],
  },
  {
    title: "Node.js Quick Start",
    section: "Getting Started",
    url: `${INFRASTRUCTURE.DOCS}/getting-started/quickstart-nodejs`,
    content: `Build a REST API with Express and the Varity SDK zero-config database.

import { db } from '@varity-labs/sdk';
const users = db.collection('users');
await users.add({ name: 'Alice' });

No connection strings, no ORM setup. Deploy in 5 minutes.`,
    keywords: ["nodejs", "node.js", "node", "backend", "api", "express", "rest"],
  },
  {
    title: "Why Varity",
    section: "Getting Started",
    url: `${INFRASTRUCTURE.DOCS}/getting-started/why-varity`,
    content: `Why Varity over Vercel, Render, or Railway?

- 60-80% cheaper at launch, and the gap widens as you grow
- One flat monthly cost per app, based on the hardware you reserve
- Your bill does not change with traffic, bandwidth, or invocations
- Zero DevOps overhead
- Built-in auth and database
- One-command deploys

Example monthly cost, web app + database:
- Vercel: $40/mo (climbs to ~$180 at traction)
- Railway: $35/mo (climbs to ~$128 at traction)
- Render: $14/mo (climbs to ~$292 at traction)
- Varity: $6/mo (flat, never changes)`,
    keywords: ["why", "comparison", "vs", "versus", "vercel", "render", "railway", "pricing", "cost"],
  },
  {
    title: "Getting Help",
    section: "Getting Started",
    url: `${INFRASTRUCTURE.DOCS}/getting-started/getting-help`,
    content: `Find help with Varity:

- Documentation: docs.varity.so
- Discord: discord.gg/7vWsdwa2Bg
- GitHub Issues: github.com/varity-labs/varity-sdk/issues

For bugs, feature requests, or questions, join the Discord community.`,
    keywords: ["help", "support", "discord", "community", "issues", "bugs"],
  },

  // ─── Templates ─────────────────────────────────────────────────────
  {
    title: "Templates Overview",
    section: "Templates",
    url: `${INFRASTRUCTURE.DOCS}/templates/overview`,
    content: `Browse production-ready Varity app templates.

Scaffold a complete SaaS app with auth, database, and dashboard:
npx create-varity-app my-app

Templates include:
- SaaS Starter (default)
- More coming soon

All templates are production-ready with zero configuration.`,
    keywords: ["templates", "starter", "boilerplate", "scaffold", "saas"],
  },
  {
    title: "SaaS Starter Template",
    section: "Templates",
    url: `${INFRASTRUCTURE.DOCS}/templates/saas-starter`,
    content: `Production-ready SaaS template with:

- Next.js 14 + App Router
- Authentication (email, Google, GitHub)
- Team management
- CRUD pages
- Full dashboard
- Settings (profile, security, billing)
- Landing page
- Command palette (Cmd+K)

One-command scaffold: npx create-varity-app my-app`,
    keywords: ["saas", "saas-starter", "template", "dashboard", "landing"],
  },

  // ─── Packages: SDK ─────────────────────────────────────────────────
  {
    title: "@varity-labs/sdk Overview",
    section: "SDK",
    url: `${INFRASTRUCTURE.DOCS}/packages/sdk/overview`,
    content: `@varity-labs/sdk provides:

- Zero-config database
- Credential management
- App token management

The core building block for all Varity apps.

import { db } from '@varity-labs/sdk';
const items = db.collection('items');`,
    keywords: ["sdk", "package", "core", "database", "api"],
  },
  {
    title: "@varity-labs/sdk Installation",
    section: "SDK",
    url: `${INFRASTRUCTURE.DOCS}/packages/sdk/installation`,
    content: `Install the SDK:

npm install @varity-labs/sdk @varity-labs/types

Requirements: Node.js 18+

Includes peer dependencies and environment setup for TypeScript projects.`,
    keywords: ["sdk", "install", "installation", "npm", "setup"],
  },
  {
    title: "SDK API Reference",
    section: "SDK",
    url: `${INFRASTRUCTURE.DOCS}/packages/sdk/api-reference`,
    content: `Complete TypeScript API reference for @varity-labs/sdk:

- db.collection() - Database access
- getCredentials() - Credential management
- resolveCredentials() - Resolve credentials
- logCredentialUsage() - Usage tracking
- SDK_VERSION - Current SDK version

Full type definitions included with @varity-labs/types.`,
    keywords: ["api", "reference", "methods", "functions", "types"],
  },
  {
    title: "Infrastructure Configuration",
    section: "SDK",
    url: `${INFRASTRUCTURE.DOCS}/packages/sdk/configuration`,
    content: `Varity SDK infrastructure configuration:

All infrastructure is configured automatically, no manual setup required.

- Auto-configured database connection
- Auto-configured auth credentials
- Auto-configured hosting settings
- Zero environment variables needed during development`,
    keywords: ["config", "configuration", "infrastructure", "network", "environment"],
  },

  // ─── Packages: UI Kit ──────────────────────────────────────────────
  {
    title: "@varity-labs/ui-kit Overview",
    section: "UI Kit",
    url: `${INFRASTRUCTURE.DOCS}/packages/ui-kit/overview`,
    content: `Pre-built React components for auth, payments, dashboards, forms, and analytics.

52+ production-ready components:
- Button, Card, DataTable, Modal
- PrivyStack (auth provider)
- PaymentWidget, KPICard
- DashboardLayout, Sidebar
- Toast, Dialog, Dropdown

All styled with Tailwind CSS and support dark mode.`,
    keywords: ["ui", "ui-kit", "components", "react", "tailwind"],
  },
  {
    title: "@varity-labs/ui-kit Installation",
    section: "UI Kit",
    url: `${INFRASTRUCTURE.DOCS}/packages/ui-kit/installation`,
    content: `Install the UI Kit:

npm install @varity-labs/ui-kit

Requirements: React 18+

Includes peer dependencies, auth setup, and configuration guide.`,
    keywords: ["ui-kit", "install", "installation", "react", "components"],
  },
  {
    title: "Components Reference",
    section: "UI Kit",
    url: `${INFRASTRUCTURE.DOCS}/packages/ui-kit/components`,
    content: `Full API reference for all UI Kit components:

- Button, Input, Select, Toggle
- Card, DataTable, Modal, Dialog
- Toast, Badge, Avatar
- PrivyStack (auth provider)
- PaymentWidget, KPICard
- DashboardLayout, DashboardSidebar
- CommandPalette, Breadcrumb

20+ components with full TypeScript definitions.`,
    keywords: ["components", "reference", "button", "modal", "table", "card"],
  },
  {
    title: "Hooks Reference",
    section: "UI Kit",
    url: `${INFRASTRUCTURE.DOCS}/packages/ui-kit/hooks`,
    content: `API reference for UI Kit React hooks:

- usePrivy() - Auth state
- useLogin() - Login flow
- useLogout() - Logout
- useTheme() - Theme management
- useToast() - Toast notifications

Full TypeScript support with autocomplete.`,
    keywords: ["hooks", "react", "usePrivy", "useLogin", "useTheme"],
  },

  // ─── Packages: Types ───────────────────────────────────────────────
  {
    title: "@varity-labs/types Overview",
    section: "Types",
    url: `${INFRASTRUCTURE.DOCS}/packages/types/overview`,
    content: `Install @varity-labs/types for TypeScript auto-completion and compile-time validation:

npm install @varity-labs/types

Provides type definitions for all Varity SDK and UI Kit APIs.`,
    keywords: ["types", "typescript", "definitions", "autocomplete"],
  },

  // ─── Build: Auth ───────────────────────────────────────────────────
  {
    title: "Authentication Quick Start",
    section: "Authentication",
    url: `${INFRASTRUCTURE.DOCS}/build/auth/quickstart`,
    content: `Add authentication in 5 minutes:

import { PrivyStack } from '@varity-labs/ui-kit';

<PrivyStack>
  <App />
</PrivyStack>

Supports: Email magic links, Google, GitHub, Discord, Apple.
Users see a normal login screen, no special setup required.`,
    keywords: ["auth", "authentication", "login", "signup", "privy"],
  },
  {
    title: "Email Login",
    section: "Authentication",
    url: `${INFRASTRUCTURE.DOCS}/build/auth/email-login`,
    content: `Add passwordless email login using magic links.

No passwords to store, no reset flows. Setup in under 5 minutes.

Users enter email → receive link → click to login.`,
    keywords: ["email", "login", "magic link", "passwordless"],
  },
  {
    title: "Social Login",
    section: "Authentication",
    url: `${INFRASTRUCTURE.DOCS}/build/auth/social-login`,
    content: `Add one-click social login.

Providers: Google, Twitter, Discord, GitHub, Apple

Configure in the Varity UI Kit with zero backend code.`,
    keywords: ["social", "oauth", "google", "github", "twitter", "discord"],
  },

  // ─── Build: Database ───────────────────────────────────────────────
  {
    title: "Database Quick Start",
    section: "Database",
    url: `${INFRASTRUCTURE.DOCS}/build/databases/quickstart`,
    content: `Zero-config database with TypeScript-first API:

import { db } from '@varity-labs/sdk';

const items = db.collection('items');

// Add
await items.add({ title: 'Task 1' });

// Query
const all = await items.get();

// Update
await items.update(id, { done: true });

// Delete
await items.delete(id);

No connection strings, no ORM setup. Works immediately.`,
    keywords: ["database", "db", "postgres", "collection", "crud", "query"],
  },

  // ─── Build: Storage ────────────────────────────────────────────────
  {
    title: "Data Storage Quick Start",
    section: "Storage",
    url: `${INFRASTRUCTURE.DOCS}/build/storage/quickstart`,
    content: `Store and retrieve structured data with the Varity SDK.

Zero-config MongoDB-like API with TypeScript generics and auto-provisioned collections.

See upload and retrieve docs for full examples.`,
    keywords: ["storage", "data", "store", "save"],
  },
  {
    title: "Storing Data",
    section: "Storage",
    url: `${INFRASTRUCTURE.DOCS}/build/storage/upload`,
    content: `Create, update, and delete records:

await items.add({ title: 'New item' });
await items.update(id, { title: 'Updated' });
await items.delete(id);

Includes code examples for all CRUD operations.`,
    keywords: ["store", "upload", "save", "add", "create", "update", "delete"],
  },
  {
    title: "Retrieving Data",
    section: "Storage",
    url: `${INFRASTRUCTURE.DOCS}/build/storage/retrieve`,
    content: `Query and display records from your database:

const items = await db.collection('items').get();

Fetch collections, access system fields, render data in React components.`,
    keywords: ["retrieve", "fetch", "query", "get", "read", "load"],
  },

  // ─── Build: Payments ───────────────────────────────────────────────
  {
    title: "Billing & Pricing",
    section: "Pricing",
    url: `${INFRASTRUCTURE.DOCS}/pricing`,
    content: `Varity charges one flat monthly cost per app, based on the hardware you reserve. From $5/mo for a static site and $6/mo for a web app or a web app with a database. Your bill does not change with traffic, bandwidth, or invocations.

Add a payment method once, then deploy. 60-80% cheaper than Vercel, Render, or Railway.`,
    keywords: ["payments", "pricing", "cost", "billing", "price", "monthly"],
  },
  {
    title: "Developer Portal",
    section: "Deploy",
    url: `${INFRASTRUCTURE.DOCS}/deploy/developer-portal`,
    content: `The Developer Portal at developer.store.varity.so lets you deploy apps, monitor deployments, view logs, and manage billing in one place.

Sign in, connect a GitHub repo or paste a public repo URL, add a payment method, then deploy. Each deployment gets a live URL at https://varity.app/<name>/.`,
    keywords: ["developer portal", "portal", "deploy", "dashboard", "monitor", "billing"],
  },
  {
    title: "Payment Methods",
    section: "Pricing",
    url: `${INFRASTRUCTURE.DOCS}/pricing/payment-methods`,
    content: `Add a credit card once via Stripe Checkout, then deploy. Varity bills the flat monthly cost per app to your card. No usage metering and no surprise overage bills.`,
    keywords: ["credit card", "payment", "stripe", "checkout", "billing"],
  },
  {
    title: "No Usage Fees",
    section: "Pricing",
    url: `${INFRASTRUCTURE.DOCS}/pricing/no-usage-fees`,
    content: `Varity does not meter bandwidth, requests, function invocations, or build minutes. You pay one flat monthly cost for the hardware your app reserves, and that number does not change as your traffic grows.`,
    keywords: ["usage", "fees", "bandwidth", "overage", "flat", "metering"],
  },

  // ─── Build: Accounts ───────────────────────────────────────────────
  {
    title: "Accounts Quick Start",
    section: "Accounts",
    url: `${INFRASTRUCTURE.DOCS}/build/wallets/quickstart`,
    content: `Varity automatically creates user accounts on sign-in.

No extra setup, no browser extensions, no configuration needed.
Users see a normal auth flow.`,
    keywords: ["accounts", "users", "wallet", "profile"],
  },
  {
    title: "Create Account",
    section: "Accounts",
    url: `${INFRASTRUCTURE.DOCS}/build/wallets/create-wallet`,
    content: `Varity automatically creates secure accounts when users sign in.

No manual setup required. Accounts are provisioned on first login.`,
    keywords: ["create", "account", "wallet", "user"],
  },
  {
    title: "Session Keys",
    section: "Accounts",
    url: `${INFRASTRUCTURE.DOCS}/build/wallets/session-keys`,
    content: `Planned Varity feature for temporary permissions, batch operations, and delegated actions on behalf of users.

Coming in a future release.`,
    keywords: ["session", "keys", "permissions", "delegation"],
  },

  // ─── Build: Compute ────────────────────────────────────────────────
  {
    title: "Compute Overview",
    section: "Compute",
    url: `${INFRASTRUCTURE.DOCS}/build/compute/overview`,
    content: `Preview of Varity Compute: run containers, backend services, scheduled jobs, and server-side code on distributed infrastructure.

Coming soon.`,
    keywords: ["compute", "containers", "backend", "jobs", "serverless"],
  },

  // ─── CLI ───────────────────────────────────────────────────────────
  {
    title: "VarityKit CLI Overview",
    section: "CLI",
    url: `${INFRASTRUCTURE.DOCS}/cli/overview`,
    content: `VarityKit CLI: scaffold projects, run diagnostics, deploy apps, and manage domains.

Python-based tool similar to Vercel CLI.

Commands:
- varitykit doctor
- varitykit init
- varitykit app deploy
- varitykit login`,
    keywords: ["cli", "command", "terminal", "varitykit"],
  },
  {
    title: "CLI Installation",
    section: "CLI",
    url: `${INFRASTRUCTURE.DOCS}/cli/installation`,
    content: `Install the VarityKit CLI:

pip install varitykit

Verify: varitykit doctor

Includes troubleshooting for macOS, Linux, and Windows.`,
    keywords: ["cli", "install", "installation", "pip", "varitykit"],
  },
  {
    title: "varitykit doctor",
    section: "CLI",
    url: `${INFRASTRUCTURE.DOCS}/cli/commands/doctor`,
    content: `Run diagnostics on your development environment:

varitykit doctor

Checks:
- Node.js version
- Python version
- npm installed
- 20+ dependency validations

Reports issues and suggests fixes.`,
    keywords: ["doctor", "diagnostics", "check", "verify", "debug"],
  },
  {
    title: "varitykit init",
    section: "CLI",
    url: `${INFRASTRUCTURE.DOCS}/cli/commands/init`,
    content: `Scaffold a new Varity project:

varitykit init my-app

Creates a project from starter template with auth, database, and deployment config out of the box.`,
    keywords: ["init", "scaffold", "create", "new", "project"],
  },
  {
    title: "varitykit app deploy",
    section: "CLI",
    url: `${INFRASTRUCTURE.DOCS}/cli/commands/deploy`,
    content: `Deploy your app to production:

varitykit app deploy

Supports:
- Static sites (Next.js, React, Vue)
- Dynamic apps (Node.js backends)
- CDN and cloud compute hosting
- Automatic framework detection

Options:
--hosting static|dynamic
--submit-to-store
--name [app-name]
--verbose`,
    keywords: ["deploy", "deployment", "publish", "production", "live"],
  },
  {
    title: "varitykit login / auth",
    section: "CLI",
    url: `${INFRASTRUCTURE.DOCS}/cli/commands/auth`,
    content: `Log in to Varity from the CLI:

varitykit login

Uses deploy keys from the developer portal for app deployment and domain management.`,
    keywords: ["login", "auth", "authenticate", "credentials", "key"],
  },

  // ─── Deploy ────────────────────────────────────────────────────────
  {
    title: "Deploy Your Application",
    section: "Deploy",
    url: `${INFRASTRUCTURE.DOCS}/deploy/deploy-your-app`,
    content: `Deploy with one command:

varitykit app deploy

Features:
- Automatic builds
- Custom domains at varity.app
- Live in under 2 minutes
- Zero configuration

Your app gets production database, auth, and hosting automatically.`,
    keywords: ["deploy", "deployment", "publish", "production"],
  },
  {
    title: "Deploy Your App (Varity Infrastructure)",
    section: "Deploy",
    url: `${INFRASTRUCTURE.DOCS}/deploy/varity-infrastructure`,
    content: `Deploy to Varity infrastructure:

varitykit app deploy

Live in under 2 minutes with:
- Automatic builds
- Custom domains
- Zero config
- Production database
- Authentication included`,
    keywords: ["deploy", "varity", "infrastructure", "production"],
  },
  {
    title: "Environment Variables",
    section: "Deploy",
    url: `${INFRASTRUCTURE.DOCS}/deploy/env-variables`,
    content: `Configure environment variables for Varity deployments.

Most credentials are managed automatically:
- Database connection
- Auth keys
- Storage credentials

Only custom service variables need manual setup (e.g., third-party API keys).`,
    keywords: ["env", "environment", "variables", "config", "secrets", ".env"],
  },
  {
    title: "Managed Credentials",
    section: "Deploy",
    url: `${INFRASTRUCTURE.DOCS}/deploy/managed-credentials`,
    content: `Varity auto-provides auth, database, and storage credentials at every stage.

No third-party accounts, no API key setup, no .env configuration.
Everything works automatically.`,
    keywords: ["credentials", "managed", "automatic", "config"],
  },

  // ─── Tutorials ─────────────────────────────────────────────────────
  {
    title: "Build & Deploy a SaaS App",
    section: "Tutorials",
    url: `${INFRASTRUCTURE.DOCS}/tutorials/build-saas-app`,
    content: `Step-by-step tutorial:

1. Scaffold: varitykit init my-saas
2. Explore the dashboard and auth
3. Deploy: varitykit app deploy

Complete walkthrough from zero to deployed SaaS application.`,
    keywords: ["tutorial", "guide", "walkthrough", "saas", "learn"],
  },
  {
    title: "Customize the SaaS Template",
    section: "Tutorials",
    url: `${INFRASTRUCTURE.DOCS}/tutorials/customize-template`,
    content: `Customize the Varity SaaS Starter template:

- Update branding
- Modify sidebar navigation
- Rename data models
- Change color theme (Tailwind CSS)

Key files to modify:
- src/app/page.tsx (landing)
- src/app/globals.css (theme)
- tailwind.config.ts (colors)`,
    keywords: ["customize", "template", "theme", "branding", "colors"],
  },
  {
    title: "Add a CRUD Feature",
    section: "Tutorials",
    url: `${INFRASTRUCTURE.DOCS}/tutorials/add-crud-feature`,
    content: `Tutorial: add a Notes feature with full CRUD operations.

Covers:
- Data types
- Database queries (add, get, update, delete)
- React UI components
- Form handling

Learn by building a complete feature end-to-end.`,
    keywords: ["crud", "tutorial", "feature", "database", "example"],
  },

  // ─── AI Tools ──────────────────────────────────────────────────────
  {
    title: "AI Tools for Varity",
    section: "AI Tools",
    url: `${INFRASTRUCTURE.DOCS}/ai-tools/overview`,
    content: `Accelerate Varity development with AI tools:

- Copy-paste prompts
- Cursor rules
- MCP server integration
- LLM-optimized documentation

Build Varity apps faster with ChatGPT, Claude, or Cursor.`,
    keywords: ["ai", "tools", "cursor", "chatgpt", "claude", "prompts"],
  },
  {
    title: "AI Prompts for Varity",
    section: "AI Tools",
    url: `${INFRASTRUCTURE.DOCS}/ai-tools/prompts`,
    content: `Copy-paste prompts for building Varity apps:

- SDK patterns
- Database API usage
- Auth setup
- Deployment

Use with ChatGPT, Claude, or Cursor for faster development.`,
    keywords: ["prompts", "ai", "examples", "chatgpt", "claude"],
  },
  {
    title: "Varity MCP Server",
    section: "AI Tools",
    url: `${INFRASTRUCTURE.DOCS}/ai-tools/mcp-server-spec`,
    content: `Install the Varity MCP server for AI editors.

7 tools for deploying, searching docs, and managing apps via Cursor or Claude:

- varity_search_docs
- varity_cost_calculator
- varity_init
- varity_deploy
- varity_deploy_status
- varity_deploy_logs
- varity_submit_to_store

Install: npx -y @varity-labs/mcp

Supports: Cursor, Claude Code, VS Code, Windsurf, Claude.ai, ChatGPT (HTTP)`,
    keywords: ["mcp", "model context protocol", "cursor", "claude", "ai", "editor"],
  },

  // ─── Resources ─────────────────────────────────────────────────────
  {
    title: "FAQ",
    section: "Resources",
    url: `${INFRASTRUCTURE.DOCS}/resources/faq`,
    content: `Frequently asked questions:

Q: How much does Varity cost?
A: One flat monthly cost per app, from $5/mo, that does not change with traffic. 60-80% cheaper than Vercel, Render, or Railway. Auth and database included.

Q: What frameworks are supported?
A: Next.js, React, Vue, Node.js. Auto-detected on deploy.

Q: Do I need any special technical knowledge to use Varity?
A: No. Build like you would any standard web app, no special setup required.

Q: How do I publish my app?
A: Deploy with --submit-to-store. 90% revenue to you.`,
    keywords: ["faq", "questions", "help", "frequently asked"],
  },
  {
    title: "Glossary",
    section: "Resources",
    url: `${INFRASTRUCTURE.DOCS}/resources/glossary`,
    content: `Definitions of key Varity terms:

- Deploy: Ship your app to a live URL with one command (varitykit app deploy)
- Deploy keys: Authentication for the CLI and MCP
- Managed credentials: Upstream service keys auto-provisioned by Varity, never handled by you
- Flat monthly cost: One fixed price per app, based on reserved hardware, that does not change with traffic
- Developer Portal: developer.store.varity.so, where you deploy, monitor, and manage billing`,
    keywords: ["glossary", "terms", "definitions", "vocabulary"],
  },
  {
    title: "Troubleshooting",
    section: "Resources",
    url: `${INFRASTRUCTURE.DOCS}/resources/troubleshooting`,
    content: `Fix common Varity issues:

CLI not found:
→ Reinstall: pip install varitykit

Build errors:
→ Run: varitykit doctor
→ Check: npm install

Auth failures:
→ Verify: Privy setup in UI Kit

Deployment problems:
→ Add --verbose flag: varitykit app deploy --verbose

For more help: https://discord.gg/7vWsdwa2Bg`,
    keywords: ["troubleshooting", "errors", "fix", "debug", "problems", "issues"],
  },

  // ─── Guides ────────────────────────────────────────────────────────
  {
    title: "Error Handling Guide",
    section: "Guides",
    url: `${INFRASTRUCTURE.DOCS}/guides/error-handling`,
    content: `Learn how to handle errors gracefully in your Varity applications.

Best practices for:
- Database errors
- Auth failures
- Deployment issues
- Network problems

Includes code examples and patterns.`,
    keywords: ["error", "handling", "errors", "exceptions", "try", "catch"],
  },

  // ─── Quick Start (duplicate section) ───────────────────────────────
  {
    title: "Node.js Quick Start (Backend)",
    section: "Quick Start",
    url: `${INFRASTRUCTURE.DOCS}/quickstart/nodejs`,
    content: `Get started with Varity in Node.js:

Build a backend API with:
- Express + Varity SDK
- Zero-config database
- Deployment in 5 minutes

import { db } from '@varity-labs/sdk';
app.get('/users', async (req, res) => {
  const users = await db.collection('users').get();
  res.json(users);
});`,
    keywords: ["nodejs", "node", "backend", "api", "express", "quickstart"],
  },
];

/**
 * Synonym map to improve search matching.
 */
const SYNONYMS: Record<string, string[]> = {
  store: ["storage", "file", "upload", "app store", "save"],
  files: ["storage", "upload", "download", "retrieve", "data"],
  upload: ["storage", "file", "save", "add"],
  save: ["storage", "database", "add", "create", "write"],
  cost: ["price", "pricing", "savings", "cheaper", "money", "cheap"],
  cheap: ["cost", "price", "savings", "affordable"],
  money: ["cost", "price", "revenue", "earn"],
  login: ["auth", "authentication", "sign in", "signin"],
  signup: ["auth", "authentication", "register", "sign up"],
  register: ["auth", "authentication", "signup", "create account"],
  account: ["auth", "authentication", "user", "profile"],
  user: ["auth", "authentication", "login", "account"],
  db: ["database", "postgres", "collection", "data"],
  sql: ["database", "postgres", "query"],
  publish: ["deploy", "launch", "ship", "host", "production"],
  ship: ["deploy", "publish", "launch", "production"],
  hosting: ["deploy", "host", "production", "live"],
  sell: ["publish", "payment", "app store", "revenue", "earn"],
  build: ["create", "scaffold", "init", "new", "make"],
  start: ["quickstart", "getting started", "begin", "init", "setup"],
  new: ["create", "init", "scaffold", "build"],
  how: ["tutorial", "guide", "example", "learn"],
  learn: ["tutorial", "guide", "example", "how"],
  cursor: ["mcp", "ai", "editor", "ide"],
  claude: ["mcp", "ai", "editor", "chatgpt"],
  vscode: ["mcp", "ai", "editor", "ide"],
  windsurf: ["mcp", "ai", "editor", "ide"],
  components: ["ui", "ui-kit", "react", "button", "component"],
  customize: ["theme", "branding", "colors", "modify", "change"],
  errors: ["error", "troubleshooting", "debug", "fix", "problems"],
  help: ["support", "discord", "documentation", "guide", "faq"],
};

/**
 * Relevance scoring with synonym expansion.
 */
function scoreResult(entry: DocsEntry, query: string): number {
  const queryLower = query.toLowerCase();
  const queryWords = queryLower.split(/\s+/);
  let score = 0;

  // Expand query words with synonyms
  const expandedWords = new Set(queryWords);
  for (const word of queryWords) {
    const syns = SYNONYMS[word];
    if (syns) {
      for (const syn of syns) {
        expandedWords.add(syn);
      }
    }
  }

  // Keyword matches (highest weight)
  for (const keyword of entry.keywords) {
    if (queryLower.includes(keyword)) score += 10;
    for (const word of expandedWords) {
      if (keyword.includes(word)) score += 5;
      if (word.includes(keyword) && keyword.length >= 3) score += 3;
    }
  }

  // Title match (strong signal)
  const titleLower = entry.title.toLowerCase();
  if (titleLower.includes(queryLower)) score += 20;
  for (const word of queryWords) {
    if (word.length > 2 && titleLower.includes(word)) score += 8;
  }

  // Content match (weaker signal)
  const contentLower = entry.content.toLowerCase();
  for (const word of queryWords) {
    if (word.length > 2 && contentLower.includes(word)) score += 2;
  }

  return score;
}

export function registerSearchDocsTool(server: McpServer): void {
  server.registerTool(
    "varity_search_docs",
    {
      title: "Search Varity Docs",
      description:
        "Search Varity tutorials, troubleshooting guides, and deployment docs. " +
        "For SDK API references (database, auth, UI components), the varity://sdk/* resources provide complete coverage. " +
        "Use this tool for how-to guides, getting started tutorials, FAQ, and troubleshooting.",
      inputSchema: {
        query: z
          .string()
          .describe(
            "Search query (e.g., 'database collections', 'authentication setup', 'deploy to production')"
          ),
        maxResults: z
          .number()
          .optional()
          .default(3)
          .describe("Maximum number of results to return (default: 3)"),
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    async ({ query, maxResults }) => {
      try {
        // Build searchable entries from hardcoded index
        const allEntries = [...DOCS_INDEX];

        // Supplement with live docs if available
        const liveContent = await getLiveDocsContent();
        if (liveContent) {
          allEntries.push({
            title: "Varity Documentation (Live)",
            section: "Full Reference",
            url: `${INFRASTRUCTURE.DOCS}`,
            content: liveContent.substring(0, 5000),
            keywords: ["docs", "reference", "guide", "tutorial", "api", "sdk", "database", "auth", "deploy"],
          });
        }

        const scored = allEntries.map((entry) => ({
          ...entry,
          score: scoreResult(entry, query),
        }))
          .filter((entry) => entry.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, maxResults);

        if (scored.length === 0) {
          return successResponse(
            {
              results: [],
              docsUrl: INFRASTRUCTURE.DOCS,
              suggestion:
                "Try broader terms like 'database', 'deploy', 'auth', 'template', or 'pricing'.",
            },
            `No results found for "${query}". Try browsing the full documentation at ${INFRASTRUCTURE.DOCS}`
          );
        }

        const results = scored.map((entry) => ({
          title: entry.title,
          section: entry.section,
          url: entry.url,
          content: entry.content,
          // Surface MCP tool equivalents so developers using the MCP server
          // know which tool to call instead of running a CLI command.
          ...(() => {
            if (entry.content.includes("create-varity-app")) {
              return {
                mcp_note:
                  "MCP equivalent: use the varity_init tool instead of `npx create-varity-app`. " +
                  "It scaffolds the same project template directly in your workspace, no terminal required.",
              };
            }
            if (
              entry.content.includes("varitykit app deploy") ||
              entry.content.includes("varitykit deploy") ||
              entry.keywords.some((k) => k === "deploy" || k === "deployment")
            ) {
              return {
                mcp_note:
                  "MCP equivalent: use the varity_deploy tool to deploy without opening a terminal. " +
                  "It runs the full deploy pipeline and returns a live URL automatically.",
              };
            }
            if (
              entry.content.includes("db.collection") ||
              entry.keywords.some((k) => k === "database" || k === "crud" || k === "collection")
            ) {
              return {
                mcp_note:
                  "MCP equivalent: use the varity_add_collection tool to scaffold a new database collection " +
                  "(TypeScript type, accessor, React hook, and dashboard page) in one step, no manual file editing required.",
              };
            }
            return {};
          })(),
        }));

        return successResponse(
          {
            results,
            query,
            totalResults: results.length,
            docsUrl: INFRASTRUCTURE.DOCS,
          },
          `Found ${results.length} result(s) for "${query}"`
        );
      } catch (error) {
        return errorResponse(
          "SEARCH_FAILED",
          `Failed to search documentation: ${error}`,
          `Try browsing the docs directly at ${INFRASTRUCTURE.DOCS}`
        );
      }
    }
  );
}
