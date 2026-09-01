import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const dockerfile = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
const dockerignore = readFileSync(new URL("../.dockerignore", import.meta.url), "utf8");
const workflow = readFileSync(new URL("../.github/workflows/release-container.yml", import.meta.url), "utf8");
const ciWorkflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const aliasGate = readFileSync(new URL("../scripts/release-alias-gate.mjs", import.meta.url), "utf8");

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

test("CI executes every supported runtime lane and the real Node 22 container", () => {
  assert.match(ciWorkflow, /build-test:[\s\S]*?node-version: 22\.11\.0/);
  assert.match(ciWorkflow, /node: \[22\.11\.0, 24\]/);
  assert.match(ciWorkflow, /node --test test\/runtime-version\.mjs/);
  assert.match(ciWorkflow, /docker run --detach/);
  assert.match(ciWorkflow, /curl --fail --silent --show-error http:\/\/127\.0\.0\.1:3100\/health/);
  assert.match(ciWorkflow, /trap cleanup EXIT/);
});

test("GHCR release builds once, accepts by digest, attests, then promotes", () => {
  assert.match(workflow, /tags:\n\s+- "mcp-v\*"/);
  assert.match(workflow, /packages: write/);
  assert.match(workflow, /id-token: write/);
  assert.match(workflow, /attestations: write/);
  assert.match(workflow, /package_version=.*package\.json/);
  assert.match(workflow, /release-alias-gate\.mjs assert-absent/);
  assert.equal((workflow.match(/GHCR_ACTOR: \$\{\{ github\.actor \}\}/g) ?? []).length, 2);
  assert.equal((workflow.match(/GHCR_TOKEN: \$\{\{ secrets\.GHCR_PAT \|\| github\.token \}\}/g) ?? []).length, 2);
  assert.match(workflow, /group: varity-mcp-container-release/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /docker\/build-push-action@v6/);
  assert.match(workflow, /push: true/);
  assert.match(workflow, /provenance: mode=max/);
  assert.match(workflow, /sbom: true/);
  assert.match(workflow, /candidate-\$\{\{ github\.sha \}\}/);
  assert.match(workflow, /IMAGE_NAME\}@\$\{CANDIDATE_DIGEST\}/);
  assert.match(workflow, /docker pull "\$image"/);
  assert.match(workflow, /docker run --detach --name/);
  assert.match(workflow, /hosted-release-function-gate\.mjs/);
  assert.match(workflow, /echo "::add-mask::\$\{release_token\}"/);
  assert.match(workflow, /VARITY_MCP_ACCESS_TOKEN="\$release_token"/);
  assert.match(workflow, /VARITY_MCP_RECEIPT_PATH="\$evidence\/gate\.receipt\.json"/);
  assert.match(workflow, /validate-release-evidence\.mjs/);
  assert.match(workflow, /RELEASE_EVIDENCE_BEARER="\$release_token"/);
  assert.match(workflow, /ACCEPTANCE PASS digest=%s version=%s/);
  assert.match(workflow, /actions\/attest-build-provenance@v3/);
  assert.match(workflow, /subject-digest: \$\{\{ steps\.candidate\.outputs\.digest \}\}/);
  assert.match(workflow, /docker buildx imagetools create/);
  assert.match(workflow, /versioned_tag/);
  assert.match(workflow, /for tag in "\$VERSIONED_TAG" "\$VERSION" latest/);
  assert.match(workflow, /promoted.*!=.*CANDIDATE_DIGEST/);
  assert(
    workflow.indexOf("Build and push candidate image once") <
      workflow.indexOf("Accept exact candidate digest"),
  );
  assert(
    workflow.indexOf("Accept exact candidate digest") <
      workflow.indexOf("Attest accepted image digest"),
  );
  assert(
    workflow.indexOf("Attest accepted image digest") <
      workflow.indexOf("Revalidate immutable aliases immediately before promotion"),
  );
  assert(
    workflow.indexOf("Revalidate immutable aliases immediately before promotion") <
      workflow.indexOf("Promote exact accepted image digest"),
  );
  assert.equal((workflow.match(/release-alias-gate\.mjs assert-absent/g) ?? []).length, 2);
  assert.equal((workflow.match(/docker\/build-push-action@v6/g) ?? []).length, 1);
  assert.doesNotMatch(workflow, /provenance: false/);
  assert.doesNotMatch(workflow, /Upload acceptance evidence\n\s+if: always\(\)/);
  assert.doesNotMatch(workflow, /--env [^\n]*release_token|docker logs .*\|/);
  assert.doesNotMatch(aliasGate, /console\.(?:log|error)\([^\n]*(?:GHCR_TOKEN|Authorization|registryToken|token\})/);
  assert.doesNotMatch(workflow, /workflow_dispatch|DOCKERHUB|npm publish/);
});
