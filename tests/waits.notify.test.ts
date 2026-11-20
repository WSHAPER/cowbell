import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendFile, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createWaitRegistry,
  waitNextResultSchema,
  type WaitNextResult,
  type WaitRecord,
  type WaitRegistry,
} from "../src/herdr/waits.js";
import { MockHerdrSocket } from "./helpers/mock-herdr-socket.js";

/**
 * The completion-notification half of the wait registry: wait_next
 * drains terminal transitions (fired | timed_out | failed, either
 * kind) and wakes parked callers. Status waits run against the mock
 * herdr socket (real wire framing); file waits run against a real
 * tmp file — the two halves the registry actually uses.
 */

let mock: MockHerdrSocket;
let dir: string;

const agent = (
  pane_id: string,
  agent_status: string,
): Record<string, unknown> => ({
  agent: "opencode",
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

/** Every wait_next result must satisfy the pinned contract. */
function contract(r: WaitNextResult): WaitNextResult {
  return waitNextResultSchema.parse(r);
}

/** Backdate mtime so an existing file counts as long-quiet. */
async function backdate(path: string, ms = 10_000): Promise<void> {
  const when = new Date(Date.now() - ms);
  await utimes(path, when, when);
}

beforeEach(async () => {
  mock = new MockHerdrSocket();
  await mock.start();
  dir = await mkdtemp(join(tmpdir(), "cowbell-waitnext-"));
});

afterEach(async () => {
  await mock.stop();
  await rm(dir, { recursive: true, force: true });
});

describe("wait_next: immediate (no park)", () => {
  it("returns an already-terminal event at once (timed_out stays false)", async () => {
    mock.agents = [agent("w1:p1", "idle")];
    const reg = registry();
    const rec = await reg.waitStart("w1:p1", ["idle"], 5_000);
    expect(rec.state).toBe("fired");
    // A full-timeout park would end timed_out: true — false proves
    // the buffered batch was returned without waiting.
    const out = await reg.waitNext(2_000);
    expect(contract(out)).toEqual({
      events: [rec],
      pending: 0,
      timed_out: false,
    });
  });

  it("returns {events: [], pending: 0} immediately when nothing is registered", async () => {
    const reg = registry();
    const out = await reg.waitNext(2_000);
    expect(contract(out)).toEqual({ events: [], pending: 0, timed_out: false });
  });

  it("returns immediately after every wait was cancelled (cancel emits nothing)", async () => {
    mock.agents = [agent("w1:p1", "working")];
    const reg = registry();
    await reg.waitStart("w1:p1", ["idle"], 5_000);
    reg.waitCancel({ all: true });
    const out = await reg.waitNext(2_000);
    expect(contract(out)).toEqual({ events: [], pending: 0, timed_out: false });
    expect(out.events).toHaveLength(0); // cancelled waits are simply forgotten
    expect(reg.waitStatus()).toEqual({ waits: [] });
  });
});

describe("wait_next: park and wake", () => {
  it("wakes when a pushed status event fires a pending wait", async () => {
    mock.agents = [agent("w1:p1", "working")];
    const reg = registry();
    const rec = await reg.waitStart("w1:p1", ["idle"], 5_000);
    await vi.waitFor(() => expect(mock.subscribes).toBe(1));
    let settled: WaitNextResult | undefined;
    const parked = reg.waitNext(5_000).then((r) => (settled = r));
    await new Promise((r) => setTimeout(r, 50));
    expect(settled).toBeUndefined(); // still parked
    mock.pushStatusEvent("w1:p1", "idle");
    const out = await parked;
    expect(contract(out)).toEqual({
      events: [one(reg, rec.wait_id)],
      pending: 0,
      timed_out: false,
    });
    const first = out.events[0]!;
    if (!("until" in first)) throw new Error("expected a status wait record");
    expect(first.result).toBe("idle");
  });

  it("wakes when a wait TIMES OUT (terminal, not just fired)", async () => {
    mock.agents = [agent("w1:p1", "working")];
    const reg = registry();
    const rec = await reg.waitStart("w1:p1", ["idle"], 150);
    const out = await reg.waitNext(5_000);
    expect(out.events).toEqual([one(reg, rec.wait_id)]);
    expect(out.events[0]!.state).toBe("timed_out");
    expect(out.pending).toBe(0);
  });

  it("delivers waits that terminate in one synchronous burst as ONE batch", async () => {
    // Status waits are one-stream-per-wait, so a pushed event reaches
    // each wait on its own socket delivery — separate macrotasks. The
    // genuine single-burst case is the file poller: ONE snapshot
    // fan-out fires every pending wait on the path synchronously.
    const path = join(dir, "report.md");
    await writeFile(path, "# Work log\n");
    await backdate(path);
    const reg = registry();
    const a = await reg.fileWaitStart(path, "^## Status", 150, 5_000);
    const b = await reg.fileWaitStart(path, "^## Status.*done", 150, 5_000);
    expect(a.state).toBe("pending");
    expect(b.state).toBe("pending");
    let settled: WaitNextResult | undefined;
    const parked = reg.waitNext(5_000).then((r) => (settled = r));
    await new Promise((r) => setTimeout(r, 50));
    expect(settled).toBeUndefined(); // still parked
    await appendFile(path, "## Status: done\n");
    const out = await parked;
    expect(out.events.map((e) => e.wait_id).sort()).toEqual(
      [a.wait_id, b.wait_id].sort(),
    );
    expect(out.pending).toBe(0);
  });
});

describe("wait_next: park and wake (file-kind + park expiry)", () => {
  it("wakes when a FILE wait fires (marker written mid-park)", async () => {
    const path = join(dir, "report.md");
    await writeFile(path, "# Work log\n");
    await backdate(path);
    const reg = registry();
    const rec = await reg.fileWaitStart(path, "^## Status", 200, 5_000);
    expect(rec.state).toBe("pending");
    let settled: WaitNextResult | undefined;
    const parked = reg.waitNext(5_000).then((r) => (settled = r));
    await new Promise((r) => setTimeout(r, 50));
    expect(settled).toBeUndefined(); // parked
    await appendFile(path, "## Status: done\n");
    const out = await parked;
    expect(out.events).toEqual([one(reg, rec.wait_id)]);
    const ev = out.events[0]!;
    if (!("marker" in ev)) throw new Error(`expected a file event`);
    expect(ev.state).toBe("fired");
    expect(ev.result?.line).toBe("## Status: done");
    expect(out.pending).toBe(0);
  });

  it("expires with {events: [], timed_out: true} when nothing terminates", async () => {
    mock.agents = [agent("w1:p1", "working")];
    const reg = registry();
    await reg.waitStart("w1:p1", ["idle"], 5_000);
    const out = await reg.waitNext(150);
    expect(contract(out)).toEqual({ events: [], pending: 1, timed_out: true });
  });
});

describe("wait_next: drain semantics", () => {
  it("delivers each terminal record exactly once (second call waits anew)", async () => {
    mock.agents = [agent("w1:p1", "idle")];
    const reg = registry();
    await reg.waitStart("w1:p1", ["idle"], 5_000);
    const first = await reg.waitNext(2_000);
    expect(first.events).toHaveLength(1);
    // The batch was drained; with nothing pending the next call
    // returns empty immediately rather than replaying it.
    const second = await reg.waitNext(2_000);
    expect(second).toEqual({ events: [], pending: 0, timed_out: false });
  });
});
