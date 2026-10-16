import { randomUUID } from "node:crypto";
import { z } from "zod";
import { parseOrThrow } from "../parse.js";
import { parseAgentListResult, type AgentEntry } from "./outputs.js";
import * as sc from "./schemas.js";
import { AGENT_STATUSES, type AgentStatus } from "./schemas.js";
import {
  HerdrSocketError,
  herdrSocketRequest,
  openAgentStatusStream,
  type AgentStatusStream,
} from "./socket.js";

/**
 * SESSION-OWNED waits — the fix for the collateral/leak/hang class.
 *
 * Every wait lives IN-MEMORY in this cowbell process: no files, no
 * daemon, no durability. Dying with the process is the feature — an
 * orchestrator's `pkill` can never touch another session's waits,
 * and waits can never outlive the cowbell instance that owns them.
 * Cross-session invisibility is by design: there is no registry on
 * disk or inside the herdr server, so wait_status only ever reports
 * THIS process's waits.
 *
 * Mechanically each wait subscribes DIRECTLY to the herdr socket's
 * pane.agent_status_changed stream for its pane (never `herdr agent
 * wait` — that CLI primitive hangs intermittently; we route around
 * it), checks the CURRENT state first (fires immediately when the
 * target is already in a wanted state), and enforces its REQUIRED
 * timeout client-side. Per herdr socket semantics, an events_lost
 * error (or any stream death) means resubscribe + reconcile via an
 * authoritative agent list read — buffered events are never replayed.
 */

export const WAIT_STATES = ["pending", "fired", "timed_out"] as const;
export type WaitState = (typeof WAIT_STATES)[number];

/** The wait_status record contract. */
export const waitRecordSchema = z
  .object({
    wait_id: z.string(),
    target: z.string(),
    pane_id: z.string(),
    until: z.array(sc.agentStatus).min(1),
    state: z.enum(WAIT_STATES),
    result: sc.agentStatus.optional(),
    started_ms: z.number().int().nonnegative(),
  })
  .strict();
export type WaitRecord = z.output<typeof waitRecordSchema>;

/** Backoff between resubscribe attempts (ms), capped at the last step. */
const RESUBSCRIBE_BACKOFF_MS = [0, 100, 200, 400, 800, 1600, 2000];

interface LiveWait {
  record: WaitRecord;
  stream?: AgentStatusStream;
  timer?: ReturnType<typeof setTimeout>;
  attempts: number;
}

export interface WaitRegistryOpts {
  /** Pin every socket call to one path (tests point this at a mock). */
  socketPath?: string;
}

/** One registry per process — the ownership boundary itself. */
export class WaitRegistry {
  private readonly waits = new Map<string, LiveWait>();

  constructor(private readonly opts: WaitRegistryOpts = {}) {}

  /**
   * Validate, resolve the target against the live agent list, and
   * register a pending wait. Fires immediately (no subscription) when
   * the target already sits in a wanted state; otherwise arms the
   * event stream + the REQUIRED client-side deadline and returns the
   * pending record right away — waiting is never blocking.
   */
  async waitStart(
    target: string,
    until: AgentStatus[],
    timeoutMs: number,
  ): Promise<WaitRecord> {
    target = parseOrThrow("waitStart", sc.agentTarget, target);
    until = parseOrThrow("waitStart", z.array(sc.agentStatus).min(1), until);
    timeoutMs = parseOrThrow("waitStart", sc.timeoutMs, timeoutMs);

    const entry = await this.resolveTarget(target);
    const wait: LiveWait = {
      record: waitRecordSchema.parse({
        wait_id: `wait_${randomUUID()}`,
        target,
        pane_id: entry.pane_id ?? target,
        until,
        state: "pending",
        started_ms: Date.now(),
      }),
      attempts: 0,
    };
    this.waits.set(wait.record.wait_id, wait);

    const current = statusOf(entry);
    if (until.includes(current)) this.fire(wait, current);
    else {
      // The deadline is set EXACTLY ONCE here; arm()/recover() only
      // manage the stream, so no resubscribe can ever extend it.
      wait.timer = setTimeout(() => this.finish(wait, "timed_out"), timeoutMs);
      this.arm(wait);
    }
    return wait.record;
  }

  /** One wait (wait_id) or every wait owned by THIS process. */
  waitStatus(waitId?: string): WaitRecord | { waits: WaitRecord[] } {
    if (waitId === undefined)
      return { waits: [...this.waits.values()].map((w) => w.record) };
    const wait = this.waits.get(
      parseOrThrow("waitStatus", sc.nonEmptyText, waitId),
    );
    if (!wait)
      throw new Error(
        `waitStatus: wait_id ${JSON.stringify(waitId)} is not owned by this cowbell process`,
      );
    return wait.record;
  }

  /** Forget one ({wait_id}) or every ({all: true}) owned wait. */
  waitCancel(input: { wait_id?: string; all?: boolean }): {
    cancelled: string[];
  } {
    const v = parseOrThrow(
      "waitCancel",
      z
        .object({
          wait_id: sc.nonEmptyText.optional(),
          all: z.boolean().optional(),
        })
        .strict()
        .refine((x) => (x.all ?? false) !== (x.wait_id !== undefined), {
          message: "pass exactly one of wait_id or all: true",
        }),
      input,
    );
    const doomed =
      v.all === true
        ? [...this.waits.values()]
        : [this.waits.get(v.wait_id!)].filter(
            (w): w is LiveWait => w !== undefined,
          );
    if (v.all !== true && doomed.length === 0)
      throw new Error(
        `waitCancel: wait_id ${JSON.stringify(v.wait_id)} is not owned by this cowbell process`,
      );
    for (const wait of doomed) {
      this.teardown(wait);
      this.waits.delete(wait.record.wait_id);
    }
    return { cancelled: doomed.map((w) => w.record.wait_id) };
  }

  /**
   * Resolve a target (name or hosting pane id) against the live agent
   * list. Unknown targets fail the wait_start call itself — an honest
   * immediate error beats a wait that can only ever time out.
   */
  private async resolveTarget(target: string): Promise<AgentEntry> {
    const hit = (await this.readAgents()).find(
      (a) => a.pane_id === target || a.name === target,
    );
    if (!hit)
      throw new Error(
        `waitStart: target ${JSON.stringify(target)} not found in the local herdr session (agent list)`,
      );
    return hit;
  }

  /** Authoritative agent list on its own one-request connection. */
  private async readAgents(): Promise<AgentEntry[]> {
    return parseAgentListResult(
      await herdrSocketRequest("agent.list", {}, this.opts),
    );
  }

  /** Authoritative state read; fires when the target is already there. */
  private async reconcile(wait: LiveWait): Promise<void> {
    if (wait.record.state !== "pending") return;
    const hit = (await this.readAgents().catch(() => [])).find(
      (a) => a.pane_id === wait.record.pane_id,
    );
    if (hit && wait.record.until.includes(statusOf(hit)))
      this.fire(wait, statusOf(hit));
  }

  private arm(wait: LiveWait): void {
    if (wait.record.state !== "pending") return;
    openAgentStatusStream(
      wait.record.pane_id,
      {
        onEvent: (e) => {
          if (wait.record.until.includes(e.agent_status))
            this.fire(wait, e.agent_status);
        },
        onLost: () => {
          void this.recover(wait);
        },
      },
      this.opts,
    )
      .then((stream) => {
        wait.stream = stream;
        // Subscription armed BEFORE this read: any transition after it
        // arrives as an event, so the reconcile closes the check->arm race.
        if (wait.record.state === "pending") void this.reconcile(wait);
      })
      .catch((err: unknown) => void this.recover(wait, err));
  }

  /**
   * events_lost / stream death / refused subscribe: resubscribe and
   * reconcile from an authoritative read. Never replays buffered
   * events — the read IS the truth after a gap. The deadline timer is
   * deliberately NOT cleared here: whatever happens to the stream,
   * the REQUIRED client-side timeout stays armed as the backstop
   * (clearing it here would resurrect the hang class this module
   * exists to kill). Retries back off; while the socket is down the
   * wait simply stays pending until it times out.
   */
  private async recover(wait: LiveWait, cause?: unknown): Promise<void> {
    this.closeStream(wait);
    if (wait.record.state !== "pending") return;
    wait.attempts += 1;
    if (cause instanceof HerdrSocketError && cause.code === "not_found") {
      const agents = await this.readAgents().catch(() => [] as AgentEntry[]);
      if (!agents.some((a) => a.pane_id === wait.record.pane_id)) return; // pane gone: hold pending, timeout decides
    }
    const delay =
      RESUBSCRIBE_BACKOFF_MS[
        Math.min(wait.attempts - 1, RESUBSCRIBE_BACKOFF_MS.length - 1)
      ];
    const retry = setTimeout(() => this.arm(wait), delay);
    retry.unref();
  }

  private fire(wait: LiveWait, status: AgentStatus): void {
    this.finish(wait, "fired", status);
  }

  private finish(wait: LiveWait, state: WaitState, result?: AgentStatus): void {
    if (wait.record.state !== "pending") return;
    wait.record = { ...wait.record, state, result };
    this.teardown(wait);
  }

  /** Terminal teardown: stream AND deadline timer. */
  private teardown(wait: LiveWait): void {
    this.closeStream(wait);
    if (wait.timer !== undefined) clearTimeout(wait.timer);
    wait.timer = undefined;
  }

  private closeStream(wait: LiveWait): void {
    wait.stream?.close();
    wait.stream = undefined;
  }
}

/** Agent list status is optional and may drift — absent/unknown maps to "unknown". */
function statusOf(entry: AgentEntry): AgentStatus {
  return AGENT_STATUSES.includes(entry.agent_status as AgentStatus)
    ? (entry.agent_status as AgentStatus)
    : "unknown";
}

export function createWaitRegistry(opts: WaitRegistryOpts = {}): WaitRegistry {
  return new WaitRegistry(opts);
}
