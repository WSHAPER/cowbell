import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  agentMessages,
  isNativeOpenCodeSession,
  type MessagesDeps,
} from "../src/herdr/messages.js";
import { agentMessagesResultSchema } from "../src/herdr/messages.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const fx = (name: string) =>
  readFileSync(path.join(root, "tests", "fixtures", name), "utf8");

const WITH_SESSION = fx("herdr-agent-get.session.json");
const NO_SESSION = fx("herdr-agent-get.no-session.json");
const OC_MESSAGES = fx("opencode-message-list.sample.json");

type Call = { bin: string; argv: string[] };

function fakeDeps(
  herdrOut: (call: Call) => string,
  opencodeOut: (call: Call) => string = () => OC_MESSAGES,
): { deps: MessagesDeps; herdrCalls: Call[]; opencodeCalls: Call[] } {
  const herdrCalls: Call[] = [];
  const opencodeCalls: Call[] = [];
  return {
    herdrCalls,
    opencodeCalls,
    deps: {
      herdr: async (s) => {
        const call = { bin: s.argv[0]!, argv: s.argv };
        herdrCalls.push(call);
        return herdrOut(call);
      },
      opencode: async (argv) => {
        const call = { bin: argv[0]!, argv };
        opencodeCalls.push(call);
        return opencodeOut(call);
      },
    },
  };
}

/**
 * The agent_messages decision matrix. The channel field is the
 * contract: structured only when a native opencode session resolves
 * AND the local opencode API answers; everything else is an explicit
 * pane_fallback that says why.
 */
describe("agentMessages channel: structured", () => {
  it("native opencode session + reachable API", async () => {
    const { deps, herdrCalls, opencodeCalls } = fakeDeps(() => WITH_SESSION);
    const r = await agentMessages("w20:p1", { limit: 25 }, deps);

    expect(r.channel).toBe("structured");
    if (r.channel !== "structured") return;
    expect(r.target).toBe("w20:p1");
    expect(r.session).toEqual({
      id: "ses_fixture0001AAAAAAAAAAAAAAAA",
      source: "herdr:opencode",
    });
    expect(r.messages).toHaveLength(4);
    expect(r.messages[0]!.role).toBe("user");
    expect(r.messages[1]!.role).toBe("synthetic");
    expect(r.messages[3]!.parts).toContainEqual({
      type: "tool",
      name: "shell",
      status: "completed",
    });

    // resolution then one API call, oldest first
    expect(herdrCalls).toHaveLength(1);
    expect(herdrCalls[0]!.argv).toEqual(["herdr", "agent", "get", "w20:p1"]);
    expect(opencodeCalls).toHaveLength(1);
    expect(opencodeCalls[0]!.argv).toEqual([
      "opencode",
      "api",
      "session.message.list",
      "--param",
      "sessionID=ses_fixture0001AAAAAAAAAAAAAAAA",
      "--param",
      "limit=25",
      "--param",
      "order=asc",
    ]);
  });
});

describe("agentMessages channel: pane_fallback", () => {
  it("no native agent_session", async () => {
    const { deps, herdrCalls, opencodeCalls } = fakeDeps(() => NO_SESSION);
    const r = await agentMessages(
      "w3H:p1",
      { lines: 120, source: "visible" },
      deps,
    );

    expect(r.channel).toBe("pane_fallback");
    if (r.channel !== "pane_fallback") return;
    expect(r.reason).toMatch(/no native agent_session/);
    expect(r.pane).toEqual({ lines: 120, source: "visible" });
    expect(r.text).toBe(NO_SESSION);
    expect(opencodeCalls).toHaveLength(0);
    expect(herdrCalls[1]!.argv).toEqual([
      "herdr",
      "agent",
      "read",
      "w3H:p1",
      "--source",
      "visible",
      "--lines",
      "120",
    ]);
  });

  it("non-opencode native session", async () => {
    const claude = JSON.stringify({
      id: "cli:agent:get",
      result: {
        type: "agent_info",
        agent: {
          agent: "claude",
          agent_session: {
            agent: "claude",
            kind: "id",
            source: "herdr:claude",
            value: "claude-fixturesession",
          },
          pane_id: "w9:p1",
        },
      },
    });
    const { deps, opencodeCalls } = fakeDeps(() => claude);
    const r = await agentMessages("w9:p1", {}, deps);
    expect(r.channel).toBe("pane_fallback");
    if (r.channel !== "pane_fallback") return;
    expect(r.reason).toMatch(/not an opencode session/);
    expect(opencodeCalls).toHaveLength(0);
  });
});

describe("agentMessages channel: pane_fallback guards", () => {
  it("opencode API unreachable", async () => {
    const { deps } = fakeDeps(
      () => WITH_SESSION,
      () => {
        throw new Error("spawn opencode ENOENT");
      },
    );
    const r = await agentMessages("w20:p1", {}, deps);
    expect(r.channel).toBe("pane_fallback");
    if (r.channel !== "pane_fallback") return;
    expect(r.reason).toMatch(/opencode api unreachable: .*ENOENT/);
  });

  it("remote/machine transports never hit the local API", async () => {
    const { deps, opencodeCalls } = fakeDeps(() => WITH_SESSION);
    const r = await agentMessages(
      "w20:p1",
      { transport: { kind: "remote", sshTarget: "fleet@box" } },
      deps,
    );
    expect(r.channel).toBe("pane_fallback");
    if (r.channel !== "pane_fallback") return;
    expect(r.reason).toMatch(/local-session only/);
    expect(opencodeCalls).toHaveLength(0);
  });
});

describe("agentMessages errors and schema", () => {
  it("herdr failure propagates (unknown target is an honest error)", async () => {
    const { deps } = fakeDeps(() => {
      throw new Error("herdr (agent get) failed: no agent for target");
    });
    await expect(agentMessages("wNOPE:p1", {}, deps)).rejects.toThrow(
      /agent get/,
    );
  });

  it("every result validates against the published schema", async () => {
    const { deps: a } = fakeDeps(() => WITH_SESSION);
    const { deps: b } = fakeDeps(() => NO_SESSION);
    for (const r of [
      await agentMessages("w20:p1", {}, a),
      await agentMessages("w3H:p1", {}, b),
    ]) {
      expect(agentMessagesResultSchema.safeParse(r).success).toBe(true);
    }
  });
});

describe("isNativeOpenCodeSession", () => {
  const mk = (
    over: Partial<{
      agent: string;
      kind: string;
      source: string;
      value: string;
    }>,
  ) => ({
    agent: "opencode",
    kind: "id",
    source: "herdr:opencode",
    value: "ses_ok123",
    ...over,
  });

  it("accepts kind id + opencode + ses_ value", () => {
    expect(isNativeOpenCodeSession(mk({}))).toBe(true);
  });
  it("rejects other agents, kinds, and id shapes", () => {
    expect(isNativeOpenCodeSession(mk({ agent: "claude" }))).toBe(false);
    expect(isNativeOpenCodeSession(mk({ kind: "name" }))).toBe(false);
    expect(isNativeOpenCodeSession(mk({ value: "not-a-ses-id" }))).toBe(false);
  });
});
