#!/usr/bin/env bash
set -euo pipefail

# cowbell — capture the opencode api session.prompt surface (the
# reminder drift fixture).
#
# Extracts the session.prompt operation — the repo's first POST — from
# the running opencode background service's /openapi.json and writes
# tests/fixtures/opencode-session-prompt.json. The reminder drift test
# cross-checks the sessionPrompt spec builder against this capture:
# when opencode renames the operation, drops the sessionID path
# parameter, or reshapes the --data request body keys we pin, the
# suite fails with the exact token named.
#
# Requires: `opencode` on PATH with a running background service.
#
# Wired like scripts/dump-opencode-models.sh (npm run
# reference:opencode-reminder).

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"
OUT="$ROOT/tests/fixtures/opencode-session-prompt.json"

node --input-type=module - "$OUT" <<'EOF'
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile } from "node:fs/promises";

const out = process.argv[2];
const execFileAsync = promisify(execFile);

const { stdout } = await execFileAsync("opencode", [
  "api",
  "GET",
  "/openapi.json",
]);
const spec = JSON.parse(stdout);

const path = "/api/session/{sessionID}/prompt";
const post = spec.paths?.[path]?.post;
if (!post || post.operationId !== "session.prompt") {
  throw new Error(
    `opencode drift: POST ${path} (session.prompt) missing from /openapi.json`,
  );
}

// The prompt rides as the --data JSON body; pin the body's key facts
// so property renames or requiredness flips fail the suite.
const body = post.requestBody?.content?.["application/json"]?.schema;
if (!body || !body.properties) {
  throw new Error(
    `opencode drift: POST ${path} (session.prompt) lost its application/json request body`,
  );
}

// delivery is a nullable $ref union today (Session.Inbox.Delivery);
// follow one $ref level so an inlined or hoisted enum still captures.
const delivery = body.properties.delivery;
const deliveryCandidates = [delivery, ...(delivery?.anyOf ?? [])];
const withEnum = deliveryCandidates.find((c) => c?.enum);
const refd = deliveryCandidates.find((c) => c?.$ref);
const deliveryEnum =
  withEnum?.enum ??
  (refd ? spec.components.schemas[refd.$ref.split("/").at(-1)]?.enum : []) ??
  [];

const capture = {
  operationId: post.operationId,
  method: "post",
  path,
  parameters: post.parameters.map((p) => ({
    name: p.name,
    in: p.in,
    required: p.required ?? false,
  })),
  bodyRequired: post.requestBody?.required === true,
  // Request-body pins the drift suite checks our --data JSON against.
  bodySchemaPins: {
    bodyProperties: Object.keys(body.properties),
    requiredKeys: body.required ?? [],
    // Upstream pins no minLength today — the non-empty check is
    // sessionPrompt's own. null records "absent" honestly; a future
    // number here trips the drift test for a conscious re-check.
    textMinLength: body.properties.text?.minLength ?? null,
    deliveryEnum,
  },
};

await writeFile(out, `${JSON.stringify(capture, null, 2)}\n`, "utf8");
console.error(`✓ opencode session.prompt surface captured: ${out}`);
EOF
