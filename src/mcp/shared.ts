import { z } from "zod";
import { runHerdr } from "../herdr/exec.js";
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
  args?: string[];
};
export type RenameParams = TransportParams & { target: string; name: string };
