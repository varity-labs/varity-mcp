#!/usr/bin/env node

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const REGISTRY_ORIGIN = "https://ghcr.io";
const TOKEN_URL = "https://ghcr.io/token";
const MANIFEST_ACCEPT = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

function parseReference(value) {
  const match = /^ghcr\.io\/([a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+):([A-Za-z0-9_][A-Za-z0-9_.-]{0,127})$/.exec(value);
  if (!match) throw new Error("immutable alias reference is malformed");
  return { repository: match[1], alias: match[2] };
}

function manifestUrl(repository, alias) {
  const path = repository.split("/").map(encodeURIComponent).join("/");
  return `${REGISTRY_ORIGIN}/v2/${path}/manifests/${encodeURIComponent(alias)}`;
}

async function readBoundedBody(response) {
  const contentLength = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
    throw new Error("registry response exceeded the size limit");
  }
  const body = await response.text();
  if (Buffer.byteLength(body) > MAX_RESPONSE_BYTES) {
    throw new Error("registry response exceeded the size limit");
  }
  return body;
}

export async function registryRequest({ url, headers }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "GET",
      headers,
      redirect: "error",
      signal: controller.signal,
    });
    return { status: response.status, body: await readBoundedBody(response) };
  } finally {
    clearTimeout(timeout);
  }
}

function classifyManifestResponse(result) {
  if (!result || result.error || !Number.isInteger(result.status)) return "indeterminate";
  if (result.status === 200) return "present";
  if (result.status !== 404 || typeof result.body !== "string") return "indeterminate";

  try {
    const value = JSON.parse(result.body);
    return Array.isArray(value?.errors)
      && value.errors.some((entry) => entry?.code === "MANIFEST_UNKNOWN")
      ? "absent"
      : "indeterminate";
  } catch {
    return "indeterminate";
  }
}

async function requestResult(request, input) {
  try {
    return await request(input);
  } catch {
    return { status: null, body: "", error: true };
  }
}

export async function inspectAlias(reference, {
  actor = process.env.GHCR_ACTOR,
  token = process.env.GHCR_TOKEN,
  request = registryRequest,
} = {}) {
  const { repository, alias } = parseReference(reference);
  if (typeof actor !== "string" || actor.length === 0 || typeof token !== "string" || token.length === 0) {
    return "indeterminate";
  }

  const authUrl = new URL(TOKEN_URL);
  authUrl.searchParams.set("service", "ghcr.io");
  authUrl.searchParams.set("scope", `repository:${repository}:pull`);
  const auth = await requestResult(request, {
    url: authUrl.toString(),
    headers: { Authorization: `Basic ${Buffer.from(`${actor}:${token}`).toString("base64")}` },
  });
  if (auth.status !== 200 || typeof auth.body !== "string") return "indeterminate";

  let registryToken;
  try {
    const value = JSON.parse(auth.body);
    registryToken = typeof value?.token === "string" && value.token.length > 0 ? value.token : undefined;
  } catch {
    return "indeterminate";
  }
  if (!registryToken) return "indeterminate";

  const manifest = await requestResult(request, {
    url: manifestUrl(repository, alias),
    headers: {
      Accept: MANIFEST_ACCEPT,
      Authorization: `Bearer ${registryToken}`,
    },
  });
  return classifyManifestResponse(manifest);
}

export async function assertAliasesAbsent(references, options = {}) {
  if (!Array.isArray(references) || references.length === 0) {
    throw new Error("at least one immutable alias is required");
  }

  for (const reference of references) {
    const classification = await inspectAlias(reference, options);
    if (classification === "present") {
      throw new Error(`immutable release alias already exists: ${reference}`);
    }
    if (classification !== "absent") {
      throw new Error(`immutable release alias absence could not be confirmed: ${reference}`);
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [operation, ...references] = process.argv.slice(2);
  if (operation !== "assert-absent") {
    console.error("release-alias-gate: expected assert-absent <reference> [...]");
    process.exit(2);
  }
  try {
    await assertAliasesAbsent(references);
    console.log(`release-alias-gate: confirmed ${references.length} immutable alias(es) absent`);
  } catch (error) {
    console.error(`release-alias-gate: ${error instanceof Error ? error.message : "unexpected failure"}`);
    process.exit(1);
  }
}
