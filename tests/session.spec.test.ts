import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as s from "../src/herdr/spec-session.js";

/**
 * Session lane pins. Grammar verified against the local herdr 0.9.5
 * binary via `herdr session <sub> --help`:
 *
 *   session list  [OPTIONS]          (--json)
 *   session stop  [OPTIONS] <NAME>   (--json)
 *   session delete [OPTIONS] <NAME>  (--json)
 *
 * Two deliberate decisions pinned here:
 *   - NO --json: no existing spec builder passes it — the tools
 *     surface the CLI's default output as text.
 *   - TRANSPORT APPLIES (withT): session subcommands are API
 *     commands (`herdr --machine <label> <command>` is a documented
 *     usage form) and named sessions live on remote servers too
 *     (`herdr --remote <target> [--session <name>]`).
 */

describe("session argv pins", () => {
  it("sessionList", () => {
    expect(s.sessionList().argv).toEqual(["herdr", "session", "list"]);
  });

  it("sessionStop takes positional NAME", () => {
    expect(s.sessionStop("nightly").argv).toEqual([
      "herdr",
      "session",
      "stop",
      "nightly",
    ]);
  });

  it("sessionDelete takes positional NAME", () => {
    expect(s.sessionDelete("nightly").argv).toEqual([
      "herdr",
      "session",
      "delete",
      "nightly",
    ]);
  });

  it("no builder emits --json (established spec convention: default output)", () => {
    for (const argv of [
      s.sessionList().argv,
      s.sessionStop("n").argv,
      s.sessionDelete("n").argv,
    ]) {
      expect(argv.filter((t) => t.startsWith("--"))).toEqual([]);
    }
  });
});

describe("session input validation", () => {
  it("sessionStop rejects empty names", () => {
    expect(() => s.sessionStop("")).toThrow(/^sessionStop:/);
  });

  it("sessionDelete rejects empty names", () => {
    expect(() => s.sessionDelete("")).toThrow(/^sessionDelete:/);
  });
});

describe("session transport decision (server registration)", () => {
  const src = readFileSync(
    new URL("../src/mcp/tools/session.ts", import.meta.url),
    "utf8",
  );
  const serverSrc = readFileSync(
    new URL("../src/mcp/server.ts", import.meta.url),
    "utf8",
  );
  // session_delete is the last registration in session.ts — an omitted
  // end anchor slices to end of module.
  const block = (from: string, to?: string) =>
    src.slice(
      src.indexOf(from),
      to === undefined ? undefined : src.indexOf(to),
    );

  it("registered via registerSessionTools(server)", () => {
    expect(serverSrc).toContain("registerSessionTools(server)");
  });

  it("session_list is registered withT — machine/remote apply", () => {
    const b = block('"session_list"', '"session_stop"');
    expect(b).toContain("withT");
    expect(b).toContain("sessions.sessionList()");
  });

  it("session_stop is registered withT and forwards name", () => {
    const b = block('"session_stop"', '"session_delete"');
    expect(b).toContain("withT");
    expect(b).toContain("sessions.sessionStop(v.name)");
  });

  it("session_delete is registered withT and forwards name", () => {
    const b = block('"session_delete"');
    expect(b).toContain("withT");
    expect(b).toContain("sessions.sessionDelete(v.name)");
  });

  it("session attach is NOT wrapped (interactive, no MCP semantics)", () => {
    expect(src).not.toContain('"session_attach"');
    expect(src).not.toContain('"sessionAttach"');
    expect(serverSrc).not.toContain('"session_attach"');
    expect(serverSrc).not.toContain('"sessionAttach"');
  });
});
