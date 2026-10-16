import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  WAIT_STATES,
  createWaitRegistry,
  waitRecordSchema,
  type WaitRecord,
  type WaitRegistry,
  type WaitState,
} from "../src/herdr/waits.js";
import { MockHerdrSocket } from "./helpers/mock-herdr-socket.js";

/**
 * Mock-socket unit tests for the session-owned wait registry. The mock
 * speaks the real wire framing (NDJSON, one request per connection,
 * subscription_started acks, events_lost error+close), so these cover
 * the full client stack below the MCP layer.
 */

/** Every record the registry hands out must satisfy the pinned contract. */
function contract(r: WaitRecord): WaitState {
  expect(waitRecordSchema.parse(r)).toEqual(r);
  expect(WAIT_STATES).toContain(r.state);
  return r.state;
}
let mock: MockHerdrSocket;

const agent = (
  pane_id: string,
  agent_status: string,
  name?: string,
): Record<string, unknown> => ({
  agent: "opencode",
  name,
  pane_id,
  workspace_id: "w1",
  agent_status,
});

function registry(): WaitRegistry {
  return createWaitRegistry({ socketPath: mock.socketPath });
}

function one(waits: WaitRegistry, id: string): WaitRecord {
  const r = waits.waitStatus(id);
  if (!("wait_id" in r)) throw new Error(`expected one wait, got all-list`);
  return r;
}

beforeEach(async () => {
  mock = new MockHerdrSocket();
  await mock.start();
});

afterEach(async () => {
  await mock.stop();
});

describe("wait registry: immediate fire", () => {
  it("fires without subscribing when the target already matches", async () => {
    mock.agents = [agent("w1:p1", "idle", "impl")];
    const reg = registry();
    const rec = await reg.waitStart("w1:p1", ["idle", "done"], 5_000);
    expect(contract(rec)).toBe("fired");
    expect(rec.result).toBe("idle");
    expect(mock.subscribes).toBe(0);
    expect(mock.agentListRequests).toBe(1);
  });

  it("resolves targets by name", async () => {
    mock.agents = [agent("w1:p1", "done", "impl")];
    const reg = registry();
    const rec = await reg.waitStart("impl", ["done"], 5_000);
    expect(rec.pane_id).toBe("w1:p1");
    expect(rec.state).toBe("fired");
  });

  it("treats a missing agent_status as unknown", async () => {
    mock.agents = [{ agent: "opencode", pane_id: "w1:p1" }];
    const reg = registry();
    const rec = await reg.waitStart("w1:p1", ["unknown"], 5_000);
    expect(rec.state).toBe("fired");
    expect(rec.result).toBe("unknown");
  });

  it("rejects unknown targets at start", async () => {
    mock.agents = [agent("w1:p1", "idle")];
    const reg = registry();
    await expect(reg.waitStart("ghost", ["idle"], 5_000)).rejects.toThrow(
      /not found/,
    );
  });
});

describe("wait registry: event-driven fire", () => {
  it("fires on a pushed status event for the target pane", async () => {
    mock.agents = [agent("w1:p1", "working", "impl")];
    const reg = registry();
    const rec = await reg.waitStart("w1:p1", ["idle"], 5_000);
    expect(rec.state).toBe("pending");
    await vi.waitFor(() => expect(mock.subscribes).toBe(1));
    mock.pushStatusEvent("w1:p1", "idle");
    await vi.waitFor(() => expect(one(reg, rec.wait_id).state).toBe("fired"));
    expect(contract(one(reg, rec.wait_id))).toBe("fired");
    expect(one(reg, rec.wait_id).result).toBe("idle");
  });

  it("ignores events for other panes and non-matching statuses", async () => {
    mock.agents = [agent("w1:p1", "working"), agent("w1:p2", "working")];
    const reg = registry();
    const rec = await reg.waitStart("w1:p1", ["done"], 5_000);
    await vi.waitFor(() => expect(mock.subscribes).toBe(1));
    mock.pushStatusEvent("w1:p2", "done");
    mock.pushStatusEvent("w1:p1", "blocked");
    await new Promise((r) => setTimeout(r, 150));
    expect(one(reg, rec.wait_id).state).toBe("pending");
    mock.pushStatusEvent("w1:p1", "done");
    await vi.waitFor(() => expect(one(reg, rec.wait_id).state).toBe("fired"));
  });
});

describe("wait registry: timeout and cancel", () => {
  it("times out client-side and closes the subscription", async () => {
    mock.agents = [agent("w1:p1", "working")];
    const reg = registry();
    const rec = await reg.waitStart("w1:p1", ["idle"], 120);
    await vi.waitFor(() => expect(mock.subscribes).toBe(1));
    await vi.waitFor(() =>
      expect(contract(one(reg, rec.wait_id))).toBe("timed_out"),
    );
    expect(one(reg, rec.wait_id).result).toBeUndefined();
    await vi.waitFor(() => expect(mock.liveSubscriptions()).toBe(0));
  });

  it("cancel forgets the wait; later events cannot resurrect it", async () => {
    mock.agents = [agent("w1:p1", "working")];
    const reg = registry();
    const rec = await reg.waitStart("w1:p1", ["idle"], 5_000);
    expect(reg.waitCancel({ wait_id: rec.wait_id })).toEqual({
      cancelled: [rec.wait_id],
    });
    expect(reg.waitStatus()).toEqual({ waits: [] });
    mock.pushStatusEvent("w1:p1", "idle");
    await new Promise((r) => setTimeout(r, 100));
    expect(reg.waitStatus()).toEqual({ waits: [] });
    expect(() => reg.waitStatus(rec.wait_id)).toThrow(/not owned/);
  });

  it("cancel requires exactly one of wait_id or all", () => {
    const reg = registry();
    expect(() => reg.waitCancel({})).toThrow(/exactly one/);
    expect(() => reg.waitCancel({ wait_id: "w9", all: true })).toThrow(
      /exactly one/,
    );
    expect(() => reg.waitCancel({ wait_id: "w9" })).toThrow(/not owned/);
  });
});

describe("wait registry: events_lost and stream death", () => {
  it("resubscribes and reconciles via agent.list — never replays", async () => {
    mock.agents = [agent("w1:p1", "working")];
    const reg = registry();
    const rec = await reg.waitStart("w1:p1", ["idle"], 5_000);
    await vi.waitFor(() => expect(mock.subscribes).toBe(1));
    const readsBefore = mock.agentListRequests;

    // The authoritative state moves to idle, then the stream is lost.
    mock.agents = [agent("w1:p1", "idle")];
    mock.emitEventsLost();
    await vi.waitFor(() => expect(one(reg, rec.wait_id).state).toBe("fired"));

    expect(one(reg, rec.wait_id).result).toBe("idle");
    expect(mock.subscribes).toBeGreaterThanOrEqual(2);
    expect(mock.agentListRequests).toBeGreaterThan(readsBefore);
    // The fire came from the authoritative read, not a replayed event.
    expect(mock.pushedEvents).toBe(0);
  });

  it("holds pending (no resubscribe loop) when the pane vanishes", async () => {
    mock.agents = [agent("w1:p1", "working")];
    const reg = registry();
    const rec = await reg.waitStart("w1:p1", ["idle"], 200);
    await vi.waitFor(() => expect(mock.subscribes).toBe(1));
    mock.rejectNextSubscribe = true;
    mock.agents = []; // pane gone from the authoritative list too
    mock.emitEventsLost();
    await vi.waitFor(() =>
      expect(one(reg, rec.wait_id).state).toBe("timed_out"),
    );
    expect(mock.subscribes).toBe(1); // the not_found reconcile stopped retrying
  });

  it("falls back to the timeout when the socket dies mid-wait", async () => {
    mock.agents = [agent("w1:p1", "working")];
    const reg = registry();
    const rec = await reg.waitStart("w1:p1", ["idle"], 250);
    await vi.waitFor(() => expect(mock.subscribes).toBe(1));
    mock.kill();
    await vi.waitFor(() =>
      expect(one(reg, rec.wait_id).state).toBe("timed_out"),
    );
  });
});

describe("wait registry: ownership is process-scoped", () => {
  it("one registry's cancel never touches another registry's waits", async () => {
    mock.agents = [agent("w1:p1", "working")];
    const mine = registry();
    const theirs = registry();
    const a = await mine.waitStart("w1:p1", ["idle"], 5_000);
    const b = await theirs.waitStart("w1:p1", ["idle"], 5_000);
    await vi.waitFor(() => expect(mock.subscribes).toBe(2));
    expect(mine.waitCancel({ all: true })).toEqual({ cancelled: [a.wait_id] });
    expect(one(theirs, b.wait_id).state).toBe("pending");
    mock.pushStatusEvent("w1:p1", "idle");
    await vi.waitFor(() => expect(one(theirs, b.wait_id).state).toBe("fired"));
    expect(mine.waitStatus()).toEqual({ waits: [] });
  });
});
