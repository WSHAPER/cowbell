import { z } from "zod";
import { runHerdr } from "../herdr/exec.js";
import { AGENT_KINDS } from "../herdr/spec-agent.js";
import type {
  AgentKind,
  AgentStatus,
  PromptDelivery,
} from "../herdr/spec-agent.js";
import type { PaneSource, Spec } from "../herdr/spec.js";
import { withTransport, type Transport } from "../herdr/transport-args.js";
import {
  TransportSchema,
  toTransport,
  type TransportParams,
} from "./transport.js";

const machine = z
  .string()
  .optional()
  .describe("Registered machine label/id — run there instead of local");
const remote = z
  .string()
  .optional()
  .describe("SSH target — run on a remote herdr session instead of local");

/** Merge transport params into a shape and derive the parsed transport. */
export const withT = <S extends z.ZodRawShape>(shape: S) => ({
  ...shape,
  machine,
  remote,
});
export const transport = (v: {
  machine?: string;
  remote?: string;
}): Transport | undefined =>
  toTransport(
    TransportSchema.parse({ machine: v.machine, remote: v.remote }) ??
      undefined,
  );

export const text = (t: string) => ({
  content: [{ type: "text" as const, text: t }],
});
export const exec = (s: Spec, t?: Transport) => runHerdr(withTransport(s, t));
export const json = (v: unknown) => text(JSON.stringify(v, null, 2));

export const paneId = z.string().describe("Pane id, e.g. w36:p1");
export const target = z.string().describe("Agent name or hosting pane id");

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
