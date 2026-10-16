import { describe, expect, it } from "vitest";
import * as sa from "../src/herdr/spec-agent.js";
import * as sp from "../src/herdr/spec-pane.js";
import * as sw from "../src/herdr/spec-workspace.js";

/**
 * EXACT argv pins. Every builder's output is locked, character for
 * character. If herdr's grammar changes and a builder is updated,
 * the diff here IS the review artifact.
 */
describe("workspace argv pins", () => {
  it("workspaces", () => {
    expect(sw.workspaceList().argv).toEqual(["herdr", "workspace", "list"]);
    expect(sw.workspaceGet("w36").argv).toEqual([
      "herdr",
      "workspace",
      "get",
      "w36",
    ]);
    expect(sw.workspaceCreate({ cwd: "/repo" }).argv).toEqual([
      "herdr",
      "workspace",
      "create",
      "--cwd",
      "/repo",
      "--focus",
    ]);
    expect(
      sw.workspaceCreate({ cwd: "/repo", label: "x", focus: false }).argv,
    ).toEqual([
      "herdr",
      "workspace",
      "create",
      "--cwd",
      "/repo",
      "--label",
      "x",
      "--no-focus",
    ]);
    expect(sw.workspaceClose("w36").argv).toEqual([
      "herdr",
      "workspace",
      "close",
      "w36",
    ]);
    expect(sw.workspaceFocus("w36").argv).toEqual([
      "herdr",
      "workspace",
      "focus",
      "w36",
    ]);
  });
});

describe("pane argv pins", () => {
  it("panes are positional (verified grammar)", () => {
    expect(sp.paneGet("w36:p1").argv).toEqual([
      "herdr",
      "pane",
      "get",
      "w36:p1",
    ]);
    expect(
      sp.paneRead("w36:p1", { lines: 30, source: "visible" }).argv,
    ).toEqual([
      "herdr",
      "pane",
      "read",
      "w36:p1",
      "--source",
      "visible",
      "--lines",
      "30",
    ]);
    expect(sp.paneSendText("w36:p1", "hello").argv).toEqual([
      "herdr",
      "pane",
      "send-text",
      "w36:p1",
      "hello",
    ]);
    expect(sp.paneSendKeys("w36:p1", ["enter"]).argv).toEqual([
      "herdr",
      "pane",
      "send-keys",
      "w36:p1",
      "enter",
    ]);
    expect(sp.paneRun("w36:p1", "opencode").argv).toEqual([
      "herdr",
      "pane",
      "run",
      "w36:p1",
      "opencode",
    ]);
  });
});

describe("agent argv pins (prompt/wait)", () => {
  it("agent prompt uses `prompt` with --until/--timeout (not send/--status)", () => {
    expect(sa.agentPrompt("w36:p1", "do it").argv).toEqual([
      "herdr",
      "agent",
      "prompt",
      "w36:p1",
      "do it",
    ]);
    expect(
      sa.agentPrompt("w36:p1", "do it", {
        wait: true,
        until: ["idle"],
        timeoutMs: 90_000,
      }).argv,
    ).toEqual([
      "herdr",
      "agent",
      "prompt",
      "w36:p1",
      "do it",
      "--wait",
      "--until",
      "idle",
      "--timeout",
      "90000",
    ]);
  });

  it("agent wait uses --until", () => {
    expect(sa.agentWait("w36:p1", ["done", "blocked"], 60_000).argv).toEqual([
      "herdr",
      "agent",
      "wait",
      "w36:p1",
      "--until",
      "done",
      "--until",
      "blocked",
      "--timeout",
      "60000",
    ]);
  });
});

describe("agent argv pins (start)", () => {
  it("agent start requires kind+pane (no cwd/workspace flags exist)", () => {
    expect(
      sa.agentStart("mesh", "opencode", "w36:p1", { timeoutMs: 180_000 }).argv,
    ).toEqual([
      "herdr",
      "agent",
      "start",
      "mesh",
      "--kind",
      "opencode",
      "--pane",
      "w36:p1",
      "--timeout",
      "180000",
    ]);
  });
});

describe("agent argv pins (start: opencode model selection)", () => {
  it("opencode model compiles to `-- mini -m <model>` (full TUI has no model flag)", () => {
    expect(
      sa.agentStart("mesh", "opencode", "w36:p1", {
        model: "zai/glm-5.3",
      }).argv,
    ).toEqual([
      "herdr",
      "agent",
      "start",
      "mesh",
      "--kind",
      "opencode",
      "--pane",
      "w36:p1",
      "--",
      "mini",
      "-m",
      "zai/glm-5.3",
    ]);
  });

  it("opencode model with timeoutMs keeps flag order and rides `#variant` along", () => {
    expect(
      sa.agentStart("mesh", "opencode", "w36:p1", {
        timeoutMs: 180_000,
        model: "zai/glm-5.3#high",
      }).argv,
    ).toEqual([
      "herdr",
      "agent",
      "start",
      "mesh",
      "--kind",
      "opencode",
      "--pane",
      "w36:p1",
      "--timeout",
      "180000",
      "--",
      "mini",
      "-m",
      "zai/glm-5.3#high",
    ]);
  });

  it("no model = no -m and no `--` passthrough", () => {
    const argv = sa.agentStart("mesh", "opencode", "w36:p1").argv;
    expect(argv).not.toContain("-m");
    expect(argv).not.toContain("--");
  });
});

describe("agent argv pins (start: model selection, non-opencode kinds)", () => {
  it("non-opencode kinds keep the common `-m <model>` compilation", () => {
    expect(
      sa.agentStart("mesh", "claude", "w36:p1", {
        model: "zai/glm-5.3",
      }).argv,
    ).toEqual([
      "herdr",
      "agent",
      "start",
      "mesh",
      "--kind",
      "claude",
      "--pane",
      "w36:p1",
      "--",
      "-m",
      "zai/glm-5.3",
    ]);
  });
});

describe("agent prompt flow (queue-of-one): deliver_when now", () => {
  it("default is a single prompt spec", () => {
    expect(sa.agentPromptFlow("w36:p1", "do it")).toEqual([
      {
        argv: ["herdr", "agent", "prompt", "w36:p1", "do it"],
        surface: "agent prompt",
      },
    ]);
  });

  it("now + wait/until/timeout keeps the single prompt shape", () => {
    expect(
      sa.agentPromptFlow("w36:p1", "do it", {
        deliverWhen: "now",
        wait: true,
        until: ["done"],
        timeoutMs: 5_000,
      }),
    ).toEqual([
      {
        argv: [
          "herdr",
          "agent",
          "prompt",
          "w36:p1",
          "do it",
          "--wait",
          "--until",
          "done",
          "--timeout",
          "5000",
        ],
        surface: "agent prompt",
      },
    ]);
  });
});

describe("agent prompt flow (queue-of-one): deliver_when idle", () => {
  it("wait(until idle) THEN prompt — two specs, in order", () => {
    expect(
      sa.agentPromptFlow("w36:p1", "do it", {
        deliverWhen: "idle",
        timeoutMs: 90_000,
      }),
    ).toEqual([
      {
        argv: [
          "herdr",
          "agent",
          "wait",
          "w36:p1",
          "--until",
          "idle",
          "--timeout",
          "90000",
        ],
        surface: "agent wait",
      },
      {
        argv: ["herdr", "agent", "prompt", "w36:p1", "do it"],
        surface: "agent prompt",
      },
    ]);
  });
});
