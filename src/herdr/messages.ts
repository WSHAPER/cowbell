import { z } from "zod";
import { execOpenCode, fetchMessages } from "../opencode/client.js";
import { transcriptMessageSchema } from "../opencode/schemas.js";
import { sessionId } from "../opencode/spec.js";
import { parseOrThrow } from "../parse.js";
import { runHerdr } from "./exec.js";
import { parseAgentInfo, type AgentSession } from "./outputs.js";
import { agentGet, agentRead } from "./spec-agent.js";
import type { PaneSource, Spec } from "./spec.js";
import { withTransport, type Transport } from "./transport-args.js";

/**
 * The agent_messages flow: structured transcript read with an honest
 * fallback.
 *
 *   1. resolve the target via `herdr agent get` — recognized agents
 *      carry agent_session{source, agent, kind, value} where value is
 *      the native session id (opencode "ses_..."),
 *   2. opencode targets → one validated call to the local opencode
 *      background service (`opencode api` handles discovery + auth),
 *   3. everything else (no native session, non-opencode session,
 *      remote transport, API unreachable) degrades to the pane-level
 *      `agent read` — and the result SAYS so via channel.
 *
 * agent_read stays the pane view (spinner/blocked states, exactly
 * what is on screen); this is the transcript view (structured turns).
 */

/** The VALIDATED result contract — discriminated on `channel`. */
export const agentMessagesResultSchema = z.discriminatedUnion("channel", [
  z
    .object({
      channel: z.literal("structured"),
      target: z.string().min(1),
      session: z.object({ id: z.string(), source: z.string() }).strict(),
      messages: z.array(transcriptMessageSchema),
    })
    .strict(),
  z
    .object({
      channel: z.literal("pane_fallback"),
      target: z.string().min(1),
      reason: z.string().min(1),
      pane: z
        .object({
          lines: z.number().int().min(1),
          source: z.enum(["visible", "recent", "recent-unwrapped"]),
        })
        .strict(),
      text: z.string(),
    })
    .strict(),
]);
export type AgentMessagesResult = z.output<typeof agentMessagesResultSchema>;

export interface MessagesDeps {
  /** Runs a herdr spec (agent get / agent read). */
  herdr: (s: Spec) => Promise<string>;
  /** Runs an opencode api argv (session.message.list). */
  opencode: (argv: string[]) => Promise<string>;
}

const defaultDeps: MessagesDeps = {
  herdr: runHerdr,
  opencode: execOpenCode,
};

export interface MessagesOpts {
  /** Max messages per page (structured channel), 1..200. */
  limit?: number;
  /** Pane lines to read (fallback channel), 1..2000. */
  lines?: number;
  /** Pane source (fallback channel). */
  source?: PaneSource;
  /** Transport for the herdr calls. */
  transport?: Transport;
}

/**
 * Read an agent's transcript. Throws only when herdr itself fails
 * (unknown target); every other degradation is an explicit
 * channel: "pane_fallback" result that says why.
 */
export async function agentMessages(
  target: string,
  opts: MessagesOpts = {},
  deps: MessagesDeps = defaultDeps,
): Promise<AgentMessagesResult> {
  const info = parseAgentInfo(
    await deps.herdr(withTransport(agentGet(target), opts.transport)),
  );

  const session = info.agent_session;
  if (opts.transport) {
    return paneFallback(deps, target, opts, {
      reason:
        "structured transcripts are local-session only; machine/remote transports read the pane",
    });
  }
  if (!session) {
    return paneFallback(deps, target, opts, {
      reason: `agent ${JSON.stringify(info.name ?? info.pane_id ?? target)} has no native agent_session (pane-level agent)`,
    });
  }
  if (!isNativeOpenCodeSession(session)) {
    return paneFallback(deps, target, opts, {
      reason: `agent_session source ${JSON.stringify(session.source)} is not an opencode session`,
    });
  }

  try {
    const page = await fetchMessages(
      session.value,
      { limit: opts.limit, order: "asc" },
      deps.opencode,
    );
    return parse({
      channel: "structured",
      target,
      session: { id: session.value, source: session.source },
      messages: page.messages,
    });
  } catch (err) {
    return paneFallback(deps, target, opts, {
      reason: `opencode api unreachable: ${(err as Error).message}`,
    });
  }
}

/** opencode sessions: kind "id", agent "opencode", a ses_... value. */
export function isNativeOpenCodeSession(s: AgentSession): boolean {
  return (
    s.agent === "opencode" &&
    s.kind === "id" &&
    sessionId.safeParse(s.value).success
  );
}

async function paneFallback(
  deps: MessagesDeps,
  target: string,
  opts: MessagesOpts,
  why: { reason: string },
): Promise<AgentMessagesResult> {
  // `visible` is the only source herdr guarantees on a WORKING agent
  // (alternate-screen history needs an idle agent) — the fallback must
  // not itself fail because the agent is mid-turn.
  const source = opts.source ?? "visible";
  const read = agentRead(target, {
    lines: opts.lines,
    source,
  });
  const text = await deps.herdr(withTransport(read, opts.transport));
  return parse({
    channel: "pane_fallback",
    target,
    reason: why.reason,
    pane: { lines: opts.lines ?? 200, source },
    text,
  });
}

function parse(result: unknown): AgentMessagesResult {
  return parseOrThrow("agentMessages", agentMessagesResultSchema, result);
}
