import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { readFile, stat } from "node:fs/promises";
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
 *
 * The registry also hosts FILE waits (file_wait_start): the
 * status-independent completion signal for report-marker watching.
 * Same ownership rules, same wait_id namespace, same
 * wait_status/wait_cancel surface — ids from both kinds intermix in
 * one registry. A file wait fires when the watched file contains a
 * line matching the marker regex AND the file has been quiet
 * (mtime+size unchanged) for stability_ms — the quiet window is the
 * cure for progressively-written reports firing early. File waits
 * poll (fs.stat + cached readFile, serialized per path, no fs.watch —
 * network mounts stay supported) instead of subscribing to the
 * socket, so they work for agents whose status never leaves idle
 * (e.g. minimal-interface model spawns). A watched file that
 * disappears mid-wait fails the wait (state "failed" + reason) rather
 * than rotting in pending.
 */

/**
 * "failed" is reachable ONLY by file waits (watched file deleted /
 * unreadable). Status waits keep their exact three-state behavior.
 */
export const WAIT_STATES = ["pending", "fired", "timed_out", "failed"] as const;
export type WaitState = (typeof WAIT_STATES)[number];

/** The wait_status record contract (status waits). */
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
/** The wait_status record contract (file waits — `target` is the path). */
const fileWaitResultSchema = z
  .object({
    line: z.string(),
    mtime_ms: z.number().int().nonnegative(),
  })
  .strict();
export const fileWaitRecordSchema = z
  .object({
    wait_id: z.string(),
    target: z.string(),
    marker: z.string(),
    stability_ms: z.number().int().positive(),
    timeout_ms: z.number().int().positive(),
    state: z.enum(WAIT_STATES),
    result: fileWaitResultSchema.optional(),
    /** Present only on state "failed" — why the watch died. */
    reason: z.string().optional(),
    started_ms: z.number().int().nonnegative(),
  })
  .strict();
type FileWaitResult = z.output<typeof fileWaitResultSchema>;
export type StatusWaitRecord = z.output<typeof waitRecordSchema>;
export type FileWaitRecord = z.output<typeof fileWaitRecordSchema>;
/** Either kind — one registry, one id namespace, intermixed in wait_status. */
export type WaitRecord = StatusWaitRecord | FileWaitRecord;

/** Backoff between resubscribe attempts (ms), capped at the last step. */
const RESUBSCRIBE_BACKOFF_MS = [0, 100, 200, 400, 800, 1600, 2000];

/** File-wait poll cadence: clamp(stability_ms / 5) into [50ms, 1s]. */
const MIN_POLL_MS = 50;
const MAX_POLL_MS = 1_000;
const pollIntervalMs = (stabilityMs: number): number =>
  Math.min(MAX_POLL_MS, Math.max(MIN_POLL_MS, Math.round(stabilityMs / 5)));

const filePathInput = z
  .string()
  .min(1)
  .refine((p) => p.startsWith("/"), {
    message: "path must be absolute — report watches are local to THIS process",
  });

interface LiveWait {
  record: StatusWaitRecord;
  stream?: AgentStatusStream;
  timer?: ReturnType<typeof setTimeout>;
  attempts: number;
}

/** A live FILE wait — one watched path, one marker, one quiet window. */
interface LiveFileWait {
  record: FileWaitRecord;
  /** Set EXACTLY ONCE at start; the timeout backstop nothing can extend. */
  deadline?: ReturnType<typeof setTimeout>;
  markerRe: RegExp;
  /** Last observed "mtimeMs:size" signature — changes reset the quiet clock. */
  baseline: string;
  /** When the file last changed (observation time; mtime at start). */
  lastChange: number;
  /** Cached marker hit (line) for the current baseline, if any. */
  matchedLine?: string;
}

/** stat signature + content cache: what one poll tick observes per path. */
interface PathSnapshot {
  sig: string;
  content: string;
  mtimeMs: number;
}

/**
 * Per-path poller shared by every wait watching the same file: ONE
 * stat + at most ONE readFile per tick, fanned out to all waits —
 * polls are serialized per file, never concurrent on the same path.
 */
interface PathWatch {
  timer: ReturnType<typeof setInterval>;
  intervalMs: number;
  ticking: boolean;
  waits: Set<LiveFileWait>;
  /** Refreshed only when the stat signature moves. */
  cached?: PathSnapshot;
}

export interface WaitRegistryOpts {
  /** Pin every socket call to one path (tests point this at a mock). */
  socketPath?: string;
}

/** One registry per process — the ownership boundary itself. */
export class WaitRegistry {
  private readonly waits = new Map<string, LiveWait>();
  private readonly fileWaits = new Map<string, LiveFileWait>();
  private readonly pathWatches = new Map<string, PathWatch>();

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
  ): Promise<StatusWaitRecord> {
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

  /**
   * Register a pending FILE wait: fire when `path` contains a line
   * matching the `marker` regex AND the file has been quiet
   * (mtime+size unchanged) for `stabilityMs`. Mirrors waitStart's
   * current-state-first discipline: a marker that is already present
   * in an already-quiet file fires IMMEDIATELY, with no poller armed.
   * The path must exist and be a regular file at start — an honest
   * immediate error beats a wait that can only ever time out (the
   * waitStart/resolveTarget precedent). A file deleted mid-wait
   * fails the wait with a reason instead of rotting in pending.
   */
  async fileWaitStart(
    path: string,
    marker: string,
    stabilityMs: number,
    timeoutMs: number,
  ): Promise<FileWaitRecord> {
    path = parseOrThrow("fileWaitStart", filePathInput, path);
    marker = parseOrThrow("fileWaitStart", sc.nonEmptyText, marker);
    stabilityMs = parseOrThrow(
      "fileWaitStart",
      z.number().int().positive(),
      stabilityMs,
    );
    timeoutMs = parseOrThrow("fileWaitStart", sc.timeoutMs, timeoutMs);
    const markerRe = compileMarkerRe(marker);
    const st = await statReportFile(path);
    const wait = liveFileWait(markerRe, st, {
      path,
      marker,
      stabilityMs,
      timeoutMs,
    });
    this.fileWaits.set(wait.record.wait_id, wait);

    let content: string;
    try {
      content = await readFile(path, "utf8");
    } catch {
      this.fileWaits.delete(wait.record.wait_id);
      throw new Error(
        `fileWaitStart: path ${JSON.stringify(path)} vanished before the watch started`,
      );
    }
    const line = matchLine(markerRe, content);
    if (line !== undefined && Date.now() - wait.lastChange >= stabilityMs) {
      // Integer ms contract: stat.mtimeMs is fractional on Linux.
      this.fileFire(wait, line, Math.round(st.mtimeMs));
      return wait.record;
    }
    wait.matchedLine = line;
    // Same discipline as waitStart's deadline: set EXACTLY ONCE, the
    // backstop no poll outcome can extend.
    wait.deadline = setTimeout(
      () => this.fileFinish(wait, "timed_out"),
      timeoutMs,
    );
    this.joinPathWatch(wait);
    return wait.record;
  }

  /** One wait of either kind (wait_id) or every wait owned by THIS process. */
  waitStatus(waitId?: string): WaitRecord | { waits: WaitRecord[] } {
    if (waitId === undefined)
      return {
        waits: [
          ...[...this.waits.values()].map((w) => w.record),
          ...[...this.fileWaits.values()].map((w) => w.record),
        ],
      };
    const id = parseOrThrow("waitStatus", sc.nonEmptyText, waitId);
    const wait = this.waits.get(id) ?? this.fileWaits.get(id);
    if (!wait)
      throw new Error(
        `waitStatus: wait_id ${JSON.stringify(waitId)} is not owned by this cowbell process`,
      );
    return wait.record;
  }

  /** Forget one ({wait_id}) or every ({all: true}) owned wait — either kind. */
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
    let doomed: Array<LiveWait | LiveFileWait>;
    if (v.all === true)
      doomed = [...this.waits.values(), ...this.fileWaits.values()];
    else {
      const hit = this.waits.get(v.wait_id!) ?? this.fileWaits.get(v.wait_id!);
      if (!hit)
        throw new Error(
          `waitCancel: wait_id ${JSON.stringify(v.wait_id)} is not owned by this cowbell process`,
        );
      doomed = [hit];
    }
    for (const wait of doomed) {
      if (isLiveFileWait(wait)) {
        this.fileTeardown(wait);
        this.fileWaits.delete(wait.record.wait_id);
      } else {
        this.teardown(wait);
        this.waits.delete(wait.record.wait_id);
      }
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

  /** Attach a file wait to its path's shared poller (creating it if needed). */
  private joinPathWatch(wait: LiveFileWait): void {
    const path = wait.record.target;
    let watch = this.pathWatches.get(path);
    if (watch === undefined) {
      watch = {
        timer: setInterval(
          () => void this.pollPath(path),
          pollIntervalMs(wait.record.stability_ms),
        ),
        intervalMs: pollIntervalMs(wait.record.stability_ms),
        ticking: false,
        waits: new Set(),
      };
      // Internal machinery, like the recover() retry: never pins the
      // event loop — waits die with the process by design anyway.
      watch.timer.unref();
      this.pathWatches.set(path, watch);
    } else {
      this.recalcPathInterval(path, watch);
    }
    watch.waits.add(wait);
  }

  /** Detach a file wait; drop the poller entirely when its last wait leaves. */
  private leavePathWatch(wait: LiveFileWait): void {
    const path = wait.record.target;
    const watch = this.pathWatches.get(path);
    if (watch === undefined) return;
    watch.waits.delete(wait);
    if (watch.waits.size === 0) {
      clearInterval(watch.timer);
      this.pathWatches.delete(path);
    } else {
      this.recalcPathInterval(path, watch);
    }
  }

  /** Fastest-wanted cadence wins: short stability windows poll tighter. */
  private recalcPathInterval(path: string, watch: PathWatch): void {
    const wanted = Math.min(
      ...[...watch.waits].map((w) => pollIntervalMs(w.record.stability_ms)),
    );
    if (wanted === watch.intervalMs) return;
    clearInterval(watch.timer);
    watch.timer = setInterval(() => void this.pollPath(path), wanted);
    watch.timer.unref();
    watch.intervalMs = wanted;
  }

  /**
   * One tick for one path: a single authoritative stat, at most one
   * readFile (only when the stat signature moved), then fan out to
   * every pending wait on that path. Overlapping ticks are skipped —
   * polls are strictly serialized per file, which is what makes a
   * slow network mount degrade to slow, never to racing reads.
   */
  private async pollPath(path: string): Promise<void> {
    const watch = this.pathWatches.get(path);
    if (watch === undefined || watch.ticking) return;
    const pending = [...watch.waits].filter(
      (w) => w.record.state === "pending",
    );
    if (pending.length === 0) return;
    watch.ticking = true;
    try {
      const snapshot = await this.refreshSnapshot(path, watch, pending);
      if (snapshot === undefined) return; // IO failure: waits already failed
      const now = Date.now();
      for (const w of pending) this.tickFileWait(w, snapshot, now);
    } finally {
      watch.ticking = false;
    }
  }

  /**
   * Stat the path and keep the content cache fresh (re-read only when
   * the mtime+size signature moved). undefined means the file became
   * unobservable — every pending wait on it has been failed with a
   * reason, so the tick has nothing left to do.
   */
  private async refreshSnapshot(
    path: string,
    watch: PathWatch,
    pending: LiveFileWait[],
  ): Promise<PathSnapshot | undefined> {
    let st: Awaited<ReturnType<typeof stat>>;
    try {
      st = await stat(path);
    } catch (err) {
      this.failPending(pending, ioFailureReason("stat", path, err));
      return undefined;
    }
    const sig = `${st.mtimeMs}:${st.size}`;
    if (watch.cached?.sig === sig) return watch.cached;
    try {
      watch.cached = {
        sig,
        content: await readFile(path, "utf8"),
        mtimeMs: Math.round(st.mtimeMs),
      };
    } catch (err) {
      this.failPending(pending, ioFailureReason("read", path, err));
      return undefined;
    }
    return watch.cached;
  }

  /**
   * One wait against one snapshot: a changed signature resets the
   * quiet clock — the false-positive cure, a marker seen mid-write
   * cannot fire until the writer goes quiet for the full window —
   * and a marker present in a file quiet long enough fires.
   */
  private tickFileWait(w: LiveFileWait, snap: PathSnapshot, now: number): void {
    if (w.baseline !== snap.sig) {
      w.baseline = snap.sig;
      w.lastChange = now;
      w.matchedLine = matchLine(w.markerRe, snap.content);
    }
    if (
      w.matchedLine !== undefined &&
      now - w.lastChange >= w.record.stability_ms
    )
      this.fileFire(w, w.matchedLine, snap.mtimeMs);
  }

  private failPending(pending: LiveFileWait[], reason: string): void {
    for (const w of pending) this.fileFail(w, reason);
  }

  private fileFire(wait: LiveFileWait, line: string, mtimeMs: number): void {
    this.fileFinish(wait, "fired", { line, mtime_ms: mtimeMs });
  }

  private fileFail(wait: LiveFileWait, reason: string): void {
    this.fileFinish(wait, "failed", undefined, reason);
  }

  private fileFinish(
    wait: LiveFileWait,
    state: WaitState,
    result?: FileWaitResult,
    reason?: string,
  ): void {
    if (wait.record.state !== "pending") return;
    wait.record = { ...wait.record, state, result, reason };
    this.fileTeardown(wait);
  }

  /** Terminal teardown: deadline timer AND poller membership. */
  private fileTeardown(wait: LiveFileWait): void {
    if (wait.deadline !== undefined) {
      clearTimeout(wait.deadline);
      wait.deadline = undefined;
    }
    this.leavePathWatch(wait);
  }
}

/** Agent list status is optional and may drift — absent/unknown maps to "unknown". */
function statusOf(entry: AgentEntry): AgentStatus {
  return AGENT_STATUSES.includes(entry.agent_status as AgentStatus)
    ? (entry.agent_status as AgentStatus)
    : "unknown";
}

/** Discriminate the two live-wait kinds sharing this registry. */
function isLiveFileWait(w: LiveWait | LiveFileWait): w is LiveFileWait {
  return "markerRe" in w;
}

/** First line matching the marker regex — the reported matched line. */
function matchLine(re: RegExp, content: string): string | undefined {
  for (const line of content.split(/\r?\n/)) if (re.test(line)) return line;
  return undefined;
}

/**
 * Compile the marker regex with the "m" flag so ^/$ anchor per line;
 * flags are OURS, so a user "g" (the lastIndex footgun) can never
 * sneak in. An invalid source fails the start call immediately.
 */
function compileMarkerRe(marker: string): RegExp {
  try {
    return new RegExp(marker, "m");
  } catch (err) {
    throw new Error(
      `fileWaitStart: marker ${JSON.stringify(marker)} is not a valid regular expression: ${errorMessage(err)}`,
    );
  }
}

/**
 * The report file must exist and be a regular file at start — an
 * honest immediate error beats a wait that can only ever time out.
 */
async function statReportFile(path: string): Promise<Stats> {
  let st: Awaited<ReturnType<typeof stat>>;
  try {
    st = await stat(path);
  } catch {
    throw new Error(
      `fileWaitStart: path ${JSON.stringify(path)} does not exist (report files must exist before the watch starts)`,
    );
  }
  if (!st.isFile())
    throw new Error(
      `fileWaitStart: path ${JSON.stringify(path)} is not a regular file`,
    );
  return st;
}

/** The pending record plus the watch's comparison state, pre-poller. */
function liveFileWait(
  markerRe: RegExp,
  st: Stats,
  input: {
    path: string;
    marker: string;
    stabilityMs: number;
    timeoutMs: number;
  },
): LiveFileWait {
  return {
    record: fileWaitRecordSchema.parse({
      wait_id: `wait_${randomUUID()}`,
      target: input.path,
      marker: input.marker,
      stability_ms: input.stabilityMs,
      timeout_ms: input.timeoutMs,
      state: "pending",
      started_ms: Date.now(),
    }),
    markerRe,
    baseline: `${st.mtimeMs}:${st.size}`,
    // Credit pre-existing quietness via the file's own mtime (an
    // already-finished report fires at once); a skewed future mtime
    // collapses to now, degrading gracefully to the full window.
    lastChange: Math.min(Date.now(), st.mtimeMs),
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A watch that can no longer observe its file dies as "failed", never pending. */
function ioFailureReason(action: string, path: string, err: unknown): string {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  if (code === "ENOENT")
    return `file ${JSON.stringify(path)} was deleted while the wait was pending`;
  return `${action} on ${JSON.stringify(path)} failed: ${code ?? errorMessage(err)}`;
}

export function createWaitRegistry(opts: WaitRegistryOpts = {}): WaitRegistry {
  return new WaitRegistry(opts);
}
