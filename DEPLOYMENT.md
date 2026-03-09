# Deploying Varity MCP HTTP Server to mcp.varity.so

This guide covers deploying the Varity MCP HTTP server to production at `https://mcp.varity.so`.

---

## Architecture Overview

```
Browser-based LLMs (Claude.ai, ChatGPT)
    ↓
https://mcp.varity.so  (Reverse Proxy: Caddy/nginx)
    ↓
Node.js MCP Server (port 3100)
    ↓
Varity Infrastructure (auth.varity.so, varity.app)
```

**Key Requirements:**
- Long-running Node.js process
- Reverse proxy with SSL (Caddy or nginx)
- OAuth redirect handling
- CORS headers for browser clients
- Health check monitoring

---

## Option 1: Deploy on Akash (Recommended)

### Why Akash?
- Decentralized infrastructure (aligns with Varity philosophy)
- ~$2-5/month for the MCP server
- Auto-restart on failures
- Easy to deploy containers

### Step 1: Create Dockerfile

```dockerfile
# varity-sdk-private/packages/cli/varity-mcp/Dockerfile
FROM node:18-alpine

WORKDIR /app

# Copy package files
COPY package.json package-lock.json ./
RUN npm ci --production

# Copy built dist/
COPY dist ./dist

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3100/health', (r) => { process.exit(r.statusCode === 200 ? 0 : 1) })"

EXPOSE 3100

CMD ["node", "dist/index.js", "--transport", "http", "--port", "3100"]
```

### Step 2: Build and Push Image

```bash
cd /home/macoding/varity-workspace/varity-sdk-private/packages/cli/varity-mcp

# Build the image
docker build -t ghcr.io/varity-labs/varity-mcp:latest .

# Push to GitHub Container Registry
docker push ghcr.io/varity-labs/varity-mcp:latest
```

### Step 3: Create Akash SDL

```yaml
# deploy.yaml
---
version: "2.0"

services:
  mcp:
    image: ghcr.io/varity-labs/varity-mcp:latest
    expose:
      - port: 3100
        as: 80
        to:
          - global: true
    env:
      - NODE_ENV=production
      - VARITY_AUTH_URL=https://auth.varity.so
      - VARITY_GATEWAY_URL=https://varity.app

profiles:
  compute:
    mcp:
      resources:
        cpu:
          units: 0.5
        memory:
          size: 512Mi
        storage:
          size: 1Gi

  placement:
    akash:
      pricing:
        mcp:
          denom: uakt
          amount: 1000

deployment:
  mcp:
    akash:
      profile: mcp
      count: 1
```

### Step 4: Deploy to Akash

```bash
# Using Akash Console API or CLI
akash tx deployment create deploy.yaml --from wallet --chain-id akashnet-2

# Get the deployment URL (will be something like)
# http://provider.akashprovid.com:31234
```

### Step 5: Set Up Reverse Proxy

On a server with `mcp.varity.so` pointing to it (DigitalOcean, AWS, or wherever):

**Using Caddy (Recommended — auto SSL):**

```caddyfile
# /etc/caddy/Caddyfile

mcp.varity.so {
    reverse_proxy http://provider.akashprovid.com:31234 {
        header_up Host {upstream_hostport}
        header_up X-Forwarded-For {remote}
        header_up X-Forwarded-Proto {scheme}
    }

    # CORS headers
    @options {
        method OPTIONS
    }
    handle @options {
        header Access-Control-Allow-Origin *
        header Access-Control-Allow-Methods "GET, POST, DELETE, OPTIONS"
        header Access-Control-Allow-Headers "Content-Type, Authorization, Mcp-Session-Id"
        header Access-Control-Expose-Headers "Mcp-Session-Id"
        respond 204
    }

    header Access-Control-Allow-Origin *
    header Access-Control-Allow-Methods "GET, POST, DELETE, OPTIONS"
    header Access-Control-Allow-Headers "Content-Type, Authorization, Mcp-Session-Id"
    header Access-Control-Expose-Headers "Mcp-Session-Id"

    # Health check endpoint
    handle /health {
        reverse_proxy http://provider.akashprovid.com:31234
    }

    # MCP endpoint
    handle /mcp {
        reverse_proxy http://provider.akashprovid.com:31234
    }

    # Root health check
    handle / {
        reverse_proxy http://provider.akashprovid.com:31234
    }

    # Logging
    log {
        output file /var/log/caddy/mcp.log
        format json
    }
}
```

**Using nginx:**

```nginx
# /etc/nginx/sites-available/mcp.varity.so

server {
    listen 80;
    listen [::]:80;
    server_name mcp.varity.so;

    # Redirect to HTTPS
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name mcp.varity.so;

    # SSL (use certbot for Let's Encrypt)
    ssl_certificate /etc/letsencrypt/live/mcp.varity.so/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/mcp.varity.so/privkey.pem;

    # CORS
    add_header 'Access-Control-Allow-Origin' '*' always;
    add_header 'Access-Control-Allow-Methods' 'GET, POST, DELETE, OPTIONS' always;
    add_header 'Access-Control-Allow-Headers' 'Content-Type, Authorization, Mcp-Session-Id' always;
    add_header 'Access-Control-Expose-Headers' 'Mcp-Session-Id' always;

    # OPTIONS preflight
    if ($request_method = 'OPTIONS') {
        return 204;
    }

    location / {
        proxy_pass http://provider.akashprovid.com:31234;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # SSE support (for streaming responses)
        proxy_set_header Connection '';
        proxy_http_version 1.1;
        chunked_transfer_encoding off;
        proxy_buffering off;
        proxy_cache off;
    }

    access_log /var/log/nginx/mcp.access.log;
    error_log /var/log/nginx/mcp.error.log;
}
```

**Start/reload Caddy or nginx:**

```bash
# Caddy
sudo systemctl reload caddy

# nginx (after running certbot for SSL)
sudo certbot --nginx -d mcp.varity.so
sudo systemctl reload nginx
```

---

## Option 2: Deploy on Railway (Easier, but Centralized)

Railway provides easier deployment but uses centralized infrastructure.

### Step 1: Create railway.json

```json
{
  "$schema": "https://railway.app/railway.schema.json",
  "build": {
    "builder": "NIXPACKS"
  },
  "deploy": {
    "startCommand": "node dist/index.js --transport http --port 3100",
    "healthcheckPath": "/health",
    "healthcheckTimeout": 100
  }
}
```

### Step 2: Deploy

```bash
# Install Railway CLI
npm install -g @railway/cli

# Login
railway login

# Link to project
railway link

# Deploy
railway up
```

### Step 3: Add Custom Domain

In Railway dashboard:
1. Go to Settings → Domains
2. Add custom domain: `mcp.varity.so`
3. Update DNS: CNAME `mcp.varity.so` → `[railway-generated-domain]`

Railway handles SSL automatically.

---

## Option 3: Deploy on DigitalOcean App Platform

### Step 1: Create app.yaml

```yaml
name: varity-mcp
services:
  - name: mcp-server
    github:
      repo: varity-labs/varity-sdk
      branch: main
      deploy_on_push: true
    source_dir: /packages/cli/varity-mcp
    build_command: npm run build
    run_command: node dist/index.js --transport http --port 3100
    environment_slug: node-js
    instance_count: 1
    instance_size_slug: basic-xxs
    http_port: 3100
    health_check:
      http_path: /health
    envs:
      - key: NODE_ENV
        value: production
      - key: VARITY_AUTH_URL
        value: https://auth.varity.so
      - key: VARITY_GATEWAY_URL
        value: https://varity.app

domains:
  - domain: mcp.varity.so
    type: PRIMARY
```

### Step 2: Deploy

```bash
doctl apps create --spec app.yaml
```

DigitalOcean handles SSL and CORS automatically.

**Cost:** ~$5/month for basic-xxs instance

---

## Environment Variables (Production)

Set these environment variables in your deployment:

```bash
NODE_ENV=production
VARITY_AUTH_URL=https://auth.varity.so
VARITY_GATEWAY_URL=https://varity.app

# Optional: Dev token for testing (DO NOT use in production)
# VARITY_MCP_DEV_TOKEN=your-dev-token
```

---

## Monitoring & Health Checks

### Health Check Endpoint

The MCP server exposes `/health`:

```bash
curl https://mcp.varity.so/health
# {"status":"ok","version":"1.1.0","transport":"http"}
```

### Uptime Monitoring

Add to an uptime monitor (UptimeRobot, Pingdom, or custom):

- **URL:** `https://mcp.varity.so/health`
- **Expected:** HTTP 200, JSON with `"status":"ok"`
- **Interval:** Every 5 minutes
- **Alert:** If down for 2 consecutive checks

### Logging

**View logs:**

```bash
# Akash (via provider)
akash provider lease-logs --dseq [deployment-seq]

# Railway
railway logs

# DigitalOcean
doctl apps logs [app-id] --type RUN

# Caddy
sudo tail -f /var/log/caddy/mcp.log

# nginx
sudo tail -f /var/log/nginx/mcp.access.log
sudo tail -f /var/log/nginx/mcp.error.log
```

---

## Testing the Deployment

### 1. Health Check

```bash
curl https://mcp.varity.so/health
```

Expected:
```json
{"status":"ok","version":"1.1.0","transport":"http"}
```

### 2. MCP Session Creation

```bash
curl -X POST https://mcp.varity.so/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"initialize","params":{},"id":1}'
```

Expected: Session ID in `Mcp-Session-Id` header

### 3. CORS Preflight

```bash
curl -X OPTIONS https://mcp.varity.so/mcp \
  -H "Access-Control-Request-Method: POST" \
  -H "Access-Control-Request-Headers: Content-Type" \
  -v
```

Expected: 204 with CORS headers

### 4. Connect from Claude.ai

1. Go to Claude.ai → Settings → Connectors
2. Add MCP Server
3. URL: `https://mcp.varity.so`
4. Test connection

Expected: Successful connection, see 7 Varity tools

---

## Scaling Considerations

For MVP launch, a single instance is sufficient. For scale:

1. **Multiple instances** — Run 2-3 replicas behind a load balancer
2. **Session persistence** — Use Redis for session storage instead of in-memory
3. **Rate limiting** — Add rate limits at the reverse proxy level
4. **CDN** — CloudFlare in front for DDoS protection

---

## Troubleshooting

**"Site can't be reached"**
- Check DNS: `dig mcp.varity.so`
- Verify reverse proxy is running: `systemctl status caddy` or `systemctl status nginx`
- Check firewall: ports 80/443 open

**"CORS error" in browser**
- Verify reverse proxy has CORS headers (see configs above)
- Check `Access-Control-Allow-Origin: *` in response

**"Session not found"**
- Sessions are in-memory and cleared on restart
- Clients should reconnect with fresh POST to /mcp

**Health check failing**
- Check Node.js process: `ps aux | grep node`
- Verify port 3100 is listening: `netstat -tlnp | grep 3100`
- Check logs for errors

---

## Next Steps After Deployment

1. **Update docs** — Add `https://mcp.varity.so` to all MCP documentation
2. **Update README** — Change "Coming soon" to "Live at https://mcp.varity.so"
3. **Test in Claude.ai** — Verify all 7 tools work end-to-end
4. **Monitor uptime** — Add to UptimeRobot or equivalent
5. **Beta announcement** — Tell beta testers they can now use MCP from browser

---

## Quick Deploy Checklist

- [ ] Build and test HTTP mode locally: `npm run build && npm run start:http`
- [ ] Create Dockerfile
- [ ] Push image to container registry
- [ ] Deploy to Akash/Railway/DigitalOcean
- [ ] Configure reverse proxy with SSL
- [ ] Set environment variables
- [ ] Test health endpoint: `curl https://mcp.varity.so/health`
- [ ] Test CORS headers
- [ ] Connect from Claude.ai
- [ ] Set up uptime monitoring
- [ ] Update all documentation with live URL
