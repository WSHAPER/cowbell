#!/usr/bin/env bash
set -euo pipefail

# cowbell — capture the opencode api surface cowbell shells out to
# (the opencode drift fixture).
#
# Extracts the session.message.list operation from the running opencode
# background service's /openapi.json and writes
# tests/fixtures/opencode-session-message.json. The drift test
# cross-checks our opencode spec builder against this capture: when
# opencode renames the operation or its parameters, the suite fails
# with the exact token named.
#
# Requires: `opencode` on PATH with a running background service.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"
OUT="$ROOT/tests/fixtures/opencode-session-message.json"

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
const path = "/api/session/{sessionID}/message";
const get = spec.paths?.[path]?.get;
if (!get || get.operationId !== "session.message.list") {
  throw new Error(
    `opencode drift: GET ${path} (session.message.list) missing from /openapi.json`,
  );
}

const capture = {
  operationId: get.operationId,
  method: "get",
  path,
  parameters: get.parameters.map((p) => ({
    name: p.name,
    in: p.in,
    required: p.required ?? false,
  })),
  partTypes: get.responses["200"]
    ? spec.components.schemas["Session.Message.Assistant"].properties.content.items.anyOf.map(
        (r) => r.$ref.split(".").at(-1),
      )
    : [],
  messageTypes: spec.components.schemas["Session.Message.Info"].anyOf
    .map((r) => spec.components.schemas[r.$ref.split("/").at(-1)])
    .filter((s) => s?.properties?.type?.enum)
    .flatMap((s) => s.properties.type.enum),
};

await writeFile(
  out,
  `${JSON.stringify(capture, null, 2)}\n`,
  "utf8",
);
console.error(`✓ opencode surface captured: ${out}`);
EOF
