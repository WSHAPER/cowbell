#!/usr/bin/env bash
set -euo pipefail

# cowbell — capture the herdr events-socket surface cowbell's wait
# registry subscribes through (the herdr events drift fixture).
#
# Extracts the events.subscribe request, the pane.agent_status_changed
# Subscription variant, the SubscriptionEventKind enum, and the
# PaneAgentStatusChangedEvent contract from the running herdr server's
# bundled API schema and writes tests/fixtures/herdr-events-surface.json.
# The drift test cross-checks the exact tokens src/herdr/socket.ts emits
# against this capture: when herdr renames the method, the subscription
# type, or drops a field we read, the suite fails naming the token.
#
# Byte-stable by construction (deterministic extraction, no timestamps).
# Requires: `herdr` on PATH with a running server.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"
OUT="$ROOT/tests/fixtures/herdr-events-surface.json"

node --input-type=module - "$OUT" <<'EOF'
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile } from "node:fs/promises";

const out = process.argv[2];
const execFileAsync = promisify(execFile);

const { stdout } = await execFileAsync("herdr", ["api", "schema", "--json"]);
const spec = JSON.parse(stdout);
const defs = spec.schemas?.request?.$defs;
if (!defs?.EventsSubscribeParams || !defs?.Subscription) {
  throw new Error(
    "herdr drift: request schema no longer carries EventsSubscribeParams/Subscription",
  );
}

const methods = spec.schemas.request.oneOf.map(
  (e) => e.properties?.method?.const,
);
if (!methods.includes("events.subscribe")) {
  throw new Error("herdr drift: events.subscribe method missing from the request schema");
}

const sub = defs.Subscription.oneOf?.find(
  (v) => v.properties?.type?.const === "pane.agent_status_changed",
);
if (!sub) {
  throw new Error(
    "herdr drift: pane.agent_status_changed Subscription variant missing",
  );
}

const subDefs = spec.schemas.subscription_event?.$defs;
if (!subDefs?.SubscriptionEventKind || !subDefs?.PaneAgentStatusChangedEvent) {
  throw new Error(
    "herdr drift: subscription_event schema no longer carries the status-event contract",
  );
}

const capture = {
  protocol: spec.protocol,
  subscribe_method: "events.subscribe",
  subscribe_params_required: defs.EventsSubscribeParams.required,
  agent_status_subscription: {
    type: "pane.agent_status_changed",
    required: sub.required,
    optional: Object.keys(sub.properties)
      .filter((p) => !sub.required.includes(p))
      .sort(),
  },
  event_kinds: subDefs.SubscriptionEventKind.enum,
  agent_status_event_required: subDefs.PaneAgentStatusChangedEvent.required,
  agent_statuses: subDefs.AgentStatus.enum,
};

await writeFile(out, `${JSON.stringify(capture, null, 2)}\n`, "utf8");
console.error(`✓ herdr events surface captured: ${out}`);
EOF
