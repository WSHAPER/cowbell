import { describe, expect, it } from "vitest";
import {
  agentHealth,
  agentHealthResultSchema,
  type AgentHealthResult,
  type HealthDeps,
} from "../src/herdr/health.js";

/**
 * The agent_health decision matrix. The verdict is derived from three
 * orthogonal signals; each test pins one combination (or a blind-spot
 * degradation) to the verdict the tool description documents.
 */

const NOW = Date.parse("2026-10-20T12:00:00.000Z");

type Call = { bin: string; argv: string[] };

function fakeDeps(
  herdrOut: (call: Call) => string,
  opencodeOut: (call: Call) => string = () => ocEnvelope([]),
): { deps: HealthDeps; herdrCalls: Call[]; opencodeCalls: Call[] } {
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
      now: () => NOW,
    },
  };
}

// -- fixture builders ---------------------------------------------------------

type AgentOver = Partial<{
  agent: string;
  agent_status: string;
  pane_id: string;
  name: string;
  agent_session: Record<string, string> | undefined;
}>;

function agentGet(over: AgentOver = {}) {
  return JSON.stringify({
    id: "cli:agent:get",
    result: {
      type: "agent_info",
      agent: {
        agent: "opencode",
        agent_status: "idle",
        pane_id: "w20:p1",
        ...over,
      },
    },
  });
}

const NATIVE_SESSION = {
  agent: "opencode",
  kind: "id",
  source: "herdr:opencode",
  value: "ses_fixture0001AAAAAAAAAAAAAAAA",
};

/** A raw opencode message (pre-normalization shape). */
function msg(
  over: Partial<{
    id: string;
    type: string;
    created: number;
    text: string;
    content: { type: string; text?: string }[];
  }> = {},
) {
  return {
    id: over.id ?? `msg_${Math.random().toString(36).slice(2, 12)}`,
    type: over.type ?? "assistant",
    time: { created: over.created ?? NOW - 60_000 },
    ...(over.text !== undefined ? { text: over.text } : {}),
    ...(over.content !== undefined ? { content: over.content } : {}),
  };
}

function ocEnvelope(msgs: ReturnType<typeof msg>[]) {
  // NOTE: fixtures must list messages NEWEST-FIRST — the client is
  // queried with order=desc, and health.ts re-reverses to scan
  // chronologically.
  return JSON.stringify({ data: msgs, cursor: { previous: null } });
}

const TRANSPORT_ERROR = "Transport: The operation timed out.";

const herdrErr = (code: string, message: string) => {
  const e = new Error(`herdr (agent get) failed: ${message}`);
  (e as { stderr?: string }).stderr = JSON.stringify({
    error: { code, message },
    id: "cli:agent:get",
  });
  return e;
};

const notFoundDeps = (paneResult: (call: Call) => string) =>
  fakeDeps((call) => {
    if (call.argv.includes("get") && call.argv.includes("agent")) {
      throw herdrErr("agent_not_found", "agent target w20:p1 not found");
    }
    return paneResult(call);
  });

// -- alive + native opencode session ------------------------------------------

describe("agentHealth: alive agents with a native session", () => {
  it(
    "idle + clean tail → healthy; one herdr call, one desc API call",
    aliveIdleCleanTail,
  );

  it("working → progressing (errors do not outrank it)", async () => {
    const { deps } = fakeDeps(
      () =>
        agentGet({ agent_status: "working", agent_session: NATIVE_SESSION }),
      () =>
        ocEnvelope([
          msg({
            type: "synthetic",
            created: NOW - 10_000,
            text: TRANSPORT_ERROR,
          }),
        ]),
    );
    const r = await agentHealth("w20:p1", {}, deps);
    expect(r.verdict).toBe("progressing");
    expect(r.state.status).toBe("working");
    if (!r.transcript.available) return;
    expect(r.transcript.errors).toHaveLength(1); // still surfaced
    expect(r.transcript.errors[0]!.recent).toBe(true);
  });

  it("blocked → healthy (alive, needs input — visible in state)", async () => {
    const { deps } = fakeDeps(() =>
      agentGet({ agent_status: "blocked", agent_session: NATIVE_SESSION }),
    );
    const r = await agentHealth("w20:p1", {}, deps);
    expect(r.verdict).toBe("healthy");
    expect(r.state.status).toBe("blocked");
  });

  it("unrecognized agent_status is coerced to unknown and noted", async () => {
    const { deps } = fakeDeps(() =>
      agentGet({ agent_status: "sleeping", agent_session: NATIVE_SESSION }),
    );
    const r = await agentHealth("w20:p1", {}, deps);
    expect(r.state.status).toBe("unknown");
    expect(r.notes.join(" ")).toMatch(/not in the known vocabulary/);
  });
});

async function aliveIdleCleanTail() {
  const { deps, herdrCalls, opencodeCalls } = fakeDeps(
    () => agentGet({ agent_session: NATIVE_SESSION }),
    () =>
      ocEnvelope([
        msg({ type: "idle", created: NOW - 30_000, id: "m-idle" }),
        msg({
          type: "assistant",
          created: NOW - 60_000,
          id: "m-a",
          content: [{ type: "text", text: "Landed the report." }],
        }),
      ]),
  );
  const r = await agentHealth("w20:p1", {}, deps);

  expect(r.verdict).toBe("healthy");
  expect(r.process).toEqual({
    status: "alive",
    agent: "opencode",
    pane_id: "w20:p1",
  });
  expect(r.state).toEqual({
    status: "idle",
    reliable: true,
    note: "state tracked via the native agent_session",
  });
  expect(r.transcript.available).toBe(true);
  if (!r.transcript.available) return;
  expect(r.transcript.session).toEqual({
    id: "ses_fixture0001AAAAAAAAAAAAAAAA",
    source: "herdr:opencode",
  });
  expect(r.transcript.errors).toEqual([]);
  expect(r.transcript.latest_act).toMatchObject({ role: "idle" });
  expect(r.notes.join(" ")).toMatch(/no adverse signal/);

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
    "limit=20",
    "--param",
    "order=desc",
  ]);
}

// -- the stall signatures ------------------------------------------------------

describe("agentHealth: stalled-suspect", () => {
  it(
    "idle + newest act IS a transport error (however old) → stalled-suspect",
    newestActIsTransportError,
  );

  it(
    "idle + transport error within the window (activity continued after) → stalled-suspect",
    errorInsideWindowThenActivity,
  );

  it(
    "old error followed by newer activity, both outside the window → healthy, error kept",
    oldErrorNewerActivityOutsideWindow,
  );

  it(
    "aborted turn as the newest act → stalled-suspect, kind turn-aborted",
    abortedTurnNewestAct,
  );

  it(
    "user text mentioning timeouts is NOT an error event (nudge guard)",
    userTextMentioningTimeouts,
  );

  it(
    "assistant NARRATION quoting the error phrase is not an error event either",
    narrationQuotingErrorPhrase,
  );

  it("custom recent_ms narrows the window", customRecentMsNarrowsWindow);
});

async function newestActIsTransportError() {
  const stallAt = NOW - 3 * 60 * 60 * 1000; // 3h ago — far outside window
  // fixtures are NEWEST-FIRST: the API is queried with order=desc
  const { deps } = fakeDeps(
    () => agentGet({ agent_session: NATIVE_SESSION }),
    () =>
      ocEnvelope([
        msg({ type: "idle", created: stallAt + 1000, id: "m-idle" }),
        msg({
          type: "synthetic",
          created: stallAt,
          id: "m-err",
          text: TRANSPORT_ERROR,
        }),
      ]),
  );
  const r = await agentHealth("w20:p1", {}, deps);
  expect(r.verdict).toBe("stalled-suspect");
  if (!r.transcript.available) return;
  expect(r.transcript.errors[0]).toMatchObject({
    kind: "transport-error",
    created: stallAt,
    recent: true, // the trailing idle marker does not mask it
    text: TRANSPORT_ERROR,
  });
  expect(r.notes.join(" ")).toMatch(/silent-stall signature/);
}

async function errorInsideWindowThenActivity() {
  const { deps } = fakeDeps(
    () => agentGet({ agent_session: NATIVE_SESSION }),
    () =>
      ocEnvelope([
        msg({ type: "idle", created: NOW - 3 * 60 * 1000, id: "m-idle" }),
        msg({
          type: "assistant",
          created: NOW - 4 * 60 * 1000, // newer non-error act after it
          id: "m-after",
          content: [{ type: "text", text: "Recovered, continuing." }],
        }),
        msg({
          type: "synthetic",
          created: NOW - 5 * 60 * 1000, // 5 min ago — inside the window
          id: "m-err",
          text: TRANSPORT_ERROR,
        }),
      ]),
  );
  const r = await agentHealth("w20:p1", {}, deps);
  expect(r.verdict).toBe("stalled-suspect");
  if (!r.transcript.available) return;
  expect(r.transcript.errors[0]!.recent).toBe(true); // window rule
}

async function oldErrorNewerActivityOutsideWindow() {
  const { deps } = fakeDeps(
    () => agentGet({ agent_session: NATIVE_SESSION }),
    () =>
      ocEnvelope([
        msg({
          type: "idle",
          created: NOW - 2 * 60 * 60 * 1000 + 5,
          id: "m-i",
        }),
        msg({
          type: "assistant",
          created: NOW - 2 * 60 * 60 * 1000,
          id: "m-after",
          content: [{ type: "text", text: "Recovered and finished." }],
        }),
        msg({
          type: "synthetic",
          created: NOW - 3 * 60 * 60 * 1000,
          id: "m-err",
          text: TRANSPORT_ERROR,
        }),
      ]),
  );
  const r = await agentHealth("w20:p1", {}, deps);
  expect(r.verdict).toBe("healthy");
  if (!r.transcript.available) return;
  expect(r.transcript.errors).toHaveLength(1);
  expect(r.transcript.errors[0]!.recent).toBe(false);
}

async function abortedTurnNewestAct() {
  const { deps } = fakeDeps(
    () => agentGet({ agent_session: NATIVE_SESSION }),
    () =>
      ocEnvelope([
        msg({ type: "aborted", created: NOW - 45 * 60 * 1000, id: "m-ab" }),
      ]),
  );
  const r = await agentHealth("w20:p1", {}, deps);
  expect(r.verdict).toBe("stalled-suspect");
  if (!r.transcript.available) return;
  expect(r.transcript.errors[0]).toMatchObject({
    kind: "turn-aborted",
    recent: true,
  });
}

async function userTextMentioningTimeouts() {
  const { deps } = fakeDeps(
    () => agentGet({ agent_session: NATIVE_SESSION }),
    () =>
      ocEnvelope([
        msg({
          type: "user",
          created: NOW - 5 * 60 * 1000,
          id: "m-u",
          text: "your last turn timed out, redispatch please",
        }),
        msg({
          type: "assistant",
          created: NOW - 30 * 60 * 1000,
          id: "m-a",
          content: [{ type: "text", text: "Done with the task." }],
        }),
      ]),
  );
  const r = await agentHealth("w20:p1", {}, deps);
  expect(r.verdict).toBe("healthy");
  if (!r.transcript.available) return;
  expect(r.transcript.errors).toEqual([]);
  expect(r.transcript.latest_act).toMatchObject({ role: "assistant" });
}

async function narrationQuotingErrorPhrase() {
  // Field-verified false positive: agents discussing transport errors
  // (or echoing pane greps) produced every prose occurrence found in a
  // live 8-session sweep — narration is not a stall.
  const { deps } = fakeDeps(
    () => agentGet({ agent_session: NATIVE_SESSION }),
    () =>
      ocEnvelope([
        msg({
          type: "assistant",
          created: NOW - 5 * 60 * 1000,
          id: "m-narr",
          content: [
            {
              type: "text",
              text: "Two failures. The pattern: transport timeout in the tail — investigating.",
            },
          ],
        }),
      ]),
  );
  const r = await agentHealth("w20:p1", {}, deps);
  expect(r.verdict).toBe("healthy");
  if (!r.transcript.available) return;
  expect(r.transcript.errors).toEqual([]);
}

async function customRecentMsNarrowsWindow() {
  const { deps } = fakeDeps(
    () => agentGet({ agent_session: NATIVE_SESSION }),
    () =>
      ocEnvelope([
        msg({
          type: "assistant",
          created: NOW - 4 * 60 * 1000,
          id: "m-after",
          content: [{ type: "text", text: "Recovered." }],
        }),
        msg({
          type: "synthetic",
          created: NOW - 5 * 60 * 1000,
          id: "m-err",
          text: TRANSPORT_ERROR,
        }),
      ]),
  );
  const r = await agentHealth("w20:p1", { recentMs: 60_000 }, deps);
  // 5-min-old error, window narrowed to 1 min, newer act after it
  expect(r.verdict).toBe("healthy");
  if (!r.transcript.available) return;
  expect(r.transcript.errors[0]!.recent).toBe(false);
}

// -- dead: agent_not_found ------------------------------------------------------

describe("agentHealth: dead (agent_not_found)", () => {
  it(
    "pane still exists → dead with restart-death recovery context",
    deadPaneExistsRestartContext,
  );

  it("pane gone too → dead, pane: gone", async () => {
    const { deps } = notFoundDeps(() => {
      throw herdrErr("pane_not_found", "pane w20:p1 not found");
    });
    const r = await agentHealth("w20:p1", {}, deps);
    expect(r.verdict).toBe("dead");
    expect(r.process).toMatchObject({ status: "dead", pane: "gone" });
  });

  it("name target → dead, pane unchecked (no pane id to cross-check)", async () => {
    const { deps, herdrCalls } = fakeDeps(() => {
      throw herdrErr("agent_not_found", "agent target builder not found");
    });
    const r = await agentHealth("builder", {}, deps);
    expect(r.verdict).toBe("dead");
    expect(r.process).toMatchObject({ status: "dead", pane: "unchecked" });
    expect(herdrCalls).toHaveLength(1);
  });

  it("pane check fails oddly → still dead, pane: unknown", async () => {
    const { deps } = notFoundDeps(() => {
      throw new Error("herdr daemon socket vanished");
    });
    const r = await agentHealth("w20:p1", {}, deps);
    expect(r.verdict).toBe("dead");
    expect(r.process).toMatchObject({ status: "dead", pane: "unknown" });
  });

  it("other herdr failures propagate (honest error, not a verdict)", async () => {
    const { deps } = fakeDeps(() => {
      throw new Error("herdr (agent get) failed: ECONNREFUSED");
    });
    await expect(agentHealth("w20:p1", {}, deps)).rejects.toThrow(/agent get/);
  });
});

async function deadPaneExistsRestartContext() {
  const { deps, herdrCalls } = notFoundDeps(() =>
    JSON.stringify({
      id: "cli:pane:get",
      result: { type: "pane_info", pane: { pane_id: "w20:p1" } },
    }),
  );
  const r = await agentHealth("w20:p1", {}, deps);
  expect(r.verdict).toBe("dead");
  if (r.process.status !== "dead") return;
  expect(r.process).toMatchObject({ status: "dead", pane: "exists" });
  expect(r.process.reason).toMatch(/restart kills agent processes/);
  expect(r.process.reason).toMatch(/recovery is a fresh agent_start/);
  expect(r.transcript.available).toBe(false);
  if (r.transcript.available) return;
  expect(r.transcript.reason).toMatch(/agent_not_found/);
  expect(herdrCalls).toHaveLength(2); // agent get (failed) + pane get
  expect(herdrCalls[1]!.argv).toEqual(["herdr", "pane", "get", "w20:p1"]);
}

// -- transcript unavailability ladder -------------------------------------------

describe("agentHealth: transcript signal unavailability", () => {
  it(
    "pane-level agent (mini spawn): state unreliable + transcript unavailable, both said so",
    miniSpawnBlindSpots,
  );

  it(
    "non-opencode native session → unavailable with the source named",
    nonOpencodeNativeSession,
  );

  it("opencode API unreachable → unavailable with the error", async () => {
    const { deps } = fakeDeps(
      () => agentGet({ agent_session: NATIVE_SESSION }),
      () => {
        throw new Error("spawn opencode ENOENT");
      },
    );
    const r = await agentHealth("w20:p1", {}, deps);
    expect(r.transcript.available).toBe(false);
    if (r.transcript.available) return;
    expect(r.transcript.reason).toMatch(/opencode api unreachable: .*ENOENT/);
    expect(r.verdict).toBe("healthy"); // no error evidence ≠ no errors
    expect(r.notes.join(" ")).toMatch(/verify with agent_read/);
  });

  it("remote/machine transport → local-only transcript, herdr calls routed", async () => {
    const { deps, opencodeCalls, herdrCalls } = fakeDeps(() =>
      agentGet({ agent_session: NATIVE_SESSION }),
    );
    const r = await agentHealth(
      "w20:p1",
      { transport: { kind: "remote", sshTarget: "fleet@box" } },
      deps,
    );
    expect(r.transcript.available).toBe(false);
    if (r.transcript.available) return;
    expect(r.transcript.reason).toMatch(/local-session only/);
    expect(opencodeCalls).toHaveLength(0);
    expect(herdrCalls[0]!.argv).toContain("--remote");
  });
});

async function miniSpawnBlindSpots() {
  const { deps, opencodeCalls } = fakeDeps(() =>
    agentGet({ name: "mini-impl", agent_session: undefined }),
  );
  const r = await agentHealth("w3H:p1", {}, deps);

  expect(r.verdict).toBe("healthy"); // alive — but every blind spot flagged
  expect(r.state.reliable).toBe(false);
  expect(r.state.note).toMatch(/idle forever/);
  expect(r.transcript.available).toBe(false);
  if (r.transcript.available) return;
  expect(r.transcript.reason).toMatch(/no native agent_session/);
  expect(r.notes.join(" ")).toMatch(/blind spot/);
  expect(r.notes.join(" ")).toMatch(/verify with agent_read/);
  expect(opencodeCalls).toHaveLength(0);
}

async function nonOpencodeNativeSession() {
  const { deps } = fakeDeps(() =>
    agentGet({
      agent: "claude",
      agent_session: {
        agent: "claude",
        kind: "id",
        source: "herdr:claude",
        value: "claude-fixturesession",
      },
    }),
  );
  const r = await agentHealth("w9:p1", {}, deps);
  expect(r.transcript.available).toBe(false);
  if (r.transcript.available) return;
  expect(r.transcript.reason).toMatch(/not an opencode session/);
}

// -- the published contract -----------------------------------------------------

describe("agentHealth: every result validates against the schema", () => {
  it("all verdict shapes parse", async () => {
    const cases: AgentHealthResult[] = [];
    {
      const { deps } = fakeDeps(() =>
        agentGet({ agent_session: NATIVE_SESSION }),
      );
      cases.push(await agentHealth("w20:p1", {}, deps));
    }
    {
      const { deps } = fakeDeps(() =>
        agentGet({ agent_status: "working", agent_session: NATIVE_SESSION }),
      );
      cases.push(await agentHealth("w20:p1", {}, deps));
    }
    {
      const { deps } = fakeDeps(() => agentGet({}));
      cases.push(await agentHealth("w3H:p1", {}, deps));
    }
    {
      const { deps } = fakeDeps(() => {
        throw herdrErr("agent_not_found", "agent target w20:p1 not found");
      });
      cases.push(await agentHealth("w20:p1", {}, deps));
    }
    for (const r of cases) {
      expect(agentHealthResultSchema.safeParse(r).success).toBe(true);
    }
  });
});
