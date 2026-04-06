export const DEPLOY_REFERENCE = `
# Varity Deployment Guide

## Prerequisites

- **Node.js 18+** and npm/pnpm
- **Python 3.10+** (for varitykit CLI)
- **varitykit CLI**: \`pip install varitykit\`
- **Logged in**: \`varitykit login\` (email or GitHub -- no crypto wallet needed)

## Deploy Command

\`\`\`bash
varitykit app deploy
\`\`\`

This single command handles the entire deployment pipeline:

1. **Analyzes** your app (detects Next.js, framework, dependencies)
2. **Builds** a production Docker image server-side (Nixpacks -- no Docker required locally)
3. **Pushes** the image to GitHub Container Registry (GHCR)
4. **Deploys** to decentralized hosting (auto-detected: static or dynamic)
5. **Provisions** database, auth credentials, and hosting automatically
6. **Returns** a live URL

### What Auto-Configures on Deploy

- **Database credentials**: App token injected as \`NEXT_PUBLIC_VARITY_APP_TOKEN\`
- **Auth keys**: Privy app ID and thirdweb client ID injected automatically
- **App ID**: \`NEXT_PUBLIC_VARITY_APP_ID\` generated and set
- **Hosting**: Static apps go to IPFS, dynamic apps go to Akash compute
- **DNS**: Subdomain assigned at \`https://{app-name}.varity.app\`

### Deploy Output

\`\`\`
Deploying my-saas-app...
  Detected: Next.js (static export)
  Building image... done (42s)
  Build size: 18.2 MB
  Uploading... done
  Provisioning database... done
  Setting up auth... done

Live at: https://my-saas-app.varity.app
App ID: app_abc123def456
Deployment ID: dep_789xyz
\`\`\`

### Hosting Modes

- \`--hosting static\` -- IPFS/Filecoin (for static exports like \`output: 'export'\`)
- \`--hosting dynamic\` -- Akash Network (for apps with API routes or SSR)
- Auto-detected from \`next.config.js\` when not specified

## App Store Submission

After deploying, submit your app to the Varity App Store:

\`\`\`bash
varitykit app deploy --submit-to-store
\`\`\`

Or submit separately after deployment:
\`\`\`bash
varitykit app submit --app-id app_abc123def456
\`\`\`

In AI coding tools (Cursor, Windsurf, Claude Code), use the MCP tool:
\`\`\`
varity_submit_to_store({ appId: "app_abc123def456" })
\`\`\`

### Submission Flow

1. App is deployed and live
2. Automated verification runs (security scan, functional test)
3. App appears in store at \`store.varity.so\`
4. Developer can monitor via \`developer.store.varity.so\`

## Revenue Split

- **90% to developer** -- you keep the majority
- **10% to Varity platform** -- covers infrastructure and store listing

## Payments Status

Payments are **coming soon** for beta. During beta, all apps are free to deploy and use.
Developers can bill their own customers directly outside of Varity.

## Cost Comparison

| Scenario | AWS/GCP | Varity | Savings |
|----------|---------|--------|---------|
| SaaS app, 100 users + AI | ~$2,800/mo | ~$800/mo | ~70% |
| Static site + database | ~$50/mo | ~$15/mo | ~70% |
| Dynamic app + auth + storage | ~$200/mo | ~$40/mo | ~80% |

Infrastructure is 60-80% cheaper than traditional cloud providers because Varity uses
decentralized compute (Akash) and storage (Filecoin/IPFS) with bulk pricing.

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

## Troubleshooting

- **"Not logged in"**: Run \`varitykit login\`
- **Build fails**: Check \`varitykit doctor\` for missing dependencies
- **next.config.js**: Ensure \`output: 'export'\`, \`images: { unoptimized: true }\`, \`trailingSlash: true\`
- **Large bundle**: Disable source maps with \`productionBrowserSourceMaps: false\` and \`devtool: false\`
`;
