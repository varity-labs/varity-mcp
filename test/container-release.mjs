import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const dockerfile = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
const dockerignore = readFileSync(new URL("../.dockerignore", import.meta.url), "utf8");
const workflow = readFileSync(new URL("../.github/workflows/release-container.yml", import.meta.url), "utf8");

test("runtime container builds source reproducibly and runs as non-root", () => {
  assert.match(dockerfile, /FROM node:22-alpine AS build/);
  assert.match(dockerfile, /RUN npm ci\n/);
  assert.match(dockerfile, /RUN npm run build/);
  assert.match(dockerfile, /RUN npm ci --omit=dev && npm cache clean --force/);
  assert.match(dockerfile, /USER node/);
  assert.match(dockerfile, /--transport", "http", "--port", "3100"/);
  assert.doesNotMatch(dockerfile, /COPY\s+\.\s+\./);
  assert.doesNotMatch(dockerfile, /ARG|TOKEN|PASSWORD|SECRET/);
});

test("container context is a source allowlist that excludes environment files", () => {
  assert.equal(dockerignore, "**\n!package.json\n!package-lock.json\n!tsconfig.json\n!src/**\n");
  assert.doesNotMatch(dockerignore, /!\.env/);
});

test("GHCR release is immutable-tag driven and package-version checked", () => {
  assert.match(workflow, /tags:\n\s+- "mcp-v\*"/);
  assert.match(workflow, /packages: write/);
  assert.match(workflow, /package_version=.*package\.json/);
  assert.match(workflow, /docker\/build-push-action@v6/);
  assert.match(workflow, /push: true/);
  assert.match(workflow, /versioned_tag/);
  assert.doesNotMatch(workflow, /workflow_dispatch|DOCKERHUB|npm publish/);
});
