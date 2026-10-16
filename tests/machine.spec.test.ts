import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as s from "../src/herdr/spec-machine.js";

describe("machine argv pins", () => {
  it("list", () => {
    expect(s.machineList().argv).toEqual(["herdr", "machine", "list"]);
  });

  it("status without the positional checks all machines", () => {
    expect(s.machineStatus().argv).toEqual(["herdr", "machine", "status"]);
    expect(s.machineStatus(undefined).argv).toEqual([
      "herdr",
      "machine",
      "status",
    ]);
  });

  it("status with the optional label_or_id positional", () => {
    expect(s.machineStatus("box").argv).toEqual([
      "herdr",
      "machine",
      "status",
      "box",
    ]);
  });

  it("rename emits --label BEFORE the positional (usage order)", () => {
    expect(s.machineRename("m3", "worker-box").argv).toEqual([
      "herdr",
      "machine",
      "rename",
      "--label",
      "worker-box",
      "m3",
    ]);
  });

  it("remove/enable/disable take the profile id positional", () => {
    expect(s.machineRemove("m3").argv).toEqual([
      "herdr",
      "machine",
      "remove",
      "m3",
    ]);
    expect(s.machineEnable("m3").argv).toEqual([
      "herdr",
      "machine",
      "enable",
      "m3",
    ]);
    expect(s.machineDisable("m3").argv).toEqual([
      "herdr",
      "machine",
      "disable",
      "m3",
    ]);
  });
});

describe("machine surface pins", () => {
  it("surface ids match the fixture section names", () => {
    expect(s.machineList().surface).toBe("machine list");
    expect(s.machineStatus().surface).toBe("machine status");
    expect(s.machineRename("m3", "x").surface).toBe("machine rename");
    expect(s.machineRemove("m3").surface).toBe("machine remove");
    expect(s.machineEnable("m3").surface).toBe("machine enable");
    expect(s.machineDisable("m3").surface).toBe("machine disable");
  });
});

describe("machine validation", () => {
  it("empty profile id throws with the builder named", () => {
    expect(() => s.machineRemove("")).toThrow(/machineRemove/);
    expect(() => s.machineEnable("")).toThrow(/machineEnable/);
    expect(() => s.machineDisable("")).toThrow(/machineDisable/);
    expect(() => s.machineRename("", "x")).toThrow(/machineRename/);
  });

  it("empty rename label throws with the builder named", () => {
    expect(() => s.machineRename("m3", "")).toThrow(/machineRename/);
  });

  it("empty status positional throws with the builder named", () => {
    expect(() => s.machineStatus("")).toThrow(/machineStatus/);
  });
});

/**
 * TRANSPORT DECISION PIN. `herdr machine` manages the LOCAL
 * saved-SSH-machine registry — `--machine`/`--remote` route API
 * commands to a herdr server (herdr's help: "Run an API command on
 * a saved SSH machine"; every socket-API group is labeled "helpers
 * over the socket API", machine is not). So the registered machine
 * tools must NOT be wrapped in withT, exactly like models_list and
 * the wait tools (the other documented local-only exceptions).
 */
describe("machine MCP registration: local registry, NO transport params", () => {
  const src = readFileSync(
    new URL("../src/mcp/tools/machine.ts", import.meta.url),
    "utf8",
  );
  const serverSrc = readFileSync(
    new URL("../src/mcp/server.ts", import.meta.url),
    "utf8",
  );

  /**
   * The machine registrars' own text — from registerMachineTools to
   * the end of the module (covers the internal admin sub-registrar).
   */
  function machineBlock(): string {
    const start = src.indexOf("function registerMachineTools");
    expect(
      start,
      "registerMachineTools must exist in tools/machine.ts",
    ).toBeGreaterThan(-1);
    return src.slice(start);
  }

  it("all six tools registered, and buildServer calls the registrar", () => {
    const block = machineBlock();
    for (const name of [
      "machine_list",
      "machine_status",
      "machine_rename",
      "machine_remove",
      "machine_enable",
      "machine_disable",
    ]) {
      expect(block, `tool ${name} must be registered`).toContain(`"${name}"`);
    }
    expect(serverSrc).toContain("registerMachineTools(server);");
  });

  it("machine tools are NOT wrapped in withT (machine/remote do not apply)", () => {
    expect(machineBlock()).not.toContain("withT");
  });
});
