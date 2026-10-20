import { z } from "zod";
import { execOpenCode, fetchMessages } from "../opencode/client.js";
import type { TranscriptMessage } from "../opencode/schemas.js";
import { parseOrThrow } from "../parse.js";
import { runHerdr } from "./exec.js";
import { isNativeOpenCodeSession } from "./messages.js";
import {
  parseAgentInfo,
  type AgentEntry,
  type AgentSession,
} from "./outputs.js";
import { AGENT_STATUSES, paneId } from "./schemas.js";
import type { AgentStatus } from "./schemas.js";
import { agentGet } from "./spec-agent.js";
import { paneGet } from "./spec-pane.js";
import type { Spec } from "./spec.js";
import { withTransport, type Transport } from "./transport-args.js";

/**
 * The agent_health flow: one honest verdict from THREE orthogonal
 * signals, because each alone lies (fleet field report 2026-10-20 —
 * silent transport-error stalls and herdr-restart session deaths were
 * the top wallclock thieves, both invisible to agent_status):
 *
 *   1. PROCESS  — `herdr agent get`; agent_not_found means the agent
 *      process is gone (a herdr restart kills agents while their
 *      workspaces/artifacts survive). When the target is a pane id,
 *      `herdr pane get` says whether the pane itself survived —
 *      restart death leaves the pane (recovery: fresh agent_start +
 *      reconstruction directive), a closed workspace does not.
 *   2. STATE    — the detected agent_status WITH its blind spot:
 *      pane-level agents (no native agent_session — e.g. model-spawned
 *      mini opencode) detect state by pane scraping, which reports
 *      idle forever; the response says so instead of lying.
 *   3. TRANSCRIPT ERROR TAIL — last N structured events via the local
 *      opencode API; error-ish events (transport timeouts, API errors,
 *      aborted turns) surface with timestamps, so "idle + recent
 *      transport error" is visible as the silent-stall signature.
 *      Unavailable (with the reason) when there is no native opencode
 *      session, on non-local transports, or when the API is down.
 *
 * Verdict derivation (conservative, first match wins):
 *
 *   dead            := agent get fails with agent_not_found — the
 *                      pane/process is gone (restart death)
 *   stalled-suspect := state idle|unknown AND a recent error event in
 *                      the tail — "recent" := within recentMs of the
 *                      check, OR the newest recorded act IS that error
 *                      (a turn that ended on an error with nothing
 *                      after it, however long ago)
 *   progressing     := herdr reports working (errors, if any, stay
 *                      listed in the tail but do not outrank it)
 *   healthy         := everything else (alive, no adverse evidence;
 *                      non-recent errors stay listed in the tail)
 */

/** The four-value verdict vocabulary. */
const HEALTH_VERDICTS = [
  "healthy",
  "progressing",
  "stalled-suspect",
  "dead",
] as const;
type HealthVerdict = (typeof HEALTH_VERDICTS)[number];

/** Default recency window for the stalled-suspect error test: 15 min. */
export const DEFAULT_RECENT_MS = 15 * 60 * 1000;

/** Default tail size (structured events scanned). */
export const DEFAULT_TAIL = 20;

/**
 * Error-ish text signatures, pinned to the fleet's observed stall
 * shape ("Transport: The operation timed out."). Deliberately
 * multi-word phrases: bare /error|failed|timeout/ would flag every
 * failing test run and every `timeout 7200 …` watcher command that
 * flows through tool output.
 *
 * Scanned on EVENT messages only (system / synthetic / shell / other
 * machine-generated events) — never on user or assistant prose: a
 * live sweep of 8 fleet sessions found ZERO standalone error events
 * and 19 prose/tool-output occurrences, i.e. agents DISCUSSING
 * transport errors (or echoing pane greps) is the only shape that
 * exists in practice, and text-scanning narration flags healthy
 * agents (this exact false positive fired on the author's own tail).
 * The role-based "aborted" event stays a signal regardless of text.
 */
const ERROR_SIGNATURES: { kind: string; re: RegExp }[] = [
  {
    kind: "transport-error",
    re: /\btransport\b[^\n]{0,120}\b(timed?\s*[- ]?out|timeout|error|unreachable)\b/i,
  },
  { kind: "transport-error", re: /\bthe operation timed out\b/i },
  { kind: "api-error", re: /\b(api|provider|server)\s+error\b/i },
  { kind: "api-error", re: /\brate[ -]?limit(ed)?\b/i },
];

const iso = (ms: number) => new Date(ms).toISOString();
const excerpt = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 200);

const errorEventSchema = z
  .object({
    kind: z.string().min(1),
    created: z.number(),
    created_iso: z.string().min(1),
    text: z.string(),
    recent: z.boolean(),
  })
  .strict();
type ErrorEvent = z.output<typeof errorEventSchema>;

const processSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("alive"),
      agent: z.string().min(1),
      pane_id: z.string().optional(),
      name: z.string().optional(),
    })
    .strict(),
  z
    .object({
      status: z.literal("dead"),
      reason: z.string().min(1),
      /** What the pane cross-check found (dead path only). */
      pane: z.enum(["exists", "gone", "unchecked", "unknown"]),
    })
    .strict(),
]);

const stateSchema = z
  .object({
    status: z.enum(AGENT_STATUSES),
    /** True when herdr tracks a native agent_session for this agent. */
    reliable: z.boolean(),
    note: z.string().min(1),
  })
  .strict();

const transcriptSchema = z.discriminatedUnion("available", [
  z
    .object({
      available: z.literal(true),
      session: z.object({ id: z.string(), source: z.string() }).strict(),
      scanned: z.number().int().min(0),
      /** Newest non-user event in the scanned tail, null when none. */
      latest_act: z
        .object({
          created: z.number(),
          created_iso: z.string(),
          role: z.string(),
        })
        .strict()
        .nullable(),
      errors: z.array(errorEventSchema),
    })
    .strict(),
  z
    .object({
      available: z.literal(false),
      reason: z.string().min(1),
    })
    .strict(),
]);

/** The VALIDATED result contract — uniform shape, every signal labeled. */
export const agentHealthResultSchema = z
  .object({
    target: z.string().min(1),
    verdict: z.enum(HEALTH_VERDICTS),
    checked_at: z.number(),
    checked_at_iso: z.string().min(1),
    process: processSchema,
    state: stateSchema,
    transcript: transcriptSchema,
    /** Why the verdict was derived + every blind spot that applies. */
    notes: z.array(z.string().min(1)),
  })
  .strict();
export type AgentHealthResult = z.output<typeof agentHealthResultSchema>;

export interface HealthDeps {
  /** Runs a herdr spec (agent get / pane get). */
  herdr: (s: Spec) => Promise<string>;
  /** Runs an opencode api argv (session.message.list). */
  opencode: (argv: string[]) => Promise<string>;
  /** Wall clock, injectable for deterministic tests. */
  now: () => number;
}

const defaultDeps: HealthDeps = {
  herdr: runHerdr,
  opencode: execOpenCode,
  now: () => Date.now(),
};

export interface HealthOpts {
  /** Structured events to scan, 1..200 (default 20). */
  tail?: number;
  /** Recency window for the stalled-suspect test, ms (default 15 min). */
  recentMs?: number;
  /** Transport for the herdr calls (the transcript stays local-only). */
  transport?: Transport;
}

type Process = z.output<typeof processSchema>;
type StateSignal = z.output<typeof stateSchema>;
type TranscriptSignal = z.output<typeof transcriptSchema>;

/**
 * Collect the three signals and derive the verdict. Throws only when
 * herdr itself fails with something OTHER than agent_not_found (an
 * honest tool/transport error, not a health verdict); every signal
 * degradation lands in the result with its reason.
 */
export async function agentHealth(
  target: string,
  opts: HealthOpts = {},
  deps: HealthDeps = defaultDeps,
): Promise<AgentHealthResult> {
  const tail = opts.tail ?? DEFAULT_TAIL;
  const recentMs = opts.recentMs ?? DEFAULT_RECENT_MS;
  const now = deps.now();

  let info: AgentEntry;
  try {
    info = parseAgentInfo(
      await deps.herdr(withTransport(agentGet(target), opts.transport)),
    );
  } catch (err) {
    if (notFound(err, "agent_not_found")) {
      return deadResult(deps, target, now, opts.transport);
    }
    throw err;
  }

  // -- signal 1: process (agent get succeeded → live in the registry) ----
  const process: Process = {
    status: "alive",
    agent: info.agent,
    pane_id: info.pane_id,
    name: info.name,
  };

  // -- signal 2: detected state, blind spot flagged -----------------------
  const { state, notes } = stateSignal(info);

  // -- signal 3: transcript error tail ------------------------------------
  const transcript = await errorTail(deps, target, info.agent_session, {
    tail,
    recentMs,
    now,
    transport: opts.transport,
  });
  if (transcript.available) {
    notes.push(
      `${transcript.errors.length} error-ish event(s) in the last ${transcript.scanned} transcript event(s)`,
    );
  }

  // -- verdict (first match wins; table in the module doc) ----------------
  const verdict = deriveVerdict(state, transcript, notes);

  return parse({
    target,
    verdict,
    checked_at: now,
    checked_at_iso: iso(now),
    process,
    state,
    transcript,
    notes,
  });
}

/** Signal 2 — detected status with its reliability + blind-spot notes. */
function stateSignal(info: AgentEntry): {
  state: StateSignal;
  notes: string[];
} {
  const session = info.agent_session;
  const raw = info.agent_status;
  const recognized =
    raw !== undefined && (AGENT_STATUSES as readonly string[]).includes(raw);
  const state: StateSignal = {
    status: recognized ? (raw as AgentStatus) : "unknown",
    reliable: session !== undefined,
    note: session
      ? "state tracked via the native agent_session"
      : "pane-level detection (no native agent_session) — model-spawned/mini agents report idle forever; status alone cannot be trusted, verify with agent_read",
  };
  const notes: string[] = [];
  if (!recognized) {
    notes.push(
      `herdr reported agent_status ${JSON.stringify(raw ?? null)} — not in the known vocabulary, treated as unknown`,
    );
  }
  if (!session) {
    notes.push("state-detection blind spot: pane-level agent (see state.note)");
  }
  return { state, notes };
}

/** First-match-wins verdict derivation (table in the module doc). */
function deriveVerdict(
  state: StateSignal,
  transcript: TranscriptSignal,
  notes: string[],
): HealthVerdict {
  const recentErrors = transcript.available
    ? transcript.errors.filter((e) => e.recent)
    : [];
  if (state.status === "working") {
    notes.push("herdr reports working");
    return "progressing";
  }
  if (
    (state.status === "idle" || state.status === "unknown") &&
    recentErrors.length > 0
  ) {
    const e = recentErrors[recentErrors.length - 1]!;
    notes.push(
      `state ${state.status} + recent ${e.kind} at ${e.created_iso} — the silent-stall signature (idle agent, errored turn)`,
    );
    return "stalled-suspect";
  }
  notes.push(
    state.status === "idle" && !transcript.available
      ? "idle with no transcript evidence available — verify with agent_read (pane view) before trusting it"
      : "alive; no adverse signal in the available evidence",
  );
  return "healthy";
}

/** The dead path: verdict dead + the pane cross-check for recovery context. */
async function deadResult(
  deps: HealthDeps,
  target: string,
  now: number,
  transport: Transport | undefined,
): Promise<AgentHealthResult> {
  let pane: "exists" | "gone" | "unchecked" | "unknown" = "unchecked";
  let reason =
    "herdr agent get failed with agent_not_found — no live agent for this target " +
    "(a herdr restart kills agent processes; workspaces and on-disk artifacts survive)";
  if (paneId.safeParse(target).success) {
    try {
      await deps.herdr(withTransport(paneGet(target), transport));
      pane = "exists";
      reason +=
        `; pane ${target} still exists — in-memory agent context is gone, ` +
        "recovery is a fresh agent_start + reconstruction directive";
    } catch (paneErr) {
      if (notFound(paneErr, "pane_not_found")) {
        pane = "gone";
        reason += `; pane ${target} is gone too (workspace closed)`;
      } else {
        pane = "unknown";
        reason += `; pane ${target} check failed: ${(paneErr as Error).message}`;
      }
    }
  }

  return parse({
    target,
    verdict: "dead",
    checked_at: now,
    checked_at_iso: iso(now),
    process: { status: "dead", reason, pane },
    state: {
      status: "unknown",
      reliable: false,
      note: "agent not in herdr's registry — no state to detect",
    },
    transcript: {
      available: false,
      reason: "agent_not_found — no native session to read",
    },
    notes: [reason],
  });
}

/** Match herdr's JSON error envelope ({"error":{"code":…}}) on stderr. */
function notFound(err: unknown, code: string): boolean {
  const e = err as { stderr?: string; message?: string };
  return new RegExp(`"code"\\s*:\\s*"${code}"`).test(
    `${e.stderr ?? ""} ${e.message ?? ""}`,
  );
}

/** Signal 3 — the structured-tail scan with its availability ladder. */
async function errorTail(
  deps: HealthDeps,
  target: string,
  session: AgentSession | undefined,
  o: { tail: number; recentMs: number; now: number; transport?: Transport },
): Promise<TranscriptSignal> {
  if (o.transport) {
    return {
      available: false,
      reason:
        "structured transcripts are local-session only; machine/remote transports cannot read the opencode API",
    };
  }
  if (!session) {
    return {
      available: false,
      reason: `agent ${JSON.stringify(target)} has no native agent_session (pane-level agent) — no structured transcript to scan; use agent_read for the pane view`,
    };
  }
  if (!isNativeOpenCodeSession(session)) {
    return {
      available: false,
      reason: `agent_session source ${JSON.stringify(session.source)} is not an opencode session`,
    };
  }
  try {
    // newest-first fetch, scanned chronologically so "latest act" = end.
    const page = await fetchMessages(
      session.value,
      { limit: o.tail, order: "desc" },
      deps.opencode,
    );
    return scanTail(session, [...page.messages].reverse(), o);
  } catch (err) {
    return {
      available: false,
      reason: `opencode api unreachable: ${(err as Error).message}`,
    };
  }
}

/** Chronological non-user messages → error events with recency flags. */
function scanTail(
  session: AgentSession,
  msgs: TranscriptMessage[],
  o: { recentMs: number; now: number },
): Extract<TranscriptSignal, { available: true }> {
  // An "act" is the agent doing something. Idle markers are terminal
  // state transitions, not acts — a turn that ends on a transport
  // error is typically followed by an idle marker, and that marker
  // must not mask the error as "something came after it".
  const acts = msgs.filter((m) => m.role !== "user" && m.role !== "idle");
  const latest = acts.at(-1) ?? null;
  const newestRecorded = [...msgs].reverse().find((m) => m.role !== "user");

  return {
    available: true,
    session: { id: session.value, source: session.source },
    scanned: msgs.length,
    latest_act: newestRecorded
      ? {
          created: newestRecorded.created,
          created_iso: iso(newestRecorded.created),
          role: newestRecorded.role,
        }
      : null,
    errors: acts
      .map((m) => errorMatch(m, latest, o))
      .filter((e): e is ErrorEvent => e !== null),
  };
}

/**
 * One message → one error event (or null); classification in
 * classifyError, the recency flags documented inline.
 */
function errorMatch(
  m: TranscriptMessage,
  latest: TranscriptMessage | null,
  o: { recentMs: number; now: number },
): ErrorEvent | null {
  const hit = classifyError(m);
  if (hit === null) return null;
  // recent := within the window, OR this error IS the newest act — a
  // turn that ended on an error with no act after it (idle markers
  // excluded) is the silent-stall signature however long ago it was.
  const withinWindow = m.created >= o.now - o.recentMs;
  const isLatestAct = latest !== null && m.id === latest.id;
  return {
    kind: hit.kind,
    created: m.created,
    created_iso: iso(m.created),
    text: excerpt(hit.text),
    recent: withinWindow || isLatestAct,
  };
}

/**
 * Role-based for "aborted", signature-based for machine-generated
 * event text; assistant/user prose is never text-scanned (narration
 * quotes errors without stalling — see ERROR_SIGNATURES).
 */
function classifyError(
  m: TranscriptMessage,
): { kind: string; text: string } | null {
  if (m.role === "aborted") {
    return { kind: "turn-aborted", text: (m.text ?? "").trim() };
  }
  if (m.role === "assistant") return null;
  const text = [
    m.text ?? "",
    ...m.parts.map((p) => ("text" in p ? p.text : "")),
  ]
    .join("\n")
    .trim();
  const sig = ERROR_SIGNATURES.find((s) => s.re.test(text));
  return sig ? { kind: sig.kind, text } : null;
}

function parse(result: unknown): AgentHealthResult {
  return parseOrThrow("agentHealth", agentHealthResultSchema, result);
}
