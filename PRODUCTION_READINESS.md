# Varity MCP - Production Readiness Checklist

**Goal:** Enable users to build, deploy, and monetize apps in 60 seconds via Claude.ai/ChatGPT browser interface.

**Current Status:** 85% production-ready — core functionality complete, deployment automation needed.

---

## ✅ COMPLETE — Core Functionality

| Component | Status | Notes |
|-----------|--------|-------|
| **7 MCP tools** | ✅ | All tools implemented, tested, jargon-free |
| **stdio transport** | ✅ | Works in Cursor, Claude Code, Windsurf, VS Code |
| **HTTP transport** | ✅ | Express server with session management |
| **100% docs coverage** | ✅ | All 56 docs pages indexed, synonym search |
| **Zero jargon** | ✅ | No crypto/blockchain/wallet terminology |
| **Zod validation** | ✅ | All tool inputs validated |
| **Error handling** | ✅ | 4 error types, `isError` flag, suggestions |
| **CORS headers** | ✅ | Browser clients supported |
| **Health checks** | ✅ | `/health` endpoint returns 200 |
| **Docker image** | ✅ | Dockerfile ready, GHCR push configured |
| **CI/CD pipeline** | ✅ | GitHub Actions workflow ready |

---

## 🟡 IN PROGRESS — Infrastructure

| Component | Status | Action Required |
|-----------|--------|-----------------|
| **4everland deployment** | 🟡 | Need to create repo → push to GitHub → trigger CI/CD |
| **mcp.varity.so DNS** | 🟡 | Point DNS to 4everland endpoint |
| **OAuth integration** | 🟡 | auth.varity.so needs OAuth endpoints (see below) |
| **Session persistence** | 🟡 | Currently in-memory, need Redis for multi-instance scale |

### OAuth Integration (auth.varity.so)

**Current state:** ProxyOAuthServerProvider scaffolded in `src/auth/provider.ts`

**Required endpoints on auth.varity.so:**
```
GET  /authorize      - OAuth authorization page
POST /token          - Exchange code for access token
POST /revoke         - Revoke access token
POST /register       - Register new client
GET  /api/auth/verify - Verify access token
```

**Implementation needed:**
1. Add OAuth 2.0 server to auth.varity.so (use `node-oauth2-server` or similar)
2. Store client credentials in DB
3. Return token on successful login
4. MCP calls `/api/auth/verify` on each HTTP request

**Workaround for MVP:** Use `VARITY_MCP_DEV_TOKEN` env var to bypass OAuth (already implemented)

---

## ❌ MISSING — Production Hardening

### 1. Rate Limiting

**Why needed:** Prevent abuse, DDoS protection

**Implementation:**
- Add `express-rate-limit` middleware
- 100 requests/minute per IP
- 1000 requests/hour per authenticated user

**Code:**
```typescript
import rateLimit from 'express-rate-limit';

const limiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 100,
  message: { error: 'Too many requests, try again later' }
});

app.use('/mcp', limiter);
```

**Status:** ❌ Not implemented

---

### 2. Error Tracking (Sentry)

**Why needed:** Catch production errors, monitor performance

**Implementation:**
- Add `@sentry/node` package
- Initialize in `src/index.ts`
- Auto-capture exceptions

**Code:**
```typescript
import * as Sentry from '@sentry/node';

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV,
  tracesSampleRate: 0.1,
});
```

**Status:** ❌ Not implemented

---

### 3. Structured Logging

**Why needed:** Debug production issues, audit trail

**Current:** `console.log()` only

**Needed:** Winston or Pino with JSON logs

**Code:**
```typescript
import winston from 'winston';

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.json(),
  transports: [
    new winston.transports.File({ filename: 'error.log', level: 'error' }),
    new winston.transports.File({ filename: 'combined.log' }),
  ],
});

logger.info('MCP session created', { sessionId, transport: 'http' });
```

**Status:** ❌ Not implemented

---

### 4. Automated Tests

**Why needed:** Catch regressions, safe refactoring

**Current:** Manual testing only

**Needed:**
- Unit tests for all 7 tools (Vitest or Jest)
- Integration tests for HTTP endpoints (Supertest)
- E2E tests for full workflow (Playwright)

**Coverage target:** 80%+

**Example:**
```typescript
// tests/tools/search-docs.test.ts
import { describe, it, expect } from 'vitest';
import { searchDocs } from '../src/tools/search-docs';

describe('varity_search_docs', () => {
  it('returns results for "database"', async () => {
    const result = await searchDocs('database', 3);
    expect(result.length).toBeGreaterThan(0);
    expect(result[0].title).toContain('Database');
  });
});
```

**Status:** ❌ No tests

---

### 5. Load Testing

**Why needed:** Verify performance under load

**Tool:** k6 or Artillery

**Test scenarios:**
- 100 concurrent users
- 1000 requests/minute
- Session creation → tool call → result

**Acceptance:** < 500ms p95 latency, 0% error rate

**Status:** ❌ Not done

---

### 6. Security Audit

**Checklist:**
- [x] No secrets in code (use env vars) ✅
- [x] No SQL injection (we don't use SQL) ✅
- [x] No XSS (JSON responses only, no HTML) ✅
- [x] No CSRF (stateless API, no cookies) ✅
- [x] HTTPS enforced (reverse proxy handles) ✅
- [ ] Rate limiting (see #1) ❌
- [x] Input validation (Zod) ✅
- [~] Dependency audit (`npm audit`) 🟡

**npm audit findings (3 high):**
- `hono@<4.12.4` - serveStatic, setCookie, SSE vulnerabilities
- `@hono/node-server@<1.19.10` - static path bypass
- `express-rate-limit@>=8.2.0 <8.2.2` - IPv6 bypass

**Impact:** LOW - vulnerabilities are in @modelcontextprotocol/sdk's transitive dependencies. We don't use the vulnerable features (serveStatic, basicAuth, setCookie, SSE).

**Mitigation options:**
1. Wait for MCP SDK to update (recommended)
2. Use npm overrides to force newer versions
3. Accept risk (we don't use vulnerable code paths)

**Status:** 🟡 Low-risk vulnerabilities in transitive deps

---

### 7. CDN / DDoS Protection

**Why needed:** Fast global access, DDoS mitigation

**Options:**
- Cloudflare (free tier) in front of mcp.varity.so
- Caches `/health` responses
- Blocks malicious IPs

**Setup:**
1. Add mcp.varity.so to Cloudflare
2. Proxy through Cloudflare (orange cloud)
3. Enable "Under Attack" mode if needed

**Status:** ❌ Not configured

---

### 8. Session Persistence (Redis)

**Current:** In-memory Map (lost on restart, doesn't scale)

**Needed for scale:** Redis-backed session store

**Code:**
```typescript
import Redis from 'ioredis';

const redis = new Redis(process.env.REDIS_URL);

// Store session
await redis.setex(`mcp:session:${sessionId}`, 3600, JSON.stringify(transport));

// Get session
const data = await redis.get(`mcp:session:${sessionId}`);
```

**When needed:** If scaling to 2+ instances

**Status:** ❌ Not implemented (OK for single instance)

---

### 9. API Documentation (OpenAPI/Swagger)

**Why needed:** Help developers integrate

**Tool:** Swagger UI for `/mcp` endpoint

**Content:**
- POST /mcp - MCP JSON-RPC endpoint
- GET /health - Health check
- Authentication flow
- Example requests/responses

**Status:** ❌ Not created

---

### 10. Monitoring Dashboard

**Why needed:** Real-time visibility into production

**Metrics to track:**
- Requests/minute
- Error rate
- p95 latency
- Active sessions
- Tool usage (which tools are most popular)

**Tools:**
- Grafana + Prometheus (self-hosted)
- Datadog (SaaS)
- 4everland built-in metrics

**Status:** ❌ Not set up

---

## 🎯 MVP Launch Checklist (Immediate)

**To get mcp.varity.so live TODAY:**

- [ ] Create `varity-labs/varity-mcp` GitHub repo
- [ ] Push standalone code to GitHub
- [ ] Configure 4everland with `4everland.json`
- [ ] Set `FOUREVERLAND_API_KEY` in GitHub secrets
- [ ] Trigger CI/CD (push to main)
- [ ] Point DNS: `mcp.varity.so` CNAME → 4everland endpoint
- [ ] Test: `curl https://mcp.varity.so/health`
- [ ] Test: Connect from Claude.ai
- [ ] Add dev token bypass: `VARITY_MCP_DEV_TOKEN=temp-token` in 4everland
- [ ] Update docs to link to `https://mcp.varity.so`
- [ ] Publish v1.1.0 to npm

**Time estimate:** 30 minutes

---

## 🚀 Production Hardening (Post-MVP)

**Week 1-2 after launch:**
- [ ] Implement rate limiting (#1)
- [ ] Add Sentry error tracking (#2)
- [ ] Add structured logging (#3)
- [ ] Security audit (#6)
- [ ] Set up Cloudflare (#7)
- [ ] Write API docs (#9)

**Week 3-4:**
- [ ] Write automated tests (#4)
- [ ] Load testing (#5)
- [ ] OAuth integration with auth.varity.so (#8)
- [ ] Monitoring dashboard (#10)

**When to add Redis (#8):** Only if scaling to 2+ instances

---

## 📊 Success Metrics (Post-Launch)

**60-Second Workflow Target:**
1. User opens Claude.ai
2. Prompts: "Create a SaaS app called my-app"
3. MCP calls `varity_init` (❌ won't work from browser - stdio only)
4. Prompts: "Deploy this"
5. MCP calls `varity_deploy`
6. Returns: "Live at https://my-app.varity.so"

**BLOCKER:** `varity_init` requires local filesystem (stdio-only)

**Solution for browser workflow:**
1. User runs `npx create-varity-app my-app` locally ONCE
2. Opens project in browser IDE (Replit, StackBlitz, Gitpod)
3. Uses MCP from Claude.ai to deploy

**Alternative:** Create `varity_create_app` tool that generates code in-memory (no filesystem writes) and returns a GitHub repo URL or zip download.

---

## ❗ Critical Issue: Browser-Based Init

**Problem:** `varity_init` is stdio-only (needs local filesystem)

**User expectation:** 60-second build → deploy → monetize from ChatGPT/Claude.ai browser

**Current reality:** User must run `npx create-varity-app` locally first, THEN use browser MCP

**Solutions:**

### Option A: In-Memory Template Generation
Create new tool `varity_generate_template` that:
1. Returns full template code as JSON
2. User copies into Replit/StackBlitz/Gitpod
3. Then deploys via MCP

### Option B: GitHub Integration
Create new tool `varity_create_repo` that:
1. Calls GitHub API to create repo
2. Pushes template code via API
3. Returns clone URL
4. User opens in Gitpod (auto-setup)

### Option C: Hybrid Approach
Keep stdio-only `varity_init` for local use, add browser-friendly alternative

**Recommendation:** Option B (GitHub integration) for true 60-second experience

**Implementation:** Post-MVP (week 2-3)

---

## Summary

**Current state:** 85% production-ready
- ✅ All core features work
- ✅ HTTP transport ready
- ✅ CI/CD configured
- 🟡 Needs deployment to 4everland
- 🟡 Needs OAuth (workaround: dev token)
- ❌ Missing production hardening (rate limiting, monitoring, tests)

**To launch MVP:** Just need to create GitHub repo + trigger deployment (~30 min)

**To be truly production-grade:** Add 2-4 weeks of hardening (tests, monitoring, rate limiting, security audit)

**To achieve 60-second browser workflow:** Add GitHub integration tool (Option B above) for in-browser template creation

**Next immediate action:** Create `varity-labs/varity-mcp` repo and deploy to 4everland.
