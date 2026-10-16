import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { runHerdr } from "../src/herdr/exec.js";
import {
  agentMessages,
  agentMessagesResultSchema,
} from "../src/herdr/messages.js";
import { parseAgentList } from "../src/herdr/outputs.js";
import { agentList } from "../src/herdr/spec-agent.js";

/**
 * LIVE smoke (same pattern as herdr.exec.test.ts): runs the real
 * agent_messages flow against the local herdr session. Requires a
 * live herdr with at least one recognized agent; skips otherwise.
 * The channel field is the assertion — whichever path the local
 * session exercises, the result must be honestly labeled.
 */
const hasHerdr =
  spawnSync("herdr", ["--version"], { stdio: "ignore" }).status === 0;

let agents: ReturnType<typeof parseAgentList> = [];
if (hasHerdr) {
  try {
    agents = parseAgentList(await runHerdr(agentList()));
  } catch {
    // herdr present but no live session — nothing to smoke-test.
    agents = [];
  }
}
const target = agents[0]?.pane_id;

describe.skipIf(!hasHerdr)("agentMessages live", () => {
  it.skipIf(!target)(
    `first agent (${target ?? "none"}) yields a valid channel-labeled result`,
    async () => {
      const r = await agentMessages(target!);
      expect(agentMessagesResultSchema.safeParse(r).success).toBe(true);
      if (r.channel === "structured") {
        expect(r.session.id).toMatch(/^ses_/);
        expect(Array.isArray(r.messages)).toBe(true);
      } else {
        expect(r.reason.length).toBeGreaterThan(0);
        expect(typeof r.text).toBe("string");
      }
    },
  );
});
