import { describe, expect, it } from "vitest";
import * as sa from "../src/herdr/spec-agent.js";
import * as sp from "../src/herdr/spec-pane.js";
import * as sw from "../src/herdr/spec-workspace.js";
import { withTransport } from "../src/herdr/transport-args.js";

/**
 * zod validation at the spec layer: every builder rejects malformed
 * inputs with the builder + parameter named — regardless of caller
 * (MCP tools, future CLI, scripts).
 */
describe("spec input validation", () => {
  const rejects = (fn: () => unknown, needle: string | RegExp) => {
    expect(fn).toThrow(needle);
  };

  it("pane ids must match the wX:pN grammar", () => {
    rejects(() => sp.paneGet("p1"), "paneGet");
    rejects(() => sp.paneGet(""), "paneGet");
    expect(() => sp.paneGet("w3B:p12")).not.toThrow();
  });

  it("workspace ids must match the wX grammar", () => {
    rejects(() => sw.workspaceClose("36"), "workspaceClose");
    rejects(() => sw.workspaceFocus(""), "workspaceFocus");
    expect(() => sw.workspaceFocus("w3B")).not.toThrow();
  });

  it("workspaceCreate requires an absolute cwd", () => {
    rejects(() => sw.workspaceCreate({ cwd: "relative/path" }), "absolute");
    expect(() => sw.workspaceCreate({ cwd: "/tmp" })).not.toThrow();
  });

  it("empty text/commands are refused", () => {
    rejects(() => sp.paneSendText("w1:p1", ""), "paneSendText");
    rejects(() => sp.paneRun("w1:p1", ""), "paneRun");
    rejects(() => sa.agentPrompt("w1:p1", ""), "agentPrompt");
    rejects(() => sp.paneSendKeys("w1:p1", []), "paneSendKeys");
  });

  it("read opts: lines 1..2000, valid source", () => {
    rejects(() => sp.paneRead("w1:p1", { lines: 0 }), "lines");
    rejects(() => sp.paneRead("w1:p1", { lines: 5000 }), "lines");
    expect(() =>
      sp.paneRead("w1:p1", { lines: 30, source: "visible" }),
    ).not.toThrow();
  });
});

describe("agent flow validation (wait + prompt)", () => {
  const rejects = (fn: () => unknown, needle: string | RegExp) => {
    expect(fn).toThrow(needle);
  };

  it("agent wait: statuses vocabulary + positive timeout", () => {
    rejects(
      () => sa.agentWait("w1:p1", ["bogus"] as unknown as sa.AgentStatus[]),
      "agentWait",
    );
    rejects(() => sa.agentWait("w1:p1", ["idle"], -1), "agentWait");
    expect(() => sa.agentWait("w1:p1", ["idle", "done"], 1000)).not.toThrow();
  });

  it("prompt flow: deliver_when vocabulary + queue-of-one exclusivity", () => {
    rejects(
      () =>
        sa.agentPromptFlow("w1:p1", "m", {
          deliverWhen: "eventually" as unknown as "idle",
        }),
      "agentPromptFlow",
    );
    rejects(
      () =>
        sa.agentPromptFlow("w1:p1", "m", { deliverWhen: "idle", wait: true }),
      /idle.*wait/i,
    );
    rejects(
      () =>
        sa.agentPromptFlow("w1:p1", "m", {
          deliverWhen: "idle",
          until: ["done"],
        }),
      /idle.*wait/i,
    );
    expect(() =>
      sa.agentPromptFlow("w1:p1", "m", { deliverWhen: "idle" }),
    ).not.toThrow();
    expect(() =>
      sa.agentPromptFlow("w1:p1", "m", {
        deliverWhen: "idle",
        timeoutMs: 1000,
      }),
    ).not.toThrow();
  });
});

describe("agent start model validation (typed selection)", () => {
  const rejects = (fn: () => unknown, needle: string | RegExp) => {
    expect(fn).toThrow(needle);
  };

  it("model is non-empty and exclusive with args", () => {
    rejects(
      () => sa.agentStart("n", "opencode", "w1:p1", { model: "" }),
      "agentStart",
    );
    rejects(
      () =>
        sa.agentStart("n", "opencode", "w1:p1", {
          model: "zai/glm-5.3",
          args: ["-m", "zai/glm-5.3"],
        }),
      /model.*args|args.*model/i,
    );
    expect(() =>
      sa.agentStart("n", "opencode", "w1:p1", { model: "zai/glm-5.3" }),
    ).not.toThrow();
    expect(() =>
      sa.agentStart("n", "opencode", "w1:p1", { args: ["-m", "x"] }),
    ).not.toThrow();
  });
});

describe("agent surface validation (start + transport + error shape)", () => {
  const rejects = (fn: () => unknown, needle: string | RegExp) => {
    expect(fn).toThrow(needle);
  };

  it("agent start: kind vocabulary + pane grammar", () => {
    rejects(
      () => sa.agentStart("n", "bogus" as sa.AgentKind, "w1:p1"),
      "agentStart",
    );
    rejects(() => sa.agentStart("n", "opencode", "nope"), "agentStart");
    expect(() => sa.agentStart("n", "opencode", "w1:p1")).not.toThrow();
  });

  it("transport: discriminated, non-empty", () => {
    expect(() =>
      withTransport(sa.agentPrompt("w1:p1", "m"), {
        kind: "machine",
        label: "",
      }),
    ).toThrow(/withTransport|label/);
    expect(() =>
      withTransport(sa.agentPrompt("w1:p1", "m"), {
        kind: "remote",
        sshTarget: "h",
      }),
    ).not.toThrow();
  });

  it("error messages name the builder and echo the input", () => {
    try {
      sp.paneGet("garbage");
      expect.unreachable("must throw");
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain("paneGet");
      expect(msg).toContain("garbage");
    }
  });
});
