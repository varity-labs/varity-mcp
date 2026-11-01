#!/usr/bin/env node
"use strict";

const { execFileSync } = require("node:child_process");

const PACKAGE_NAME = "@varity-labs/mcp";
const REGISTRY_OPTION = "--registry=https://registry.npmjs.org";

/** npm alone consumes the existing Actions credential; raw output stays private. */
function npmJson(args, stage) {
  let output;
  try {
    output = execFileSync("npm", [...args, "--json", REGISTRY_OPTION], {
      encoding: "utf8", timeout: 20_000, maxBuffer: 64 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    throw new Error(`npm ${stage} check failed; refusing publication.`);
  }
  try {
    return JSON.parse(output);
  } catch {
    throw new Error(`npm ${stage} response is malformed; refusing publication.`);
  }
}

function checkPublisherAccess() {
  const principal = npmJson(["whoami"], "identity");
  if (typeof principal !== "string" || !/^[a-z0-9][a-z0-9._-]*$/i.test(principal)) {
    throw new Error("npm identity response is malformed; refusing publication.");
  }

  // npm's JSON output can contain every collaborator despite the user operand.
  // Read only the authenticated principal's grant; never print the listing.
  const collaborators = npmJson(["access", "list", "collaborators", PACKAGE_NAME, principal], "package-access");
  if (!collaborators || typeof collaborators !== "object" || Array.isArray(collaborators)) {
    throw new Error("npm package-access response is malformed; refusing publication.");
  }
  if (!Object.hasOwn(collaborators, principal) || collaborators[principal] !== "read-write") {
    throw new Error(`npm package-access did not verify this identity's read-write grant for ${PACKAGE_NAME}; refusing publication.`);
  }
}

if (require.main === module) {
  try {
    checkPublisherAccess();
    console.log(`Verified npm identity and its package write grant for ${PACKAGE_NAME}; token publish scope, 2FA and publication remain unverified.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
