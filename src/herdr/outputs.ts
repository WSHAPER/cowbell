import { z } from "zod";
import { parseJsonOrThrow, parseOrThrow } from "../parse.js";

/**
 * OUTPUT contracts for the herdr commands whose stdout cowbell parses
 * (the counterpart to schemas.ts, which guards inputs).
 *
 * herdr prints one JSON object per command on stdout:
 *
 *   {"id":"cli:agent:get","result":{"agent":{...},"type":"agent_info"}}
 *   {"id":"cli:agent:list","result":{"agents":[...],"type":"agent_list"}}
 *
 * These envelopes are EXTERNAL surfaces, so the schemas validate the
 * fields cowbell relies on and `.passthrough()` the rest — a new
 * herdr field must not break transcript reads. A renamed/removed
 * contract field fails loud right here.
 */

/** The native session reference herdr attaches to recognized agents. */
const agentSessionSchema = z
  .object({
    /** Agent kind that owns the session, e.g. "opencode". */
    agent: z.string().min(1),
    /** Reference kind; "id" means `value` is the native session id. */
    kind: z.string().min(1),
    /** Where herdr learned it, e.g. "herdr:opencode". */
    source: z.string().min(1),
    /** The native session id, e.g. an opencode "ses_..." id. */
    value: z.string().min(1),
  })
  .passthrough();
export type AgentSession = z.output<typeof agentSessionSchema>;

/** One agent entry as printed by `agent get` / `agent list`. */
const agentEntrySchema = z
  .object({
    agent: z.string().min(1),
    agent_session: agentSessionSchema.optional(),
    agent_status: z.string().optional(),
    pane_id: z.string().optional(),
    workspace_id: z.string().optional(),
    cwd: z.string().optional(),
    name: z.string().optional(),
  })
  .passthrough();
export type AgentEntry = z.output<typeof agentEntrySchema>;

const agentInfoEnvelope = z
  .object({
    id: z.string(),
    result: z
      .object({
        agent: agentEntrySchema,
        type: z.literal("agent_info"),
      })
      .passthrough(),
  })
  .passthrough();

const agentListEnvelope = z
  .object({
    id: z.string(),
    result: z
      .object({
        agents: z.array(agentEntrySchema),
        type: z.literal("agent_list"),
      })
      .passthrough(),
  })
  .passthrough();

const agentListResult = z
  .object({
    agents: z.array(agentEntrySchema),
    type: z.literal("agent_list"),
  })
  .passthrough();

const DRIFT = "herdr output drifted from the expected shape";

/** Parse `herdr agent get <target>` stdout. Throws on contract drift. */
export function parseAgentInfo(stdout: string): AgentEntry {
  return parseJsonOrThrow("parseAgentInfo", agentInfoEnvelope, stdout, DRIFT)
    .result.agent;
}

/** Parse `herdr agent list` stdout. Throws on contract drift. */
export function parseAgentList(stdout: string): AgentEntry[] {
  return parseJsonOrThrow("parseAgentList", agentListEnvelope, stdout, DRIFT)
    .result.agents;
}

/**
 * Parse an `agent.list` RESULT (the `result` half of the envelope) —
 * the socket API returns the same body the CLI wraps, and the wait
 * registry reads it straight off the socket.
 */
export function parseAgentListResult(result: unknown): AgentEntry[] {
  return parseOrThrow("parseAgentListResult", agentListResult, result, DRIFT)
    .agents;
}
