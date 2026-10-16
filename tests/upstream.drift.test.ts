import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import * as sa from "../src/herdr/spec-agent.js";
import type { Spec } from "../src/herdr/spec.js";
import * as sp from "../src/herdr/spec-pane.js";
import { SUPPORTED_HERDR_VERSION } from "../src/herdr/spec.js";
import * as sw from "../src/herdr/spec-workspace.js";
import * as st from "../src/herdr/spec-worktree.js";
import * as sm from "../src/herdr/spec-machine.js";
import * as tb from "../src/herdr/spec-tab.js";
import * as ss from "../src/herdr/spec-session.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const fixture = path.join(root, "tests", "fixtures", "herdr-surface.txt");

function loadSurface(): string {
  if (!existsSync(fixture)) {
    throw new Error(
      "tests/fixtures/herdr-surface.txt missing — run: npm run reference:surface",
    );
  }
  return readFileSync(fixture, "utf8");
}

const surface = loadSurface();

const cases: Array<[name: string, spec: Spec]> = [
  ["workspace list", sw.workspaceList()],
  ["workspace get", sw.workspaceGet("w1")],
  ["workspace create", sw.workspaceCreate({ cwd: "/x" })],
  ["workspace close", sw.workspaceClose("w1")],
  ["workspace focus", sw.workspaceFocus("w1")],
  ["pane get", sp.paneGet("w1:p1")],
  ["pane read", sp.paneRead("w1:p1")],
  ["pane send-text", sp.paneSendText("w1:p1", "t")],
  ["pane send-keys", sp.paneSendKeys("w1:p1", ["enter"])],
  ["pane run", sp.paneRun("w1:p1", "c")],
  ["agent list", sa.agentList()],
  ["agent get", sa.agentGet("w1:p1")],
  ["agent read", sa.agentRead("w1:p1")],
  ["agent prompt", sa.agentPrompt("w1:p1", "m")],
  ["agent wait", sa.agentWait("w1:p1", ["idle"])],
  ["agent start", sa.agentStart("n", "opencode", "w1:p1")],
  ["agent focus", sa.agentFocus("w1:p1")],
  ["agent rename", sa.agentRename("w1:p1", "n")],
  ["worktree create", st.worktreeCreate({ cwd: "/x", branch: "b" })],
  ["worktree remove", st.worktreeRemove("w1")],
  ["tab list", tb.tabList({ workspace: "w1" })],
  ["tab create", tb.tabCreate({ workspace: "w1", cwd: "/x" })],
  ["tab get", tb.tabGet("w36:t1")],
  ["tab focus", tb.tabFocus("w36:t1")],
  ["tab rename", tb.tabRename("w36:t1", "main dev")],
  ["tab close", tb.tabClose("w36:t1")],
  ["session list", ss.sessionList()],
  ["session stop", ss.sessionStop("s1")],
  ["session delete", ss.sessionDelete("s1")],
  ["machine list", sm.machineList()],
  ["machine status", sm.machineStatus()],
  ["machine rename", sm.machineRename("m1", "box")],
  ["machine remove", sm.machineRemove("m1")],
  ["machine enable", sm.machineEnable("m1")],
  ["machine disable", sm.machineDisable("m1")],
];

/**
 * THE DRIFT TRIPWIRE.
 *
 * tests/fixtures/herdr-surface.txt is the captured `--help` tree of the
 * herdr build we target (regenerate: npm run reference:surface). This
 * test cross-checks every subcommand and long flag our specs emit
 * against that capture. When herdr renames or removes anything:
 *
 *   1. this fails naming the exact token, and
 *   2. you run `npm run reference:surface` (after `reference:update`)
 *      and review which builders in src/herdr/spec-*.ts must follow.
 */
describe("upstream surface drift", () => {
  it("fixture records the pinned version", () => {
    const line = surface.split("\n").find((l) => l.startsWith("herdr "));
    expect(line, "fixture must start with `herdr <version>`").toBeDefined();
    expect(line).toBe(`herdr ${SUPPORTED_HERDR_VERSION}`);
  });

  for (const [name] of cases) {
    it(`surface contains: ${name}`, () => {
      const usage = extractUsage(surface, name);
      expect(
        usage,
        `no --help block for \`${name}\` in the surface fixture`,
      ).toBeDefined();
    });
  }

  for (const [name, sp] of cases) {
    it(`flags exist upstream: ${name}`, () => {
      const usage = extractUsage(surface, name) ?? "";
      for (const token of sp.argv) {
        if (!token.startsWith("--")) continue;
        expect(
          usage,
          `\`${name}\` emits \`${token}\` but the captured herdr --help for it does not list it — UPSTREAM DRIFT. Regenerate the fixture (npm run reference:surface) and update the src/herdr/spec-*.ts builders.`,
        ).toContain(token);
      }
    });
  }

  it("agent status vocabulary matches upstream", () => {
    const usage = extractUsage(surface, "agent wait") ?? "";
    for (const status of sa.AGENT_STATUSES) {
      expect(
        usage,
        `status \`${status}\` missing from agent wait --help`,
      ).toContain(status);
    }
  });
});

function extractUsage(surface: string, name: string): string | undefined {
  const lines = surface.split("\n");
  const start = lines.findIndex((l) => l === `## ${name}`);
  if (start === -1) return undefined;
  const end = lines.findIndex((l, i) => i > start && l.startsWith("## "));
  return lines.slice(start, end === -1 ? undefined : end).join("\n");
}
