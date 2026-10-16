import { describe, expect, it } from "vitest";
import * as s from "../src/herdr/spec-tab.js";
import { withTransport } from "../src/herdr/transport-args.js";

/**
 * EXACT argv pins for the `herdr tab` builders — grammar re-verified
 * against herdr 0.9.5 `herdr tab <sub> --help`: list/create are
 * flag-driven, get/focus/rename/close are positional on wX:tN ids.
 * If herdr's grammar changes and a builder is updated, the diff here
 * IS the review artifact.
 */
describe("tab argv pins", () => {
  it("list: bare and with --workspace", () => {
    expect(s.tabList().argv).toEqual(["herdr", "tab", "list"]);
    expect(s.tabList({ workspace: "w36" }).argv).toEqual([
      "herdr",
      "tab",
      "list",
      "--workspace",
      "w36",
    ]);
  });

  it("create: every option optional, --workspace before --cwd", () => {
    expect(s.tabCreate().argv).toEqual(["herdr", "tab", "create"]);
    expect(s.tabCreate({ cwd: "/repo" }).argv).toEqual([
      "herdr",
      "tab",
      "create",
      "--cwd",
      "/repo",
    ]);
    expect(s.tabCreate({ workspace: "w36", cwd: "/repo" }).argv).toEqual([
      "herdr",
      "tab",
      "create",
      "--workspace",
      "w36",
      "--cwd",
      "/repo",
    ]);
  });

  it("get/focus/close are positional on the tab id", () => {
    expect(s.tabGet("w36:t1").argv).toEqual(["herdr", "tab", "get", "w36:t1"]);
    expect(s.tabFocus("w36:t1").argv).toEqual([
      "herdr",
      "tab",
      "focus",
      "w36:t1",
    ]);
    expect(s.tabClose("w36:t1").argv).toEqual([
      "herdr",
      "tab",
      "close",
      "w36:t1",
    ]);
  });
});

/**
 * `<LABEL>...` is variadic in herdr's grammar, but the label is
 * passed as ONE argv element — the paneRun precedent for variadic
 * positionals. runHerdr uses execFile without a shell, so the
 * element reaches herdr verbatim, and a single element is the
 * identity under every join rule the CLI might apply. Splitting on
 * whitespace would be the only way to corrupt a multi-word label.
 */
describe("tab rename: variadic label stays ONE argv element", () => {
  it("multi-word label is not split", () => {
    expect(s.tabRename("w36:t1", "main dev").argv).toEqual([
      "herdr",
      "tab",
      "rename",
      "w36:t1",
      "main dev",
    ]);
  });

  it("inner whitespace is preserved verbatim, never re-quoted", () => {
    const argv = s.tabRename("w36:t1", "two  spaces\tand\ttabs").argv;
    expect(argv).toHaveLength(5);
    expect(argv[4]).toBe("two  spaces\tand\ttabs");
  });
});

describe("tab validation", () => {
  it("tab ids must match the wX:tN grammar (not workspace or pane ids)", () => {
    expect(() => s.tabGet("w36")).toThrow(/tab id/);
    expect(() => s.tabGet("w36:p1")).toThrow(/tab id/);
    expect(() => s.tabFocus("")).toThrow(/tabFocus/);
    expect(() => s.tabClose("t1")).toThrow(/tabClose/);
    expect(() => s.tabGet("w3B:t12")).not.toThrow();
  });

  it("rename refuses empty labels", () => {
    expect(() => s.tabRename("w36:t1", "")).toThrow(/tabRename/);
  });

  it("create opts: absolute cwd, workspace grammar, strict keys", () => {
    expect(() => s.tabCreate({ cwd: "relative/path" })).toThrow(/absolute/);
    expect(() => s.tabCreate({ workspace: "36" })).toThrow(/workspace id/);
    expect(() =>
      s.tabCreate({
        label: "x",
      } as unknown as { workspace?: string; cwd?: string }),
    ).toThrow();
  });

  it("list opts: strict keys, workspace grammar", () => {
    expect(() => s.tabList({ workspace: "nope!" })).toThrow(/workspace id/);
    expect(() =>
      s.tabList({ cwd: "/x" } as unknown as { workspace?: string }),
    ).toThrow();
  });
});

describe("tab surface ids (drift-suite identifiers)", () => {
  it("each builder names its group subcommand", () => {
    expect(s.tabList().surface).toBe("tab list");
    expect(s.tabCreate().surface).toBe("tab create");
    expect(s.tabGet("w36:t1").surface).toBe("tab get");
    expect(s.tabFocus("w36:t1").surface).toBe("tab focus");
    expect(s.tabRename("w36:t1", "x").surface).toBe("tab rename");
    expect(s.tabClose("w36:t1").surface).toBe("tab close");
  });
});

/**
 * Tab commands run over the socket API, so the transport globals
 * apply: local is the identity default, machine/remote are explicit
 * opt-ins that prefix right after the binary name.
 */
describe("tab transport (socket-API commands take machine/remote)", () => {
  it("machine prefixes --machine after the binary name", () => {
    expect(
      withTransport(s.tabGet("w36:t1"), { kind: "machine", label: "gpu-box" })
        .argv,
    ).toEqual(["herdr", "--machine", "gpu-box", "tab", "get", "w36:t1"]);
  });

  it("remote prefixes --remote; local leaves the argv untouched", () => {
    expect(
      withTransport(s.tabList({ workspace: "w36" }), {
        kind: "remote",
        sshTarget: "root@10.0.0.4",
      }).argv,
    ).toEqual([
      "herdr",
      "--remote",
      "root@10.0.0.4",
      "tab",
      "list",
      "--workspace",
      "w36",
    ]);
    expect(withTransport(s.tabClose("w36:t1")).argv).toEqual([
      "herdr",
      "tab",
      "close",
      "w36:t1",
    ]);
  });

  it("surface identity survives transport (drift pins still match)", () => {
    const base = s.tabRename("w36:t1", "main dev");
    expect(withTransport(base, { kind: "machine", label: "x" }).surface).toBe(
      base.surface,
    );
  });
});
