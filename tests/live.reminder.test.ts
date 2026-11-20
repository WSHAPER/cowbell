import { describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { createWaitRegistry, type ReminderRecord } from "../src/herdr/waits.js";
import {
  execOpenCode,
  fetchMessages,
  injectPrompt,
} from "../src/opencode/client.js";

/**
 * LIVE e2e for the reminder kind (reminder_start → fireReminder): one
 * REAL one-shot reminder firing a REAL session.prompt injection into
 * a REAL scratch opencode session on the local background service,
 * then verified via session.message.list. This is the only place the
 * whole chain runs against live opencode — the unit suites pin it
 * with fake injection seams.
 *
 * BUDGET: exactly one model turn on the scratch session, no retries
 * of the flow. Skips silently when the opencode binary or its
 * background service is absent (the tests/live.wait.test.ts:20-23
 * spawnSync-gate idiom). A service-side failure of the injection
 * (e.g. no usable default model) skips with the reason recorded —
 * OUR bugs (drifted argv, wrong wiring) still fail loudly.
 */
const hasOpenCode =
  spawnSync("opencode", ["--version"], { stdio: "ignore" }).status === 0 &&
  // A present binary is not a live service — probe before firing.
  spawnSync("opencode", ["api", "server.info"], {
    stdio: "ignore",
    timeout: 5_000,
  }).status === 0;

/** Identifiable from `opencode api session.list` when cleanup ever leaks. */
const SCRATCH_TITLE = "cowbell-e2e-reminder";
const REMINDER_TEXT = "reminder e2e probe — reply with the single word DONE";

/**
 * session.create (POST /api/session): every body property is
 * optional, so the minimum honest body is just the identifying title.
 * Response: {data: {id: "ses_...", ...}}.
 */
async function createScratchSession(): Promise<string> {
  const stdout = await execOpenCode([
    "opencode",
    "api",
    "session.create",
    "--data",
    JSON.stringify({ title: SCRATCH_TITLE }),
  ]);
  const out = JSON.parse(stdout) as { data?: { id?: unknown } };
  const id = out.data?.id;
  if (typeof id !== "string" || !/^ses_[A-Za-z0-9]+$/.test(id))
    throw new Error(
      `session.create drifted from {data:{id:"ses_…"}}: ${stdout.slice(0, 120)}`,
    );
  return id;
}

/**
 * session.remove (DELETE /api/session/{sessionID}): no body, one path
 * param. The CLI exiting 0 IS the success signal (empty stdout — do
 * not parse it).
 */
async function deleteScratchSession(session: string): Promise<void> {
  await execOpenCode([
    "opencode",
    "api",
    "session.remove",
    "--param",
    `sessionID=${session}`,
  ]);
}

/** Narrow a waitStatus hit to the reminder record we armed. */
function asReminder(record: unknown): ReminderRecord {
  if (!record || typeof record !== "object" || !("kind" in record))
    throw new Error(
      `expected a reminder record, got ${JSON.stringify(record)}`,
    );
  return record as ReminderRecord;
}

/**
 * Service-side injection failures (no default model, provider/auth
 * trouble) skip the test — budget discipline says record and skip,
 * never burn retries. Anything else (our argv drifting, unknown
 * operation) fails loudly.
 */
const SERVICE_SIDE_FAILURE =
  /model|provider|api[ _-]?key|auth|quota|429|5\d\d|timeout/i;

/**
 * Wait for the armed reminder to reach its terminal state. The record
 * returned by reminderStart is a snapshot; waitStatus is the live view
 * (fireReminder REPLACES the record object). Service-side failures
 * (no model/auth) SKIP — record and move on, never burn retries.
 */
async function awaitFired(
  waits: ReturnType<typeof createWaitRegistry>,
  rec: ReturnType<ReturnType<typeof createWaitRegistry>["reminderStart"]>,
  ctx: { skip(): void },
): Promise<void> {
  await vi.waitFor(
    () => {
      const live = asReminder(waits.waitStatus(rec.wait_id));
      if (
        live.state === "failed" &&
        SERVICE_SIDE_FAILURE.test(live.reason ?? "")
      )
        ctx.skip();
      expect(live.state, live.reason ?? "injection failed").toBe("fired");
      expect(live.fired_count).toBe(1);
      expect(live.last_fired_ms).toBeGreaterThanOrEqual(rec.fire_at_ms);
    },
    { timeout: 30_000 },
  );
}

/**
 * Wait for delivery: the reminder text must have landed as a USER
 * message in the scratch session's transcript (turn admission).
 */
async function awaitDelivered(session: string): Promise<void> {
  await vi.waitFor(
    async () => {
      const page = await fetchMessages(session);
      const hit = page.messages.find(
        (m) =>
          m.role === "user" &&
          typeof m.text === "string" &&
          m.text.includes(REMINDER_TEXT),
      );
      expect(hit).toBeDefined();
    },
    { timeout: 10_000 },
  );
}

describe.skipIf(!hasOpenCode)(
  "reminder live e2e (real opencode background service)",
  () => {
    // ONE model turn total: a single case, sequential by construction.
    it(
      "arms a one-shot reminder whose fire injects into a real scratch session",
      { timeout: 60_000 },
      async (ctx) => {
        const session = await createScratchSession();
        try {
          const waits = createWaitRegistry({
            // The REAL fire action — same wiring as the composition root.
            inject: (s, t, o) => injectPrompt(s, t, o),
          });
          const rec = waits.reminderStart({
            session,
            text: REMINDER_TEXT,
            in_ms: 2_000,
          });
          expect(rec.kind).toBe("reminder");
          expect(rec.state).toBe("pending");
          expect(rec.target).toBe(session);
          expect(rec.fired_count).toBe(0);
          await awaitFired(waits, rec, ctx);
          await awaitDelivered(session);
        } finally {
          try {
            await deleteScratchSession(session);
          } catch (err) {
            // Never mask the delivery verdict with a cleanup error —
            // the leak is visible in output and session.list by title.
            console.warn(
              `live.reminder: scratch session ${session} NOT deleted:`,
              err instanceof Error ? err.message : err,
            );
          }
        }
      },
    );
  },
);
