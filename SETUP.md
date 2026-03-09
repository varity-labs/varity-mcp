# Varity MCP Server - Standalone Repo Setup

This is the standalone repository for `@varity-labs/mcp`, deployed to `https://mcp.varity.so`.

## Quick Links

- **npm package**: https://www.npmjs.com/package/@varity-labs/mcp
- **Hosted MCP**: https://mcp.varity.so
- **Documentation**: https://docs.varity.so/ai-tools/mcp-server-spec
- **Main SDK repo**: https://github.com/varity-labs/varity-sdk

---

## Repository Structure

```
varity-mcp/
├── src/                    # TypeScript source
│   ├── index.ts           # Entry point (stdio/HTTP modes)
│   ├── server.ts          # MCP server instance
│   ├── auth/              # OAuth provider
│   ├── tools/             # 7 MCP tools
│   └── utils/             # Config, responses, CLI bridge
├── dist/                  # Compiled JS (generated)
├── Dockerfile             # Container image
├── 4everland.json         # 4everland deployment config
├── .github/workflows/     # CI/CD
│   └── deploy-4everland.yml
├── DEPLOYMENT.md          # Full deployment guide
├── MCP_STATUS.md          # Implementation checklist
└── README.md              # User-facing docs
```

---

## Development

### Prerequisites

- Node.js 18+
- npm or pnpm

### Install

```bash
npm install
```

### Build

```bash
npm run build
```

### Run Locally

**stdio mode** (for Cursor, Claude Code, Windsurf):
```bash
npm start
```

**HTTP mode** (for Claude.ai, ChatGPT):
```bash
npm run start:http
# Runs at http://localhost:3100
```

### Test Health Check

```bash
curl http://localhost:3100/health
# {"status":"ok","version":"1.1.0","transport":"http"}
```

---

## Deployment to 4everland

### Prerequisites

1. **4everland account** with container hosting enabled
2. **GitHub secrets** configured:
   - `FOUREVERLAND_API_KEY` - API key from 4everland dashboard

### Automatic Deployment

Every push to `main` triggers:
1. Build TypeScript → `dist/`
2. Build Docker image
3. Push to GitHub Container Registry (ghcr.io)
4. Deploy to 4everland
5. Health check at `https://mcp.varity.so/health`

See `.github/workflows/deploy-4everland.yml` for details.

### Manual Deployment

```bash
# Build locally
npm run build

# Build Docker image
docker build -t ghcr.io/varity-labs/varity-mcp:latest .

# Push to GHCR
docker login ghcr.io -u [github-username] -p [github-pat]
docker push ghcr.io/varity-labs/varity-mcp:latest

# Deploy to 4everland (via dashboard or API)
```

See `DEPLOYMENT.md` for alternative deployment options (Akash, Railway, DigitalOcean).

---

## Publishing to npm

```bash
# Bump version
npm version patch  # or minor, major

# Publish (requires npm auth)
npm publish
```

The `prepublishOnly` script automatically builds TypeScript before publish.

---

## Environment Variables (Production)

Set these in 4everland dashboard or `4everland.json`:

```bash
NODE_ENV=production
VARITY_AUTH_URL=https://auth.varity.so
VARITY_GATEWAY_URL=https://varity.app

# Optional: Dev token for testing (DO NOT use in prod)
# VARITY_MCP_DEV_TOKEN=your-dev-token
```

---

## Syncing from Private Repo

This repo is synced from `Michael-Abril/varity-sdk-private/packages/cli/varity-mcp`.

**Sync workflow:**
1. Make changes in private repo
2. Run sync script (TBD)
3. Changes appear here
4. CI/CD auto-deploys

---

## Testing

### Local stdio test
```bash
npm run build
echo '{"jsonrpc":"2.0","method":"tools/list","id":1}' | npm start
```

### Local HTTP test
```bash
npm run build
npm run start:http &

curl -X POST http://localhost:3100/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"initialize","params":{},"id":1}'
```

---

## Monitoring

- **Health endpoint**: https://mcp.varity.so/health
- **Expected response**: `{"status":"ok","version":"1.1.0","transport":"http"}`
- **Uptime monitoring**: Add to UptimeRobot, Pingdom, or similar

---

## Troubleshooting

**Build fails:**
```bash
rm -rf dist node_modules
npm install
npm run build
```

**Docker build fails:**
```bash
# Make sure dist/ exists
npm run build
docker build -t test .
```

**4everland deployment fails:**
- Check GitHub Actions logs
- Verify `FOUREVERLAND_API_KEY` secret is set
- Check 4everland dashboard for errors

**mcp.varity.so unreachable:**
- Check 4everland container status
- Verify DNS: `dig mcp.varity.so`
- Check health endpoint logs in 4everland dashboard

---

## Support

- [Documentation](https://docs.varity.so/ai-tools/mcp-server-spec)
- [Discord](https://discord.gg/7vWsdwa2Bg)
- [GitHub Issues](https://github.com/varity-labs/varity-mcp/issues)
