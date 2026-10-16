// cowbell e2e driver — the full loop against a REAL herdr session:
// workspace -> pane -> command -> read -> teardown. Uses the compiled
// spec layer (the same builders the MCP tools call); no MCP client
// needed, so it runs anywhere node + herdr exist.
import { runHerdr } from "../../dist/herdr/exec.js";
import * as panes from "../../dist/herdr/spec-pane.js";
import * as workspaces from "../../dist/herdr/spec-workspace.js";

const out = await runHerdr(
  workspaces.workspaceCreate({
    cwd: "/tmp",
    label: "cowbell-e2e",
    focus: false,
  }),
);
const parsed = JSON.parse(out);
const result = parsed.result ?? parsed;
const pane = result.root_pane?.pane_id;
const ws = result.workspace?.workspace_id;
if (!pane || !ws) throw new Error("no root pane in: " + out.slice(0, 200));
console.log("PANE=" + pane, "WS=" + ws);

await runHerdr(panes.paneRun(pane, "echo COWBELL-E2E-OK"));
await new Promise((r) => setTimeout(r, 1500));
const read = await runHerdr(
  panes.paneRead(pane, { lines: 10, source: "recent" }),
);
if (!read.includes("COWBELL-E2E-OK"))
  throw new Error("marker not found in pane read:\n" + read);
console.log("MARKER=found");

await runHerdr(workspaces.workspaceClose(ws));
console.log("CLOSED=ok");
