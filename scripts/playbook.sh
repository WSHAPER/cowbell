#!/usr/bin/env bash
set -euo pipefail

# cowbell — ASCII end-to-end playbook.
# The canonical manual verification run. Mirrors scripts/e2e.sh step
# by step; use it when something smells and you want eyes on the
# herdr UI while the loop runs.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
npm run build >/dev/null

step() { printf '\n\033[1m== %s\033[0m\n' "$1"; }

step "1. workspace create (local — default transport)"
node --input-type=module -e '
import { runHerdr } from "'"$ROOT"'/dist/herdr/exec.js";
import * as panes from "'"$ROOT"'/dist/herdr/spec-pane.js";
import * as workspaces from "'"$ROOT"'/dist/herdr/spec-workspace.js";
import { writeFileSync } from "node:fs";
const out = await runHerdr(workspaces.workspaceCreate({ cwd: "/tmp", label: "cowbell-play", focus: false }));
const r = JSON.parse(out).result ?? JSON.parse(out);
console.log("  workspace:", r.workspace.workspace_id, "pane:", r.root_pane.pane_id);
writeFileSync("/tmp/cowbell-play.env", `PANE=${r.root_pane.pane_id}\nWS=${r.workspace.workspace_id}\n`);
'
set -a; . /tmp/cowbell-play.env; set +a
echo "  -> PANE=$PANE WS=$WS"

step "2. pane run: boot a marker command"
node --input-type=module -e '
import { runHerdr } from "'"$ROOT"'/dist/herdr/exec.js";
import * as panes from "'"$ROOT"'/dist/herdr/spec-pane.js";
await runHerdr(panes.paneRun(process.env.PANE, "echo COWBELL-PLAY-OK"));
console.log("  -> command sent");
'
step "3. pane read: verify the marker landed"
sleep 1
PANE="$PANE" node --input-type=module -e '
import { runHerdr } from "'"$ROOT"'/dist/herdr/exec.js";
import * as panes from "'"$ROOT"'/dist/herdr/spec-pane.js";
const read = await runHerdr(panes.paneRead(process.env.PANE, { lines: 10, source: "recent" }));
if (!read.includes("COWBELL-PLAY-OK")) { console.error(read); process.exit(1); }
console.log("  -> COWBELL-PLAY-OK found");
'

step "4. transport pin (no flags = local; machine/remote prefix correctly)"
node --input-type=module -e '
import { agentPrompt } from "'"$ROOT"'/dist/herdr/spec-agent.js";
import { withTransport } from "'"$ROOT"'/dist/herdr/transport-args.js";
const argv = withTransport(agentPrompt("p", "m"), { kind: "machine", label: "x" }).argv;
console.log("  ->", argv.join(" "));
'

step "5. teardown: workspace close"
WS="$WS" node --input-type=module -e '
import { runHerdr } from "'"$ROOT"'/dist/herdr/exec.js";
import * as workspaces from "'"$ROOT"'/dist/herdr/spec-workspace.js";
await runHerdr(workspaces.workspaceClose(process.env.WS));
console.log("  -> closed");
'

step "PLAYBOOK GREEN"
