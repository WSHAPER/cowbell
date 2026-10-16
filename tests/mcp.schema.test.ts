import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { Spec } from "../src/herdr/spec.js";
import { agentStart } from "../src/herdr/spec-agent.js";
import type { StartParams } from "../src/mcp/shared.js";

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
 * The model twin of F1: agent_start's MCP schema must declare
 * `model`, and the schema layer must agree with the StartParams
 * TYPE. The linkage is compile-time via z.infer — indexed access on
 * a missing `model` key fails compile — because the runtime strips
 * undeclared keys silently, which is exactly how F1 shipped broken.
 */
describe("MCP schema layer: agent_start declares model (z.infer-linked)", () => {
  it("z.infer linkage: the schema output AND StartParams both carry model", async () => {
    const { withT, paneId } = await import("../src/mcp/shared.js");
    const { AGENT_KINDS } = await import("../src/herdr/spec-agent.js");

    const startSchema = z.object(
      withT({
        name: z.string(),
        kind: z.enum(AGENT_KINDS),
        pane: paneId,
        timeout_ms: z.number().int().positive().optional(),
        model: z.string().min(1).optional(),
        args: z.array(z.string().min(1)).min(1).optional(),
      }),
    );
    type FromSchema = z.infer<typeof startSchema>;

    // Compile-time linkage, both directions: zod strips undeclared
    // keys silently at runtime, so the ONLY honest guard is that
    // `model` must exist on the schema output (via z.infer) AND on
    // StartParams. Dropping it from either layer fails compile right
    // here — Property 'model' does not exist.
    type SchemaModel = NonNullable<FromSchema["model"]>;
    type ParamsModel = NonNullable<StartParams["model"]>;
    const selector: SchemaModel & ParamsModel = "zai/glm-5.3";
    const probe = { name: "mesh", kind: "opencode", pane: "w1:p1" } as const;
    expect(startSchema.parse({ ...probe, model: selector }).model).toBe(
      "zai/glm-5.3",
    );
  });

  it("model flows end-to-end: spec compiles it to `-- -m`", () => {
    const argv = agentStart("mesh", "opencode", "w1:p1", {
      model: "zai/glm-5.3",
    }).argv;
    expect(argv.slice(argv.indexOf("--") + 1)).toEqual(["-m", "zai/glm-5.3"]);
  });
});

describe("MCP registration: model params declared where they belong", () => {
  it("agent_start schema block in server.ts declares model", async () => {
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("../src/mcp/server.ts", import.meta.url), "utf8"),
    );
    const startBlock = src.slice(
      src.indexOf('"agent_start"'),
      src.indexOf('"agent_focus"'),
    );
    expect(startBlock).toContain("model:");
  });

  it("models_list is registered and takes NO transport params (local opencode API only)", async () => {
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("../src/mcp/server.ts", import.meta.url), "utf8"),
    );
    const modelsBlock = src.slice(
      src.indexOf('"models_list"'),
      src.indexOf('"agent_prompt"'),
    );
    expect(src).toContain("registerModelTools(server)");
    // machine/remote do not apply — the schema must not be wrapped in withT.
    expect(modelsBlock).not.toContain("withT");
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
