import { describe, expect, it } from "vitest";
import { paneRun } from "../src/herdr/spec-pane.js";
import { withTransport } from "../src/herdr/transport-args.js";

/**
 * Transport pins: local is the DEFAULT (identity); remote forms are
 * explicit opt-ins that prefix the CLI globals after the binary name.
 * The builder under transport is irrelevant to the prefixing — paneRun
 * keeps the argv short so the prefixes are the visible delta.
 */
describe("transport", () => {
  const base = paneRun("w36:p1", "do it");

  it("no transport = local, argv untouched", () => {
    expect(withTransport(base)).toEqual(base);
    expect(withTransport(base, undefined)).toEqual(base);
  });

  it("machine transport prefixes --machine <label>", () => {
    expect(
      withTransport(base, { kind: "machine", label: "gpu-box" }).argv,
    ).toEqual([
      "herdr",
      "--machine",
      "gpu-box",
      "pane",
      "run",
      "w36:p1",
      "do it",
    ]);
  });

  it("remote transport prefixes --remote <ssh-target>", () => {
    expect(
      withTransport(base, { kind: "remote", sshTarget: "root@10.0.0.4" }).argv,
    ).toEqual([
      "herdr",
      "--remote",
      "root@10.0.0.4",
      "pane",
      "run",
      "w36:p1",
      "do it",
    ]);
  });

  it("surface identity survives transport (drift pins still match)", () => {
    expect(withTransport(base, { kind: "machine", label: "x" }).surface).toBe(
      base.surface,
    );
  });
});
