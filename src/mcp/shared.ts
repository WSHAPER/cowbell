import { z } from "zod";
import { AGENT_KINDS, AGENT_STATUSES } from "../herdr/spec-agent.js";
import type {
  AgentKind,
  AgentStatus,
  PromptDelivery,
} from "../herdr/spec-agent.js";
import type { PaneSource } from "../herdr/spec.js";
import { withT } from "./glue.js";
import type { TransportParams } from "./transport.js";

export type { TransportParams } from "./transport.js";

export const paneId = z.string().describe("Pane id, e.g. w36:p1");
export const target = z.string().describe("Agent name or hosting pane id");

/**
 * Pane-read source vocabulary — herdr's read modes. Named once here
 * (the AGENT_KINDS/AGENT_STATUSES precedent) because THREE
 * registrations consume it: pane_read and agent_read tool params
 * (optional) and the agent_messages pane_fallback result contract
 * (required). spec.ts's PaneSource is the type twin.
 */
const READ_SOURCES = ["visible", "recent", "recent-unwrapped"] as const;
export const readSourceSchema = z.enum(READ_SOURCES);

/**
 * When agent_prompt submits the text — the MCP twin of
 * PromptDelivery in spec-agent.ts: `now` (immediately, the default)
 * or `idle` (queue-of-one: wait for idle first, then submit).
 */
const DELIVER_WHEN = ["now", "idle"] as const;
export const deliverWhenSchema = z
  .enum(DELIVER_WHEN)
  .default("now")
  .describe("now: submit immediately; idle: wait for idle, then submit");

/**
 * agent_start's REGISTERED input shape, exported (not inline in
 * server.ts) so the schema↔StartParams linkage can be compile-pinned
 * via z.infer in the test suite — the F1 lesson: zod strips an
 * undeclared key silently at runtime, so the only honest guard
 * against schema/type divergence is that dropping a key from EITHER
 * side fails `npm run typecheck`.
 */
export const agentStartShape = withT({
  name: z.string(),
  kind: z.enum(AGENT_KINDS),
  pane: paneId,
  timeout_ms: z.number().int().positive().optional(),
  model: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Model selector, e.g. 'zai/glm-5.3' (optional '#variant') — compiled per kind after `--` " +
        "(`mini -m <model>` for opencode: its full TUI takes no model flag, mini is the interactive " +
        "surface that does; `-m <model>` for other kinds). Mutually exclusive with args. NOT validated " +
        "against a live model list (spawn stays offline-safe) — an unknown selector still spawns and only " +
        "fails when first used, so call models_list first to discover selectors. NOTE: opencode model " +
        "spawns run the minimal interface; herdr links native agent_session only for the full TUI, so " +
        "agent_messages on such agents degrades to pane_fallback",
    ),
  args: z.array(z.string().min(1)).min(1).optional(),
});

export type IdParams = TransportParams & { id: string };
export type CreateWorkspaceParams = TransportParams & {
  cwd: string;
  label?: string;
  focus?: boolean;
};
export type PaneParams = TransportParams & { pane: string };
export type ReadPaneParams = TransportParams & {
  pane: string;
  lines?: number;
  source?: PaneSource;
};
export type SendTextParams = TransportParams & { pane: string; text: string };
export type SendKeysParams = TransportParams & { pane: string; keys: string[] };
export type RunParams = TransportParams & { pane: string; command: string };
export type TargetParams = TransportParams & { target: string };
export type ReadAgentParams = TransportParams & {
  target: string;
  lines?: number;
  source?: PaneSource;
};
export type PromptParams = TransportParams & {
  target: string;
  text: string;
  deliver_when?: PromptDelivery;
  wait?: boolean;
  until?: AgentStatus[];
  timeout_ms?: number;
};
export type MessagesParams = TransportParams & {
  target: string;
  limit?: number;
  lines?: number;
};
export type WaitParams = TransportParams & {
  target: string;
  statuses: AgentStatus[];
  timeout_ms?: number;
};

/**
 * wait_start's REGISTERED input shape — timeout_ms is REQUIRED (the
 * wait never outlives it) and there are deliberately NO transport
 * params: waits subscribe to the LOCAL herdr socket, so machine/remote
 * do not apply.
 */
export const waitStartShape = {
  target: z
    .string()
    .describe(
      "Agent name or hosting pane id — resolved via the local session's agent list",
    ),
  until: z
    .array(z.enum(AGENT_STATUSES))
    .min(1)
    .describe(
      'Statuses that fire the wait, e.g. ["idle"] or ["blocked","done"]',
    ),
  timeout_ms: z
    .number()
    .int()
    .positive()
    .describe(
      "REQUIRED client-side deadline in ms — the wait is abandoned as timed_out when it passes",
    ),
};
export type WaitStartParams = {
  target: string;
  until: AgentStatus[];
  timeout_ms: number;
};
export type WaitStatusParams = { wait_id?: string };
export type WaitCancelParams = { wait_id?: string; all?: boolean };

/**
 * file_wait_start's REGISTERED input shape — the report-marker watch.
 * No transport params, like the rest of the wait family: the watched
 * file is read by THIS process, on THIS machine, by construction.
 * min_bytes is deliberately absent: marker + quiet-window subsumes it
 * (a below-threshold file that goes quiet with the marker present
 * SHOULD fire — the writer finished), so the knob would only add a
 * way to be wrong.
 */
export const fileWaitStartShape = {
  path: z
    .string()
    .min(1)
    .describe(
      "Absolute path to the report file — it must already exist; a missing path fails the call immediately",
    ),
  marker: z
    .string()
    .min(1)
    .describe(
      "Regular expression (source string, compiled with the m flag so ^/$ anchor per line) tested " +
        "against each line — regex over literal strings for heading-drift tolerance, e.g. " +
        "'^#{1,6}\\\\s*[Ss]tatus.*\\\\bdone\\\\b' survives '## Residual candidates' style drift",
    ),
  stability_ms: z
    .number()
    .int()
    .positive()
    .describe(
      "REQUIRED quiet window: the file's mtime+size must be unchanged for this long before the wait " +
        "fires — the cure for progressively-written reports firing early on a partial marker",
    ),
  timeout_ms: z
    .number()
    .int()
    .positive()
    .describe(
      "REQUIRED client-side deadline in ms — the wait is abandoned as timed_out when it passes",
    ),
};
export type FileWaitStartParams = {
  path: string;
  marker: string;
  stability_ms: number;
  timeout_ms: number;
};

export type StartParams = TransportParams & {
  name: string;
  kind: AgentKind;
  pane: string;
  timeout_ms?: number;
  /** Compiles per kind to the agent's model flag; exclusive with args. */
  model?: string;
  args?: string[];
};
export type RenameParams = TransportParams & { target: string; name: string };
