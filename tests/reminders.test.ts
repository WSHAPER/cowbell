import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createWaitRegistry,
  reminderRecordSchema,
  waitKind,
  type ReminderInject,
  type ReminderRecord,
  type WaitRecord,
  type WaitRegistry,
} from "../src/herdr/waits.js";
import { MockHerdrSocket } from "./helpers/mock-herdr-socket.js";

/**
 * Real-timer unit tests for the reminder half of the session-owned
 * registry (reminder_start): the scheduled session.prompt injection,
 * the recurring re-arm loop, and the bounded retry ladder. House
 * style per tests/waits.file.test.ts — short REAL ms windows +
 * vi.waitFor, never fake timers. Reminders need no herdr socket (the
 * injection seam is a plain injected function); only the
 * kinds-intermix case runs a status wait against the mock socket.
 */

/** One call the registry's injection seam actually made. */
interface InjectCall {
  session: string;
  text: string;
  opts: { delivery?: "steer" | "queue" };
  at: number;
}

/**
 * The fake injection seam: records every call, then answers from
 * `behavior` (default: deliver). Tests pass a failing or flaky
 * behavior to drive the retry ladder.
 */
function recorder(
  behavior: (call: InjectCall, n: number) => Promise<unknown> = () =>
    Promise.resolve({ delivered: true }),
): { calls: InjectCall[]; inject: ReminderInject } {
  const calls: InjectCall[] = [];
  return {
    calls,
    inject: (session, text, opts) => {
      calls.push({ session, text, opts, at: Date.now() });
      return behavior(calls[calls.length - 1]!, calls.length);
    },
  };
}

/** Every record the registry hands out must satisfy the pinned contract. */
function contract(r: ReminderRecord): string {
  expect(reminderRecordSchema.parse(r)).toEqual(r);
  return r.state;
}

function one(reg: WaitRegistry, id: string): ReminderRecord {
  const r = reg.waitStatus(id);
  if (!("wait_id" in r) || !("kind" in r))
    throw new Error(`expected one reminder, got ${JSON.stringify(r)}`);
  return r;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

describe("reminders: one-shot basics", () => {
  it("fires exactly once with (session, text, {delivery:steer}) and the defaults", async () => {
    const { calls, inject } = recorder();
    const reg = createWaitRegistry({ inject });
    const rec = reg.reminderStart({
      session: "ses_alpha",
      text: "check wait_status",
      in_ms: 80,
    });
    expect(rec.state).toBe("pending");
    expect(rec.target).toBe("ses_alpha");
    expect(rec.delivery).toBe("steer"); // the default delivery
    expect(rec.fired_count).toBe(0);
    expect(rec.every_ms).toBeUndefined(); // one-shot: no cadence
    expect(rec.until_ms).toBe(rec.started_ms + WEEK_MS); // default end bound
    await vi.waitFor(
      () => expect(contract(one(reg, rec.wait_id))).toBe("fired"),
      { timeout: 3_000 },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      session: "ses_alpha",
      text: "check wait_status",
      opts: { delivery: "steer" },
    });
    expect(typeof calls[0]!.at).toBe("number");
    const fired = one(reg, rec.wait_id);
    expect(fired.fired_count).toBe(1);
    expect(fired.last_fired_ms).toBeGreaterThanOrEqual(fired.started_ms);
    await sleep(200); // well past the slot: no second fire, ever
    expect(calls).toHaveLength(1);
    expect(one(reg, rec.wait_id).state).toBe("fired");
  });

  it("an explicit session and delivery pass through verbatim", async () => {
    const { calls, inject } = recorder();
    const reg = createWaitRegistry({ inject });
    const rec = reg.reminderStart({
      session: "ses_other",
      text: "nudge the other session",
      in_ms: 60,
      delivery: "queue",
    });
    expect(rec.target).toBe("ses_other");
    expect(rec.delivery).toBe("queue");
    await vi.waitFor(
      () => expect(contract(one(reg, rec.wait_id))).toBe("fired"),
      { timeout: 3_000 },
    );
    expect(calls[0]).toMatchObject({
      session: "ses_other",
      text: "nudge the other session",
      opts: { delivery: "queue" },
    });
  });

  it("at_ms (absolute, strictly future) arms identically to in_ms", async () => {
    const { calls, inject } = recorder();
    const reg = createWaitRegistry({ inject });
    const rec = reg.reminderStart({
      session: "ses_abs",
      text: "absolute schedule",
      at_ms: Date.now() + 80,
    });
    await vi.waitFor(
      () => expect(contract(one(reg, rec.wait_id))).toBe("fired"),
      { timeout: 3_000 },
    );
    expect(calls).toHaveLength(1);
  });
});

describe("reminders: start-time validation (fail fast, clear reason)", () => {
  it("requires exactly one of in_ms | at_ms", async () => {
    const reg = createWaitRegistry({ inject: recorder().inject });
    expect(() => reg.reminderStart({ session: "ses_v", text: "x" })).toThrow(
      /exactly one of in_ms/,
    );
    expect(() =>
      reg.reminderStart({
        session: "ses_v",
        text: "x",
        in_ms: 100,
        at_ms: Date.now() + 100,
      }),
    ).toThrow(/exactly one of in_ms/);
  });

  it("rejects an at_ms in the past (never silently immediate)", async () => {
    const reg = createWaitRegistry({ inject: recorder().inject });
    expect(() =>
      reg.reminderStart({
        session: "ses_past",
        text: "x",
        at_ms: Date.now() - 1_000,
      }),
    ).toThrow(/strictly in the future/);
  });

  it("rejects until_ms that does not bound the fire from above", async () => {
    const reg = createWaitRegistry({ inject: recorder().inject });
    expect(() =>
      reg.reminderStart({
        session: "ses_bound",
        text: "x",
        in_ms: 100,
        until_ms: Date.now() + 50,
      }),
    ).toThrow(/must bound the fire from above/);
  });

  it("fails honestly at start when the registry has no injection seam", async () => {
    const reg = createWaitRegistry();
    expect(() =>
      reg.reminderStart({ session: "ses_noseam", text: "x", in_ms: 100 }),
    ).toThrow(/no injection seam configured/);
  });
});

describe("reminders: recurring (every_ms)", () => {
  it("fires every slot, then completes terminal fired at until_ms with its count", async () => {
    const { calls, inject } = recorder();
    const reg = createWaitRegistry({ inject });
    const rec = reg.reminderStart({
      session: "ses_loop",
      text: "tick",
      in_ms: 150,
      every_ms: 150,
      until_ms: Date.now() + 640,
    });
    expect(rec.every_ms).toBe(150);
    await vi.waitFor(
      () => expect(contract(one(reg, rec.wait_id))).toBe("fired"),
      { timeout: 4_000 },
    );
    // Slots at +150/+300/+450/+600 fire; the next slot (+750) passes
    // until_ms (+640), so the reminder completes instead of re-arming.
    const fired = one(reg, rec.wait_id);
    expect(fired.fired_count).toBe(4);
    expect(fired.reason).toBeUndefined();
    expect(calls).toHaveLength(4);
    await sleep(250); // past the would-be next slot: terminal means terminal
    expect(calls).toHaveLength(4);
  });

  it("accepts every_ms below the MCP floor (the 60s UX floor lives in the MCP shape)", async () => {
    const { calls, inject } = recorder();
    const reg = createWaitRegistry({ inject });
    const rec = reg.reminderStart({
      session: "ses_fast",
      text: "fast loop",
      in_ms: 60,
      every_ms: 100, // < 60_000: rejected by the MCP shape, fine here
      until_ms: Date.now() + 280,
    });
    expect(rec.every_ms).toBe(100);
    await vi.waitFor(
      () => expect(contract(one(reg, rec.wait_id))).toBe("fired"),
      { timeout: 3_000 },
    );
    // Slots at +60/+160/+260 (timer jitter can skip at most a slot).
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls.length).toBeLessThanOrEqual(3);
    expect(one(reg, rec.wait_id).fired_count).toBe(calls.length);
  });

  it("a late fire SKIPS missed slots forward — never a catch-up burst", async () => {
    // Every injection takes ~270ms while the cadence is 100ms: each
    // delivered fire has already missed its next slot(s). Skipping
    // forward yields exactly 3 calls by until_ms; a naive catch-up
    // ladder would fire every missed slot (8+ calls).
    const { calls, inject } = recorder(
      () => new Promise((r) => setTimeout(() => r({}), 270)),
    );
    const reg = createWaitRegistry({ inject });
    const rec = reg.reminderStart({
      session: "ses_slow",
      text: "slow inject",
      in_ms: 50,
      every_ms: 100,
      until_ms: Date.now() + 920,
    });
    await vi.waitFor(
      () => expect(contract(one(reg, rec.wait_id))).toBe("fired"),
      { timeout: 5_000 },
    );
    expect(calls).toHaveLength(3);
    expect(one(reg, rec.wait_id).fired_count).toBe(3);
  });
});

describe("reminders: the retry ladder", () => {
  it("inject failing 3x records failed + reason (no infinite ladder)", async () => {
    const { calls, inject } = recorder(() =>
      Promise.reject(new Error("socket down")),
    );
    const reg = createWaitRegistry({ inject, retryDelayMs: 60 });
    const rec = reg.reminderStart({
      session: "ses_dead",
      text: "x",
      in_ms: 50,
    });
    await vi.waitFor(
      () => expect(contract(one(reg, rec.wait_id))).toBe("failed"),
      { timeout: 3_000 },
    );
    expect(calls).toHaveLength(3); // initial attempt + 2 spaced retries
    expect(one(reg, rec.wait_id).reason).toMatch(
      /injection failed after 3 attempts: socket down/,
    );
    expect(one(reg, rec.wait_id).fired_count).toBe(0);
    await sleep(150); // terminal: no fourth attempt
    expect(calls).toHaveLength(3);
  });

  it("inject failing 2x then succeeding fires on the third attempt", async () => {
    const { calls, inject } = recorder((_, n) =>
      n <= 2 ? Promise.reject(new Error("flaky")) : Promise.resolve({}),
    );
    const reg = createWaitRegistry({ inject, retryDelayMs: 60 });
    const rec = reg.reminderStart({
      session: "ses_flaky",
      text: "x",
      in_ms: 50,
    });
    await vi.waitFor(
      () => expect(contract(one(reg, rec.wait_id))).toBe("fired"),
      { timeout: 3_000 },
    );
    expect(calls).toHaveLength(3);
    const fired = one(reg, rec.wait_id);
    expect(fired.fired_count).toBe(1);
    expect(fired.reason).toBeUndefined();
  });

  it("retryDelayMs is honored: retries are spaced by the configured delay", async () => {
    const { calls, inject } = recorder((_, n) =>
      n === 1 ? Promise.reject(new Error("once")) : Promise.resolve({}),
    );
    const reg = createWaitRegistry({ inject, retryDelayMs: 120 });
    const rec = reg.reminderStart({
      session: "ses_spaced",
      text: "x",
      in_ms: 50,
    });
    await vi.waitFor(() => expect(calls.length).toBe(2), { timeout: 3_000 });
    const delta = calls[1]!.at - calls[0]!.at;
    expect(delta).toBeGreaterThanOrEqual(100); // ~120ms, clock-rounded
    expect(delta).toBeLessThanOrEqual(500); // not the 30s default
    await vi.waitFor(
      () => expect(contract(one(reg, rec.wait_id))).toBe("fired"),
      { timeout: 2_000 },
    );
  });

  it("without retryDelayMs the ladder waits the 30s default (no quick retry)", async () => {
    const { calls, inject } = recorder(() => Promise.reject(new Error("down")));
    const reg = createWaitRegistry({ inject });
    reg.reminderStart({ session: "ses_default", text: "x", in_ms: 50 });
    await vi.waitFor(() => expect(calls.length).toBe(1), { timeout: 2_000 });
    await sleep(350); // far past a test-sized retry delay, far short of 30s
    expect(calls).toHaveLength(1);
    const all = reg.waitStatus() as { waits: WaitRecord[] };
    expect(all.waits[0]!.state).toBe("pending");
  });
});

describe("reminders: cancel and notification", () => {
  it("cancel mid-pending tears the timer down and emits NOTHING", async () => {
    const { calls, inject } = recorder();
    const reg = createWaitRegistry({ inject });
    const rec = reg.reminderStart({
      session: "ses_cancel",
      text: "x",
      in_ms: 80,
    });
    expect(reg.waitCancel({ wait_id: rec.wait_id })).toEqual({
      cancelled: [rec.wait_id],
    });
    expect(() => reg.waitStatus(rec.wait_id)).toThrow(/not owned/);
    // Nothing is pending, so wait_next returns empty immediately —
    // had the cancel emitted a terminal event, this would show it.
    expect(await reg.waitNext(100)).toEqual({
      events: [],
      pending: 0,
      timed_out: false,
    });
    await sleep(250); // past the fire time: the timer is really gone
    expect(calls).toHaveLength(0);
  });

  it("cancel during the retry window kills the pending retry (silence contract)", async () => {
    const { calls, inject } = recorder((_, n) =>
      n === 1 ? Promise.reject(new Error("down")) : Promise.resolve({}),
    );
    const reg = createWaitRegistry({ inject, retryDelayMs: 200 });
    const rec = reg.reminderStart({
      session: "ses_midretry",
      text: "x",
      in_ms: 50,
    });
    await vi.waitFor(() => expect(calls.length).toBe(1), { timeout: 2_000 });
    reg.waitCancel({ wait_id: rec.wait_id }); // retry now pending
    await sleep(400); // past the retry delay: it never fired
    expect(calls).toHaveLength(1);
    expect(await reg.waitNext(100)).toEqual({
      events: [],
      pending: 0,
      timed_out: false,
    });
  });

  it("wait_status lists and looks up reminders (terminal records stay reportable)", async () => {
    const { inject } = recorder();
    const reg = createWaitRegistry({ inject });
    const a = reg.reminderStart({ session: "ses_a", text: "a", in_ms: 60 });
    const b = reg.reminderStart({ session: "ses_b", text: "b", in_ms: 60 });
    const all = reg.waitStatus() as { waits: WaitRecord[] };
    expect(all.waits.map((w) => w.wait_id).sort()).toEqual(
      [a.wait_id, b.wait_id].sort(),
    );
    expect(one(reg, b.wait_id).target).toBe("ses_b");
    await vi.waitFor(
      () => expect(contract(one(reg, a.wait_id))).toBe("fired"),
      { timeout: 3_000 },
    );
    expect(one(reg, a.wait_id).state).toBe("fired"); // stays visible
  });

  it("wait_next drains a fired reminder record exactly once", async () => {
    const { inject } = recorder();
    const reg = createWaitRegistry({ inject });
    const rec = reg.reminderStart({
      session: "ses_drain",
      text: "x",
      in_ms: 60,
    });
    const out = await reg.waitNext(3_000);
    expect(out.events.map((e) => e.wait_id)).toEqual([rec.wait_id]);
    const ev = out.events[0]!;
    expect(waitKind(ev)).toBe("reminder");
    if (!("kind" in ev)) throw new Error("expected a reminder record");
    expect(ev.state).toBe("fired");
    expect(ev.fired_count).toBe(1);
    expect(out.pending).toBe(0);
    // Delivered exactly once: the drained batch is not replayed.
    expect(await reg.waitNext(100)).toEqual({
      events: [],
      pending: 0,
      timed_out: false,
    });
  });
});

describe("reminders: one registry, ids intermix", () => {
  let mock: MockHerdrSocket;

  beforeEach(async () => {
    mock = new MockHerdrSocket();
    await mock.start();
  });

  afterEach(async () => {
    await mock.stop();
  });

  it("a reminder and a status wait coexist and drain through the same surfaces", async () => {
    mock.agents = [
      {
        agent: "opencode",
        pane_id: "w1:p1",
        workspace_id: "w1",
        agent_status: "working",
      },
    ];
    const { inject } = recorder();
    const reg = createWaitRegistry({ socketPath: mock.socketPath, inject });
    const wait = await reg.waitStart("w1:p1", ["idle"], 5_000);
    const reminder = reg.reminderStart({
      session: "ses_mix",
      text: "x",
      in_ms: 80,
    });
    // One namespace: both ids are wait_*, both listed by wait_status.
    expect(wait.wait_id).toMatch(/^wait_/);
    expect(reminder.wait_id).toMatch(/^wait_/);
    const all = reg.waitStatus() as { waits: WaitRecord[] };
    expect(all.waits.map((w) => w.wait_id).sort()).toEqual(
      [wait.wait_id, reminder.wait_id].sort(),
    );
    // Both terminate (pushed event + timer) and drain in ONE batch.
    await vi.waitFor(() => expect(mock.subscribes).toBe(1));
    mock.pushStatusEvent("w1:p1", "idle");
    await sleep(150); // let both terminal transitions land
    const out = await reg.waitNext(3_000);
    expect(out.events.map((e) => e.wait_id).sort()).toEqual(
      [wait.wait_id, reminder.wait_id].sort(),
    );
    expect(out.pending).toBe(0);
    expect(out.events.map((e) => waitKind(e)).sort()).toEqual([
      "reminder",
      "status",
    ]);
  });
});
