import { describe, expect, it } from "vitest";
import { agentStart } from "../src/herdr/spec-agent.js";
import * as s from "../src/herdr/spec-worktree.js";

describe("worktreeCreate argv pins", () => {
  it("minimal (cwd + branch + default focus)", () => {
    expect(s.worktreeCreate({ cwd: "/repo", branch: "feat/x" }).argv).toEqual([
      "herdr",
      "worktree",
      "create",
      "--cwd",
      "/repo",
      "--branch",
      "feat/x",
      "--focus",
    ]);
  });

  it("full opts with --no-focus (orchestrate dispatch shape)", () => {
    expect(
      s.worktreeCreate({
        cwd: "/repo",
        branch: "feat/x",
        base: "main",
        label: "worker-1",
        focus: false,
      }).argv,
    ).toEqual([
      "herdr",
      "worktree",
      "create",
      "--cwd",
      "/repo",
      "--branch",
      "feat/x",
      "--base",
      "main",
      "--label",
      "worker-1",
      "--no-focus",
    ]);
  });

  it("workspace targeting instead of cwd", () => {
    expect(
      s.worktreeCreate({ workspace: "w1", branch: "b", focus: false }).argv,
    ).toEqual([
      "herdr",
      "worktree",
      "create",
      "--workspace",
      "w1",
      "--branch",
      "b",
      "--no-focus",
    ]);
  });
});

describe("worktreeRemove argv pins", () => {
  it("workspace id, force opt-in", () => {
    expect(s.worktreeRemove("w36").argv).toEqual([
      "herdr",
      "worktree",
      "remove",
      "--workspace",
      "w36",
    ]);
    expect(s.worktreeRemove("w36", true).argv).toEqual([
      "herdr",
      "worktree",
      "remove",
      "--workspace",
      "w36",
      "--force",
    ]);
  });
});

describe("agentStart args", () => {
  it("no args = unchanged base shape", () => {
    expect(agentStart("mesh", "opencode", "w1:p1").argv).toEqual([
      "herdr",
      "agent",
      "start",
      "mesh",
      "--kind",
      "opencode",
      "--pane",
      "w1:p1",
    ]);
  });

  it("args append after --", () => {
    expect(
      agentStart("mesh", "opencode", "w1:p1", { args: ["-m", "zai/glm-5.3"] })
        .argv,
    ).toEqual([
      "herdr",
      "agent",
      "start",
      "mesh",
      "--kind",
      "opencode",
      "--pane",
      "w1:p1",
      "--",
      "-m",
      "zai/glm-5.3",
    ]);
  });

  it("timeout + args compose", () => {
    expect(
      agentStart("mesh", "opencode", "w1:p1", {
        timeoutMs: 180_000,
        args: ["-m", "m2"],
      }).argv,
    ).toEqual([
      "herdr",
      "agent",
      "start",
      "mesh",
      "--kind",
      "opencode",
      "--pane",
      "w1:p1",
      "--timeout",
      "180000",
      "--",
      "-m",
      "m2",
    ]);
  });
});

describe("worktree + agentStart validation", () => {
  it("worktreeCreate requires workspace or cwd", () => {
    expect(() => s.worktreeCreate({ branch: "b" })).toThrow(/workspace or cwd/);
  });

  it("worktreeCreate rejects whitespace branches", () => {
    expect(() => s.worktreeCreate({ cwd: "/x", branch: "has space" })).toThrow(
      /whitespace/,
    );
  });

  it("agentStart rejects control chars in args", () => {
    expect(() =>
      agentStart("n", "opencode", "w1:p1", { args: ["a\x00b"] }),
    ).toThrow(/control/);
  });

  it("agentStart rejects empty args array", () => {
    expect(() => agentStart("n", "opencode", "w1:p1", { args: [] })).toThrow();
  });
});
