# Deploy Varity MCP to 4everland - Step-by-Step Guide

This guide walks through deploying the Varity MCP HTTP server to `https://mcp.varity.so` using 4everland.

**Time estimate:** 30 minutes

---

## Prerequisites

- [ ] 4everland account (sign up at https://4everland.org)
- [ ] GitHub account with access to `varity-labs` org
- [ ] DNS access to configure `mcp.varity.so`

---

## Step 1: Create GitHub Repository

```bash
# Go to GitHub
# Create new repo: varity-labs/varity-mcp
# Description: "Varity MCP Server - deploy production apps from AI coding tools"
# Public repo
# No template, no README (we have one)
```

---

## Step 2: Push Code to GitHub

```bash
cd /home/macoding/varity-workspace/varity-mcp-standalone

# Initialize git
git init
git add .
git commit -m "Initial commit - Varity MCP v1.1.0

- 7 MCP tools (search, deploy, cost calc, store submission)
- stdio + HTTP transports
- 100% docs coverage (56 pages indexed)
- Zero crypto jargon
- OAuth provider scaffolded
- 4everland deployment config
- CI/CD pipeline"

# Add remote
git remote add origin https://github.com/varity-labs/varity-mcp.git

# Push
git branch -M main
git push -u origin main
```

**Verify:** Visit https://github.com/varity-labs/varity-mcp - code should be visible

---

## Step 3: Set Up 4everland Project

### A. Create Project

1. Log in to 4everland dashboard
2. Go to **Hosting** → **New Project**
3. Select **Container** (not Static Site)
4. Connect GitHub repo: `varity-labs/varity-mcp`
5. Configure:
   - **Branch:** `main`
   - **Root directory:** `/`
   - **Build command:** `npm run build`
   - **Port:** `3100`

### B. Environment Variables

Add these in 4everland → Settings → Environment:

```
NODE_ENV=production
VARITY_AUTH_URL=https://auth.varity.so
VARITY_GATEWAY_URL=https://varity.app
VARITY_MCP_DEV_TOKEN=your-temp-dev-token-here
```

**Note:** `VARITY_MCP_DEV_TOKEN` is temporary bypass until OAuth is fully integrated.

### C. Custom Domain

1. Go to **Settings** → **Domains**
2. Add custom domain: `mcp.varity.so`
3. 4everland will show DNS records to add

---

## Step 4: Configure DNS

In your DNS provider (Cloudflare, Route53, etc.):

```
Type: CNAME
Name: mcp
Value: [4everland-provided-endpoint]
TTL: 300 (5 minutes)
```

**Example:**
```
mcp.varity.so CNAME varity-mcp-abc123.4everland.app
```

**Verify DNS propagation:**
```bash
dig mcp.varity.so +short
# Should show 4everland IP
```

---

## Step 5: Configure GitHub Secrets

For CI/CD auto-deployment:

1. Go to https://github.com/varity-labs/varity-mcp/settings/secrets/actions
2. Add secret: `FOUREVERLAND_API_KEY`
3. Value: Get from 4everland dashboard → Settings → API Keys

---

## Step 6: Trigger Deployment

### Option A: Automatic (Recommended)

Just push to main:
```bash
git commit --allow-empty -m "Trigger deployment"
git push
```

GitHub Actions will:
1. Build TypeScript → `dist/`
2. Build Docker image
3. Push to GitHub Container Registry
4. Deploy to 4everland
5. Run health check

**Monitor:** https://github.com/varity-labs/varity-mcp/actions

### Option B: Manual

In 4everland dashboard:
1. Go to project page
2. Click **Deploy**
3. Select branch: `main`
4. Click **Deploy Now**

---

## Step 7: Verify Deployment

### Health Check

```bash
curl https://mcp.varity.so/health
```

**Expected response:**
```json
{"status":"ok","version":"1.1.0","transport":"http"}
```

### MCP Session Creation

```bash
curl -X POST https://mcp.varity.so/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"initialize","params":{},"id":1}' \
  -v
```

**Expected:**
- HTTP 200
- `Mcp-Session-Id` header in response
- JSON-RPC response with server info

### CORS Headers

```bash
curl -X OPTIONS https://mcp.varity.so/mcp \
  -H "Access-Control-Request-Method: POST" \
  -H "Access-Control-Request-Headers: Content-Type" \
  -v
```

**Expected:**
- HTTP 204
- `Access-Control-Allow-Origin: *`
- `Access-Control-Allow-Methods: GET, POST, DELETE, OPTIONS`

---

## Step 8: Test from Claude.ai

1. Open https://claude.ai
2. Go to **Settings** → **Connectors**
3. Click **Add MCP Server**
4. Enter URL: `https://mcp.varity.so`
5. Click **Test Connection**

**Expected:**
- ✅ Connection successful
- See 7 Varity tools in the list:
  - `varity_search_docs`
  - `varity_cost_calculator`
  - `varity_deploy`
  - `varity_deploy_status`
  - `varity_deploy_logs`
  - `varity_submit_to_store`
  - (Note: `varity_init` is stdio-only, won't appear)

**Test a tool:**

Prompt in Claude.ai:
```
Search the Varity docs for how to set up authentication
```

Claude should call `varity_search_docs` and return results.

---

## Step 9: Update Documentation

Update these docs to link to the live server:

### A. varity-docs repo

**File:** `src/content/docs/ai-tools/mcp-server-spec.mdx`

Find line ~256:
```mdx
Connect directly to the hosted Varity MCP at:

```
https://mcp.varity.so
```
```

Verify it says "hosted" (not "Coming soon").

### B. varity-internal repo

**File:** `11-beta-program/onboarding.md`

Verify the MCP section mentions `https://mcp.varity.so`.

### C. README files

All READMEs already link to hosted MCP - no changes needed.

---

## Step 10: Publish to npm

Now that the hosted server is live, publish v1.1.0:

```bash
cd /home/macoding/varity-workspace/varity-mcp-standalone

# Make sure you're logged in to npm
npm login

# Publish
npm publish
```

**Verify:** https://www.npmjs.com/package/@varity-labs/mcp should show v1.1.0

---

## Step 11: Submit to MCP Marketplaces

Use content from `varity-internal/11-beta-program/mcp-marketplaces.md`:

1. **mcp.so** - https://mcp.so/submit
2. **smithery.ai** - https://smithery.ai/submit
3. **glama.ai** - https://glama.ai/mcp/servers/submit
4. **awesome-mcp-servers** - PR to https://github.com/punkpeye/awesome-mcp-servers

---

## Troubleshooting

### "Site can't be reached"

**Cause:** DNS not propagated yet

**Fix:**
```bash
# Check DNS
dig mcp.varity.so +short

# If empty, wait 5-10 minutes for propagation
```

### "Health check returns 502/503"

**Cause:** Container not started yet

**Fix:**
1. Check 4everland dashboard → Logs
2. Verify container is running
3. Check environment variables are set
4. Rebuild if needed

### "CORS error in Claude.ai"

**Cause:** CORS headers missing

**Fix:**
1. Check 4everland logs for errors
2. Verify `/mcp` endpoint returns CORS headers:
   ```bash
   curl -X OPTIONS https://mcp.varity.so/mcp -v | grep Access-Control
   ```
3. Rebuild if headers missing

### "npm audit shows vulnerabilities"

**Expected:** 3 high-severity vulns in transitive deps (hono, @hono/node-server)

**Fix:** Low risk (we don't use vulnerable features). Wait for MCP SDK update or add overrides:

```json
// package.json
"overrides": {
  "hono": "^4.12.4",
  "@hono/node-server": "^1.19.10"
}
```

### "GitHub Actions fails"

**Cause:** Missing `FOUREVERLAND_API_KEY` secret

**Fix:**
1. Go to repo → Settings → Secrets → Actions
2. Add `FOUREVERLAND_API_KEY` with value from 4everland

---

## Post-Deployment Checklist

- [ ] `curl https://mcp.varity.so/health` returns 200
- [ ] Claude.ai can connect to `https://mcp.varity.so`
- [ ] Test `varity_search_docs` from Claude.ai
- [ ] npm v1.1.0 published
- [ ] Docs updated with live URL
- [ ] Submitted to 4 MCP marketplaces
- [ ] Beta testers notified
- [ ] Add to uptime monitor (UptimeRobot, Pingdom, etc.)

---

## Monitoring

**Uptime Monitor:**
- URL: `https://mcp.varity.so/health`
- Expected: HTTP 200, `{"status":"ok"}`
- Interval: Every 5 minutes
- Alert: Email/Slack if down for 2 consecutive checks

**4everland Metrics:**
- Dashboard → Analytics
- Track: Requests/min, error rate, latency

**Logs:**
- 4everland dashboard → Logs
- Filter by error level to catch issues

---

## Next Steps

See `PRODUCTION_READINESS.md` for hardening checklist:
- Rate limiting
- Error tracking (Sentry)
- Structured logging
- Automated tests
- OAuth integration

**Current state:** MVP-ready, suitable for beta testing

**Production-grade:** 2-4 weeks of additional hardening
