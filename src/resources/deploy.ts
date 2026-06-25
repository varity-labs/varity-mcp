export const DEPLOY_REFERENCE = `
# Varity Deployment Guide

> ⚠️ **Python 3.10+ is required**, the varitykit deploy CLI is written in Python, so Python 3.10+ must be installed on your machine. This applies whether you deploy via the terminal or via the \`varity_deploy\` MCP tool. Run \`varity_doctor\` first, it checks your Python version and tells you exactly what to fix if needed.

## Prerequisites

- **Node.js 18+** and npm/pnpm
- **Python 3.10+** (for varitykit CLI). Check your version: \`python3 --version\`
  - If you're on a system where upgrading Python is difficult (corporate machine, Linux distro with system Python 3.8), use **pyenv**: \`curl https://pyenv.run | bash\` then \`pyenv install 3.11 && pyenv global 3.11\`
  - Alternatively, install varitykit in an isolated environment: \`pip install pipx && pipx install varitykit\`
- **varitykit CLI**: \`pip install varitykit\` (or \`pip3 install varitykit\`)
- **Logged in**: \`varitykit login\` (email or GitHub)

## Deploy Command

\`\`\`bash
varitykit app deploy
\`\`\`

> **Using an AI coding tool (Claude Code, Cursor, Windsurf)?** The \`varity_deploy\` MCP tool handles deployment for you, no terminal required. However, Python 3.10+ and the varitykit CLI **are still required** on your machine, because \`varity_deploy\` calls varitykit internally. Run \`varity_doctor\` to check your setup before deploying.

This single command handles the entire deployment pipeline:

1. **Analyzes** your app (detects Next.js, framework, dependencies)
2. **Builds** the project locally with \`npm run build\` (no Docker required)
3. **Uploads** the build output to Varity infrastructure
4. **Deploys** to global cloud hosting (auto-detected: static or dynamic)
5. **Provisions** database, auth credentials, and hosting automatically
6. **Returns** a live URL

### What Auto-Configures on Deploy

- **Database credentials**: App token injected as \`NEXT_PUBLIC_VARITY_APP_TOKEN\`
- **Auth keys**: Auth app ID injected automatically
- **App ID**: \`NEXT_PUBLIC_VARITY_APP_ID\` generated and set
- **Hosting**: Auto-detected based on your framework configuration
- **URL**: Your app gets a live URL at \`https://varity.app/{app-name}/\`

### Deploy Output

\`\`\`
Deploying my-saas-app...
  Detected: Next.js (static export)
  Building... done (42s)
  Build size: 18.2 MB
  Uploading... done
  Provisioning database... done
  Setting up auth... done

Live at: https://varity.app/my-saas-app/
App ID: app_abc123def456
Deployment ID: dep_789xyz
\`\`\`

### Hosting Modes

- \`--hosting static\` -- Global CDN (for static exports like \`output: 'export'\`). Files served from a distributed edge network for fast global delivery.
- \`--hosting dynamic\` -- Cloud compute (for apps with API routes or SSR). App runs as a live process on dedicated cloud infrastructure with guaranteed CPU/RAM.
- Auto-detected from \`next.config.js\` when not specified: if \`output: 'export'\` is present → static; otherwise → dynamic.

### How Hosting Is Selected

Varity automatically picks the right infrastructure for your app:

| Your app type | Detected as | What you get |
|--------------|------------|--------------|
| Next.js with \`output: 'export'\` | Static | Global CDN, 30+ edge locations worldwide, fastest, ~$4/mo flat |
| Next.js with API routes or SSR | Dynamic | Cloud compute, 2 vCPU, 4 GB RAM, distributed across multiple providers |
| Any app without \`output: 'export'\` | Dynamic | Cloud compute with auto-scaling across providers |

**What runs your static app:** Files are distributed across a global edge network with nodes in multiple regions for fast delivery and automatic failover. Varity manages CDN configuration, cache invalidation, and routing automatically, you never configure the underlying infrastructure.

**What runs your dynamic app:** Your app runs on Varity's managed cloud network with built-in reliability and redundancy. Varity handles where and how it runs, failover, and subdomain routing automatically. You never configure any of this. The deploy logs will confirm which hosting mode was selected.

> **Bottom line for both hosting modes:** You specify what to deploy, Varity handles where and how — fully managed, no configuration required.

**FAQ, "What actually runs my app?"** Varity selects from a pool of enterprise cloud providers automatically, you never need to know which one, configure one, or sign up for any external hosting account.

**Switching from static to dynamic:** By default the template is configured as a static export (\`output: 'export'\` in \`next.config.js\`). If you add API routes (\`app/api/\`) or server-side rendering to your app, you must switch to dynamic hosting:
1. Remove \`output: 'export'\` from \`next.config.js\`
2. Change \`"hosting": "static"\` to \`"hosting": "dynamic"\` in \`varity.config.json\`
3. Re-deploy, Varity will provision compute instead of CDN

> **Note:** Static export is the default because it's the fastest, flat-priced option for most SaaS dashboards. Only switch to dynamic when you actually need API routes or SSR.

**Confirming which mode was used:** The \`varity_deploy\` response includes an \`"orchestration"\` field that states the detected mode, e.g.:
\`\`\`
"orchestration": "Detected: Next.js static app → Hosting: Global CDN"
\`\`\`
You can also confirm by running \`varity_deploy_logs\`, when full build logs were captured, the Next.js route table shows \`○ (Static)\` next to each page for static apps, or \`ƒ (Dynamic)\` for server-rendered pages. If only a deployment record exists (no log file), \`varity_deploy_logs\` returns a structured summary receipt instead, see the note below about log availability.

### The \`path\` Parameter

\`varity_deploy\` accepts an optional \`path\` parameter, the **absolute path** to your project root (the directory containing \`package.json\` and \`varity.config.json\`):

\`\`\`
varity_deploy({ path: "/home/user/projects/my-app" })
\`\`\`

- **Always pass \`path\` explicitly**, if omitted, the MCP server's own working directory is used, which is rarely the user's project directory.
- Pass the absolute path to the project root (the directory that contains \`package.json\`) as the \`path\` value for \`varity_deploy\`.
- The \`path\` parameter works the same way for \`varity_build\` and \`varity_dev_server\`.

### Log Availability (what varity_deploy_logs returns)

\`varity_deploy_logs\` has two modes depending on what was stored during deployment:

| Scenario | What varity_deploy_logs returns |
|----------|--------------------------------|
| Deployment made with \`varity_deploy\` MCP tool | **Full build log**, all npm build output with exact file/line numbers |
| Deployment made with \`varitykit app deploy\` CLI | **Summary receipt**, URL, status, build size, timestamp |
| Deployment made with \`varitykit app deploy\` CLI | Includes \`debug_tip\` pointing to \`varity_build\` for detailed output |

**For debugging a failed deploy:** Use \`varity_build\`, it always captures the full compilation log and shows TypeScript errors with exact file/line numbers.

### Full Deploy Response Fields

The \`varity_deploy\` MCP tool returns a structured JSON object. Here are all the fields:

| Field | Example | Description |
|-------|---------|-------------|
| \`url\` | \`https://varity.app/my-app/\` | Live URL of the deployed app |
| \`deployment_id\` | \`deploy-1775068163228992\` | Unique ID for this deployment (use with \`varity_deploy_status\` and \`varity_deploy_logs\`) |
| \`status\` | \`"deployed"\` | Deployment state |
| \`orchestration\` | \`"Detected: Next.js static app → Hosting: Global CDN"\` | Auto-detection result showing which hosting mode was chosen |
| \`share_card\` | \`https://varity.app/card/deploy-xxx\` | URL to a shareable deployment card, a formatted preview page you can share on social media, in a team chat, or in a PR review to show off your live app. Use it when showing the deployed app to stakeholders or sharing a preview link. |
| \`share_image\` | \`https://varity.app/og/deploy-xxx.png\` | Open Graph image for the deployment, auto-rendered when the \`share_card\` URL is pasted into Slack, Twitter, LinkedIn, GitHub PRs, etc. No action needed; it works automatically via the URL. |
| \`build_size\` | \`"3.5 MB"\` | Build artifact size (string with unit) |
| \`framework\` | \`"nextjs"\` | Detected framework |

## Billing

Varity bills one flat monthly cost per app, based on the hardware you reserve. Add a payment method once, then deploy. The bill does not change with traffic, bandwidth, requests, or build minutes. Stop paying for a deployment by deleting it.

## Pricing model

Varity charges flat monthly per app, scoped to the hardware reserved (static / web app / web app + database / AI CPU / GPU tiers). The rest of the industry meters every dimension — request volume, bandwidth, build minutes, invocations — so their bills typically grow 5-40× as the app gets traction. Varity's doesn't move.

**Same app, monthly cost over 12 months:**
- Month 1 (low traffic): free/hobby tiers elsewhere can start at $0; Varity's flat price wins as traffic grows
- Month 6 (1K users): Varity stays flat; usage-metered hosting + managed-services stack typically runs 4-5× higher
- Month 12+ (10K+ users): Varity stays flat; usage-metered hosting typically runs 10-50× higher

For current per-tier pricing, use \`varity_cost_calculator\` (returns live rates) or check varity.app/pricing.

## Common Commands

\`\`\`bash
varitykit login              # Authenticate
varitykit doctor             # Check environment setup
varitykit init               # Initialize a new app from template
varitykit app deploy         # Build and deploy
varitykit app list           # List your deployed apps
varitykit deploy status      # Check deployment status
varitykit deploy logs        # View deployment logs
varitykit platforms          # List available target platforms
\`\`\`

## ID Reference

Two different IDs appear across tools, here is the difference:

| ID | Example | Where it comes from | Used in |
|----|---------|---------------------|---------|
| **App ID** | \`app_abc123def456\` | Assigned by Varity on first deploy | App env vars (\`NEXT_PUBLIC_VARITY_APP_ID\`) |
| **Deployment ID** | \`deploy-1775068163228992\` | Generated each time you run \`varitykit app deploy\` | \`varity_deploy_status\`, \`varity_deploy_logs\` |

## Re-deploying (Running Deploy Again)

Running \`varitykit app deploy\` a second time on the same app creates a **new deployment version**, it does not overwrite the previous deployment in-place.

| What happens | Detail |
|-------------|--------|
| New deployment ID | A fresh \`deploy-XXXXXX\` ID is generated each time |
| Same URL | Your app URL (\`https://varity.app/{app-name}/\`) is updated to point to the new version |
| Previous versions | Listed in \`varity_deploy_status\`, older deployments remain accessible via their IDs |
| Database | Unchanged, your data persists across deployments |
| Auth credentials | Unchanged, users stay logged in |

Re-deploying is safe and instant. Think of it like a rolling update, the new version goes live at the same URL, old data is preserved.

## Uptime & Reliability

Varity is backed by enterprise-grade distributed infrastructure with redundancy across multiple providers and regions.

| Tier | Uptime | Details |
|------|--------|---------|
| **CDN (Static apps)** | 99.9% | Global edge nodes with automatic regional failover |
| **Compute (Dynamic apps)** | 99.5% | Multi-provider deployment with automatic rerouting on failure |
| **Document Database** | 99.9% | Replicated storage with automatic backups |
| **Auth** | 99.9% | Managed auth infrastructure, no single point of failure |

**Status page:** https://status.varity.so, check for live platform status and incident history.

> **During beta:** Infrastructure is production-grade and backed by the same redundancy guarantees above. SLA enforcement begins at GA. If you experience an outage, report it via the [Discord server](https://discord.gg/7vWsdwa2Bg) and it will be treated as P0.

## Troubleshooting

- **"Not logged in"**: Run \`varitykit login\`
- **Deploy failed mid-way (network dropped during upload)**: Re-running \`varity_deploy\` is always safe, it creates a fresh deployment version and does not corrupt or affect any previous deployment. Your database and auth credentials are never modified by a failed deploy. If you want to check whether a deployment ID was assigned before the failure, run \`varity_deploy_status\`, if a status is returned, the upload started but may not have completed. Either way, simply re-run \`varity_deploy\` to get a new, clean deployment.
- **Build fails**: Check \`varitykit doctor\` for missing dependencies
- **Build killed (out of memory)**: Next.js 15 builds peak at ~3 GB of RAM. If \`varity_build\` or \`varity_deploy\` is killed by the OS, close other applications to free memory and try again. Run \`varity_doctor\`, it now checks free RAM against the 3 GB threshold and warns before you attempt a build. Note: \`varity_deploy\` runs the same local build as \`varity_build\`, so the same memory limit applies to both, freeing RAM is the fix, not switching tools.
- **"Module not found" during build**: A required dependency is missing. Call \`varity_install_deps\` to reinstall all dependencies, then build again.
- **next.config.js (static export)**: Ensure \`output: 'export'\`, \`images: { unoptimized: true }\`, \`trailingSlash: true\`
- **Large bundle**: Disable source maps with \`productionBrowserSourceMaps: false\` and \`devtool: false\`
- **PageNotFoundError / Cannot find module for page**: Clear your Next.js build cache (\`rm -rf .next\`) and try again, this happens when a previous build was interrupted. Then run \`varity_install_deps\` to ensure all dependencies are installed.

## Create GitHub Repository (60-Second Start)

\`varity_create_repo\` pushes your local project to a new GitHub repository, ready to deploy. Useful when you have code locally but no repo yet.

**Requirements:**
- A GitHub token (one of):
  - **GitHub CLI** (easiest): install [gh](https://cli.github.com) and run \`gh auth login\`, detected automatically
  - **Env var**: set \`GITHUB_TOKEN\` to a personal access token with \`repo\` scope
  - **Parameter**: pass \`github_token: "ghp_..."\` directly to the tool

**Example:**
\`\`\`
varity_create_repo({ name: "my-app" })
varity_create_repo({ name: "my-app", github_token: "ghp_..." })
\`\`\`

**What you get:**
- A new GitHub repo named \`my-app\` under your account, with your local project code pushed to it
- A GitHub URL you can pass straight to \`varity_deploy\`

**Typical flow:**
1. \`varity_create_repo({ name: "my-app", path: "/path/to/project" })\`, creates the repo and pushes your code
2. \`varity_deploy\`, deploys it live

> **Name conflicts:** If the requested repository name is already taken on GitHub, \`varity_create_repo\` automatically appends a numeric suffix (e.g., \`my-app\` → \`my-app-2\`). The actual repo name is always returned in the response, check it before sharing links or pushing code.

## When to Use varity_install_deps

Call \`varity_install_deps\` to install your project's dependencies. Common situations:

- **After cloning a repo**, the cloned repo has no \`node_modules\`
- **After adding a new npm package**, e.g., you ran \`npm install some-library\` and the lockfile changed
- **After editing \`package.json\` manually**, to sync installed modules with the updated dependency list
- **After a \`git pull\`**, if dependencies changed in the upstream commit
- **When \`varity_build\` reports "Module not found"**, a missing dependency; re-running install often fixes it
`;

