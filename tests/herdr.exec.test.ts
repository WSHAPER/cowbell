import { describe, expect, it } from "vitest";
import { runHerdr } from "../src/herdr/exec.js";

/**
 * runHerdr is the only function that touches the process boundary —
 * pin its success and failure shapes directly (the spec tests pin
 * argv, these pin execution semantics).
 */
import { spawnSync } from "node:child_process";

const hasHerdr =
  spawnSync("herdr", ["--version"], { stdio: "ignore" }).status === 0;

describe.skipIf(!hasHerdr)("runHerdr", () => {
  it("executes a real spec and returns stdout", async () => {
    // `herdr --version` is the cheapest hermetically-safe call.
    const out = await runHerdr({
      argv: ["herdr", "--version"],
      surface: "version",
    });
    expect(out).toMatch(/herdr \d/);
  });

  it("failure carries the surface + stderr (honest errors)", async () => {
    await expect(
      runHerdr({
        argv: ["herdr", "workspace", "get", "wNOPE"],
        surface: "workspace get",
      }),
    ).rejects.toThrow(/workspace get/);
  });

  it("timeout option is honored", async () => {
    await expect(
      runHerdr({ argv: ["sleep", "5"], surface: "sleep" }, { timeoutMs: 100 }),
    ).rejects.toThrow();
  });
});
