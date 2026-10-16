#!/usr/bin/env bash
set -euo pipefail

# cowbell — capture the opencode api model-discovery surface (the
# models drift fixture).
#
# Extracts the model.list + model.default operations from the running
# opencode background service's /openapi.json and writes
# tests/fixtures/opencode-models.json. The models drift test
# cross-checks the opencode spec builders against this capture: when
# opencode renames an operation or drops a Model.Info key we pin, the
# suite fails with the exact token named.
#
# Requires: `opencode` on PATH with a running background service.
#
# Wired like scripts/dump-opencode-surface.sh (npm run
# reference:opencode-models).

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"
OUT="$ROOT/tests/fixtures/opencode-models.json"

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

const captureOperation = (path, expectedId) => {
  const get = spec.paths?.[path]?.get;
  if (!get || get.operationId !== expectedId) {
    throw new Error(
      `opencode drift: GET ${path} (${expectedId}) missing from /openapi.json`,
    );
  }
  return {
    operationId: get.operationId,
    method: "get",
    path,
    parameters: get.parameters.map((p) => ({
      name: p.name,
      in: p.in,
      required: p.required ?? false,
    })),
  };
};

const modelInfo = spec.components.schemas["Model.Info"];
if (!modelInfo) {
  throw new Error("opencode drift: Model.Info schema missing from /openapi.json");
}

// The default endpoint's data is Model.Info | null.
const defaultResponse =
  spec.paths["/api/model/default"].get.responses["200"].content[
    "application/json"
  ].schema;
const dataNullable =
  JSON.stringify(defaultResponse.properties.data.anyOf ?? []).includes('"null"') ||
  defaultResponse.properties.data.type === "null";

const capture = {
  list: captureOperation("/api/model", "model.list"),
  default: {
    ...captureOperation("/api/model/default", "model.default"),
    dataNullable,
  },
  // Required-by-upstream keys; our raw schema pins the subset it reads.
  modelInfoRequired: modelInfo.required,
  variantRequired: spec.components.schemas["Model.Variant"].required,
};

await writeFile(out, `${JSON.stringify(capture, null, 2)}\n`, "utf8");
console.error(`✓ opencode model surface captured: ${out}`);
EOF
