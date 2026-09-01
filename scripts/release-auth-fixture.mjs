#!/usr/bin/env node

import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

const token = process.env.RELEASE_AUTH_FIXTURE_TOKEN;
const port = Number(process.env.RELEASE_AUTH_FIXTURE_PORT ?? "3199");

if (!token || !Number.isSafeInteger(port) || port < 1 || port > 65_535) {
  console.error("release-auth-fixture: invalid configuration");
  process.exit(1);
}

function bearerMatches(value) {
  if (typeof value !== "string") return false;
  const expected = Buffer.from("Bearer " + token);
  const observed = Buffer.from(value);
  return observed.length === expected.length && timingSafeEqual(observed, expected);
}

const server = createServer((request, response) => {
  response.setHeader("Cache-Control", "no-store");

  if (request.method === "GET" && request.url === "/health") {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ status: "ok" }));
    return;
  }

  if (
    request.method !== "POST" ||
    request.url !== "/api/auth/verify" ||
    !bearerMatches(request.headers.authorization)
  ) {
    response.writeHead(401, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "invalid_token" }));
    return;
  }

  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify({ user_id: "release-gate-principal", scopes: ["read"] }));
});

server.listen(port, "0.0.0.0", () => {
  console.error("release-auth-fixture: ready");
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.once(signal, () => server.close(() => process.exit(0)));
}
