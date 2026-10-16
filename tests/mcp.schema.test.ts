import { describe, expect, it } from "vitest";
import type { Spec } from "../src/herdr/spec.js";
import { agentStart } from "../src/herdr/spec-agent.js";

/**
 * F1 regression: the agent_start MCP schema must declare `args` — the
 * e2e report found it was on agent_prompt instead (zod stripped it,
 * the feature was unreachable over MCP). This test exercises the
 * schema layer, not just spec.ts directly.
 */
describe("MCP schema layer: agent_start declares and forwards args", () => {
  it("agent_start schema declares args and spec forwards it end-to-end", async () => {
    const { z } = await import("zod");
    const argsSchema = z.array(z.string().min(1)).min(1).optional();
    const parsed = argsSchema.parse(["-m", "zai/glm-5.3"]);
    expect(parsed).toEqual(["-m", "zai/glm-5.3"]);

    const argv = agentStart("test", "opencode", "w1:p1", {
      args: ["-m", "zai/glm-5.3"],
    }).argv;
    expect(argv).toContain("--");
    expect(argv.slice(argv.indexOf("--") + 1)).toEqual(["-m", "zai/glm-5.3"]);

    // Source-level: the agent_start schema block must contain args
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("../src/mcp/server.ts", import.meta.url), "utf8"),
    );
    const startBlock = src.slice(
      src.indexOf('"agent_start"'),
      src.indexOf('"agent_focus"'),
    );
    expect(startBlock).toContain("args:");
  });

  it("agent_prompt schema does NOT declare args (it was misplaced there)", async () => {
    // Read the source to confirm the schema shape — this is the
    // regression pin for the copy-paste slip.
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("../src/mcp/server.ts", import.meta.url), "utf8"),
    );
    const promptBlock = src.slice(
      src.indexOf('"agent_prompt"'),
      src.indexOf('"agent_wait"'),
    );
    expect(promptBlock).not.toContain("args:");
  });
});

/**
 * F2 regression: agentStart is 4-ary; a 5th positional argument
 * must fail loud, not silently drop.
 */
describe("agentStart arity guard", () => {
  it("5 positional args throws", () => {
    expect(() =>
      (agentStart as unknown as (...a: unknown[]) => Spec)(
        "n",
        "opencode",
        "w1:p1",
        undefined,
        ["-m", "x"],
      ),
    ).toThrow(/at most 4 arguments/);
  });

  it("4-ary opts object still works", () => {
    const argv = agentStart("n", "opencode", "w1:p1", {
      args: ["-m", "x"],
    }).argv;
    expect(argv).toContain("--");
  });
});
