import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { WaitRegistry } from "../../herdr/waits.js";
import { json } from "../glue.js";
import {
  waitStartShape,
  fileWaitStartShape,
  waitNextShape,
} from "../shared.js";
import type {
  WaitStartParams,
  WaitStatusParams,
  WaitCancelParams,
  FileWaitStartParams,
  WaitNextParams,
} from "../shared.js";

/**
 * SESSION-OWNED waits — non-blocking status waits whose state lives
 * entirely in THIS cowbell process. Deliberately no transport params:
 * the herdr events socket is local-session-only.
 */
export function registerWaitTools(
  server: McpServer,
  waits: WaitRegistry,
): void {
  server.tool(
    "wait_start",
    "Start a NON-BLOCKING wait until an agent reaches one of the given statuses; returns " +
      "{wait_id} immediately — poll wait_status. SESSION-OWNED: the wait lives in-memory in THIS " +
      "cowbell process only (no files, no daemon, no durability — it dies with this process, so an " +
      "orchestrator's pkill can never touch another session's waits, and other cowbell instances " +
      "cannot see it by design). Subscribes directly to the local herdr socket's " +
      "pane.agent_status_changed events (NOT `herdr agent wait` — that CLI primitive hangs " +
      "intermittently; we route around it). The CURRENT status is checked first and fires " +
      "immediately when already matched. timeout_ms is REQUIRED and enforced client-side — the " +
      "wait never outlives it. machine/remote do not apply: the herdr socket is local-only.",
    waitStartShape,
    async (v: WaitStartParams) =>
      json(await waits.waitStart(v.target, v.until, v.timeout_ms)),
  );
  server.tool(
    "file_wait_start",
    "Start a NON-BLOCKING wait until a report file contains a line matching the marker regex AND " +
      "has been quiet (mtime+size unchanged) for stability_ms; returns {wait_id} immediately — poll " +
      "wait_status. SESSION-OWNED like every wait: in-memory in THIS cowbell process only, dies with " +
      "it, invisible to other sessions. The STATUS-INDEPENDENT completion signal — works for agents " +
      "whose status never leaves idle (e.g. minimal-interface model spawns), where wait_start is " +
      "useless. Poll-based (fs.stat + readFile, ~stability_ms/5 clamped to [50ms,1s], serialized per " +
      "file — no fs.watch, network mounts supported). Fires with result {line, mtime_ms} when the " +
      "marker line is present in a file that has been quiet for the full window; an already-quiet " +
      "matched file fires IMMEDIATELY. The quiet window resets on every observed write — a marker " +
      "seen mid-report cannot fire early (the byte-threshold false positive). Path must exist and be " +
      "a regular file (fails fast otherwise); a file deleted mid-wait ends as state 'failed' with a " +
      "reason, never rotting pending. stability_ms and timeout_ms are REQUIRED; timeout is enforced " +
      "client-side. machine/remote do not apply: the file is read by THIS process, locally.",
    fileWaitStartShape,
    async (v: FileWaitStartParams) =>
      json(
        await waits.fileWaitStart(
          v.path,
          v.marker,
          v.stability_ms,
          v.timeout_ms,
        ),
      ),
  );
  server.tool(
    "wait_next",
    "BLOCK until at least one wait owned by THIS cowbell process reaches a terminal state (fired | " +
      "timed_out | failed), then return the batch — the completion NOTIFICATION channel for wait_start/" +
      "file_wait_start/reminder_start. MCP servers cannot push into an opencode session (server->client " +
      "notifications are dropped; anomalyco/opencode#48855), so THIS TOOL RESULT IS THE WAKE-UP: park one " +
      "call instead of polling wait_status or spawning background `herdr agent wait` shells. Returns " +
      "immediately when terminal events are already undelivered, or with {events: [], pending: 0} when no " +
      "waits are pending (nothing can ever fire). Parking is event-driven (zero wake-ups between " +
      "transitions); timeout_ms is REQUIRED and bounds only THIS call — expiry returns {events: [], " +
      "pending: N, timed_out: true}, the cue to call again. Events (full wait records, any of the three " +
      "kinds) are DRAINED — each terminal record is delivered to exactly one wait_next call. Reminder " +
      "terminals arrive here like any other: fired once the injection landed (or failed after its " +
      "bounded retries) — the injected prompt is the target session's wakeup, the drained event is " +
      "this side's receipt. wait_status remains the full-state view. wait_cancel emits nothing " +
      "(cancelled waits are simply forgotten). opencode holds tool calls open for up to 12h " +
      "(execution timeout), so a long park is safe. Session-owned like every wait: machine/remote do " +
      "not apply.",
    waitNextShape,
    async (v: WaitNextParams) => json(await waits.waitNext(v.timeout_ms)),
  );
  registerWaitQueryTools(server, waits);
}

/** wait_status + wait_cancel: the observation/abandonment surface. */
function registerWaitQueryTools(server: McpServer, waits: WaitRegistry): void {
  server.tool(
    "wait_status",
    "Report one wait (pass wait_id) or every wait owned by THIS cowbell process (omit it) — all " +
      "three kinds intermix in one list: {wait_id, target, pane_id, until, state: " +
      "pending|fired|timed_out, result?, started_ms} for status waits; {wait_id, target (path), " +
      "marker, stability_ms, timeout_ms, state, result?, reason?, started_ms} for file waits " +
      "(file_wait_start); {wait_id, kind: 'reminder', target (ses_ session id), text, delivery, " +
      "fire_at_ms, every_ms?, until_ms, state: pending|fired|failed, fired_count, last_fired_ms?, " +
      "reason?, started_ms} for reminders (reminder_start). fired carries result (the status that " +
      "fired, or {line, mtime_ms} for file waits; a reminder's receipt is fired_count/last_fired_ms " +
      "— the injection itself landed in the target session); 'failed' carries reason for file waits " +
      "(watched file deleted/unreadable) and reminders (the fire-time injection failed after its " +
      "bounded retries) alike; timed_out carries none — and is UNREACHABLE for reminders: their " +
      "bound is until_ms, and reaching it is a normal completion, not a timeout. All state is " +
      "in-memory in this process — waits owned by other sessions or cowbell instances are invisible " +
      "by design (there is no registry on disk or in the herdr server), and everything is gone when " +
      "the process dies.",
    {
      wait_id: z
        .string()
        .min(1)
        .optional()
        .describe("Omit to report all waits"),
    },
    (v: WaitStatusParams) => Promise.resolve(json(waits.waitStatus(v.wait_id))),
  );

  server.tool(
    "wait_cancel",
    "Cancel waits of any kind owned by THIS cowbell process — one ({wait_id}) or all ({all: " +
      "true}), exactly one of the two. Cancelling closes the subscription/poller/fire timer and " +
      "forgets the wait (it disappears from wait_status; fired/timed_out/failed waits are simply " +
      "forgotten). Never touches another process's or session's waits — ownership is process-scoped " +
      "by construction.",
    {
      wait_id: z.string().min(1).optional(),
      all: z.boolean().optional(),
    },
    (v: WaitCancelParams) => Promise.resolve(json(waits.waitCancel(v))),
  );
}
