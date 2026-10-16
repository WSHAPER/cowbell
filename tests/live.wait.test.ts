import { describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { createWaitRegistry, type WaitRecord } from "../src/herdr/waits.js";
import { herdrSocketPath, herdrSocketRequest } from "../src/herdr/socket.js";
import { parseAgentListResult } from "../src/herdr/outputs.js";
import { AGENT_STATUSES, type AgentStatus } from "../src/herdr/schemas.js";

/**
 * LIVE e2e (read-only against the real herdr socket — subscribe +
 * authoritative reads only, never a write): exercises the wait
 * registry against the session THIS process runs in. Skips without a
 * live herdr. The pane under test is OUR OWN pane (HERDR_PANE_ID,
 * injected by herdr into managed pane processes) when it hosts a
 * recognized agent — self-referential verification against real
 * herdr. The event-driven own-pane-until-idle fire is covered by
 * scripts/lib/wait-own-pane.mjs, which observes the caller going
 * idle; everything else (event fire, events_lost, cancel semantics)
 * is pinned by the mock-socket unit suite.
 */
const hasHerdr =
  spawnSync("herdr", ["--version"], { stdio: "ignore" }).status === 0;

const ownPane = process.env.HERDR_PANE_ID;

async function readAgents() {
  return parseAgentListResult(await herdrSocketRequest("agent.list", {}));
}

let ownStatus: AgentStatus | undefined;
if (hasHerdr && ownPane) {
  try {
    const hit = (await readAgents()).find((a) => a.pane_id === ownPane);
    ownStatus =
      hit && AGENT_STATUSES.includes(hit.agent_status as AgentStatus)
        ? (hit.agent_status as AgentStatus)
        : undefined;
  } catch {
    // live herdr present but its socket is not reachable — skip below
  }
}

function one(
  waits: ReturnType<typeof createWaitRegistry>,
  id: string,
): WaitRecord {
  const r = waits.waitStatus(id);
  if (!("wait_id" in r)) throw new Error("expected one wait");
  return r;
}

describe.skipIf(!hasHerdr || !ownPane || !ownStatus)(
  `wait registry live (own pane ${ownPane ?? "?"}, status ${ownStatus ?? "?"}, socket ${hasHerdr ? herdrSocketPath() : "n/a"})`,
  () => {
    it("wait_start on OUR OWN pane fires immediately when the current status matches", async () => {
      const waits = createWaitRegistry();
      // The agent running this suite is mid-turn: its live status IS
      // ownStatus right now, so the current-state check must fire at once.
      const rec = await waits.waitStart(ownPane!, [ownStatus!], 5_000);
      expect(rec.state).toBe("fired");
      expect(rec.result).toBe(ownStatus);
      expect(rec.pane_id).toBe(ownPane);
    });

    it("opens a REAL subscription we can cancel cleanly", async () => {
      const waits = createWaitRegistry();
      const notNow = AGENT_STATUSES.filter((s) => s !== ownStatus);
      const rec = await waits.waitStart(ownPane!, notNow, 10_000);
      expect(rec.state).toBe("pending");
      // Give the real stream a beat, then abandon it.
      await new Promise((r) => setTimeout(r, 250));
      expect(waits.waitCancel({ wait_id: rec.wait_id })).toEqual({
        cancelled: [rec.wait_id],
      });
      expect(waits.waitStatus()).toEqual({ waits: [] });
    });

    it("times out against the real socket when the state never comes", async () => {
      const waits = createWaitRegistry();
      const notNow = AGENT_STATUSES.filter((s) => s !== ownStatus);
      const rec = await waits.waitStart(ownPane!, notNow, 300);
      // A real status transition during the window may legitimately
      // fire the wait (that is the feature); the deterministic
      // timeout pin lives in the mock-socket suite. Here we require
      // the wait to LEAVE pending within the deadline either way.
      await vi.waitFor(() => {
        const state = one(waits, rec.wait_id).state;
        expect(["timed_out", "fired"]).toContain(state);
      });
      const after = one(waits, rec.wait_id);
      if (after.state === "timed_out") expect(after.result).toBeUndefined();
      else expect(notNow).toContain(after.result);
    });

    it("wait_status reports the process-owned registry honestly", async () => {
      const waits = createWaitRegistry();
      const fired = await waits.waitStart(ownPane!, [ownStatus!], 5_000);
      const all = waits.waitStatus() as { waits: WaitRecord[] };
      expect(all.waits.map((w) => w.wait_id)).toEqual([fired.wait_id]);
      expect(all.waits[0]!.state).toBe("fired");
    });
  },
);
