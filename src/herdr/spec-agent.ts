import { z } from "zod";
import { parseOrThrow as v } from "../parse.js";
import * as sc from "./schemas.js";
import type { AgentStatus } from "./schemas.js";
import type { PaneSource, Spec } from "./spec.js";

/**
 * `herdr agent` builders (targets accept pane ids that host agents —
 * verified 2026-10-06).
 */

export { AGENT_STATUSES } from "./schemas.js";
export type { AgentStatus } from "./schemas.js";

/** Agent status vocabulary herdr accepts for `--until` — re-exported
 * from schemas.ts, the canonical home (see AGENT_STATUSES there). */

/** herdr agent kinds (from `agent start --help`). */
export const AGENT_KINDS = [
  "pi",
  "claude",
  "codex",
  "gemini",
  "cursor",
  "devin",
  "agy",
  "cline",
  "omp",
  "mastracode",
  "opencode",
  "copilot",
  "kimi",
  "kiro",
  "droid",
  "amp",
  "grok",
  "hermes",
  "kilo",
  "qodercli",
  "qwen",
  "letta",
  "maki",
  "muse",
] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];

export function agentList(): Spec {
  return { argv: ["herdr", "agent", "list"], surface: "agent list" };
}

export function agentGet(target: string): Spec {
  target = v("agentGet", sc.agentTarget, target);
  return { argv: ["herdr", "agent", "get", target], surface: "agent get" };
}

export function agentRead(
  target: string,
  opts: { lines?: number; source?: PaneSource } = {},
): Spec {
  target = v("agentRead", sc.agentTarget, target);
  opts = v("agentRead", sc.readOpts, opts);
  const argv = ["herdr", "agent", "read", target];
  if (opts.source !== undefined) argv.push("--source", opts.source);
  const lines = opts.lines ?? 200;
  argv.push("--lines", String(lines));
  return { argv, surface: "agent read" };
}

/** Submit a prompt. NOTE: `agent send` does not exist on 0.9.5. */
export function agentPrompt(
  target: string,
  text: string,
  opts: { wait?: boolean; until?: AgentStatus[]; timeoutMs?: number } = {},
): Spec {
  target = v("agentPrompt", sc.agentTarget, target);
  text = v("agentPrompt", sc.nonEmptyText, text);
  opts = v("agentPrompt", sc.promptOpts, opts);
  const argv = ["herdr", "agent", "prompt", target, text];
  if (opts.wait) argv.push("--wait");
  for (const s of opts.until ?? []) argv.push("--until", s);
  if (opts.timeoutMs !== undefined)
    argv.push("--timeout", String(opts.timeoutMs));
  return { argv, surface: "agent prompt" };
}

/** When a prompt flow submits the text. */
export type PromptDelivery = "now" | "idle";

/**
 * The queue-of-one prompt flow: specs to run IN ORDER.
 *
 * `now` (default) is a single `agent prompt` — identical to
 * agentPrompt(). `idle` first blocks on `agent wait --until idle`
 * (herdr's event-driven wait; timeoutMs guards THAT wait) and only
 * then submits the prompt, so it lands as the agent's next input.
 *
 * Strictly two calls, no queue, no file state, no daemon — cowbell
 * stays a stateless validated wrapper. `idle` + wait/until is a
 * validation error (the flow already owns the waiting).
 */
export function agentPromptFlow(
  target: string,
  text: string,
  opts: {
    deliverWhen?: PromptDelivery;
    wait?: boolean;
    until?: AgentStatus[];
    timeoutMs?: number;
  } = {},
): Spec[] {
  target = v("agentPromptFlow", sc.agentTarget, target);
  text = v("agentPromptFlow", sc.nonEmptyText, text);
  opts = v("agentPromptFlow", sc.promptFlowOpts, opts);
  if (opts.deliverWhen === "idle") {
    return [
      agentWait(target, ["idle"], opts.timeoutMs),
      agentPrompt(target, text),
    ];
  }
  const { deliverWhen: _deliverWhen, ...promptOpts } = opts;
  return [agentPrompt(target, text, promptOpts)];
}

/** Block until a status. NOTE: the flag is `--until`, not `--status`. */
export function agentWait(
  target: string,
  statuses: AgentStatus[],
  timeoutMs?: number,
): Spec {
  target = v("agentWait", sc.agentTarget, target);
  statuses = v("agentWait", z.array(sc.agentStatus).min(1), statuses);
  if (timeoutMs !== undefined)
    timeoutMs = v("agentWait", sc.timeoutMs, timeoutMs);
  const argv = ["herdr", "agent", "wait", target];
  for (const s of statuses) argv.push("--until", s);
  if (timeoutMs !== undefined) argv.push("--timeout", String(timeoutMs));
  return { argv, surface: "agent wait" };
}

/**
 * Start an agent. On 0.9.5 this REQUIRES a pre-existing pane
 * (`--kind KIND --pane ID`) — there is no `--cwd`/`--workspace`.
 * Pair with workspaceCreate + pane targeting.
 *
 * `model` compiles per kind: opencode spawns `mini -m <model>` (the
 * full TUI takes NO model flag — verified live on v2.0.27, which
 * rejects `-m`/`--model` on the root command; `mini` is the
 * interactive surface that accepts one), every other kind gets the
 * common `-m <model>`. The agent binary owns the flag vocabulary;
 * herdr argv stays authoritative. `model` is exclusive with `args` —
 * both at once is a validation error, no silent precedence. It is
 * NOT checked against a live model list: spawn stays offline-safe,
 * discovery is models_list's job (an unknown selector starts fine
 * and only fails when first used).
 */
export function agentStart(
  name: string,
  kind: AgentKind,
  pane: string,
  opts: { timeoutMs?: number; model?: string; args?: string[] } = {},
): Spec {
  if (arguments.length > 4) {
    throw new Error(
      `agentStart takes at most 4 arguments (name, kind, pane, opts) — got ${arguments.length}. ` +
        `Pass extra agent argv as opts.args, not a 5th positional argument.`,
    );
  }
  name = v("agentStart", sc.nonEmptyText, name);
  kind = v("agentStart", sc.agentKind, kind);
  pane = v("agentStart", sc.paneId, pane);
  opts = v("agentStart", sc.agentStartOpts, opts);
  const argv = [
    "herdr",
    "agent",
    "start",
    name,
    "--kind",
    kind,
    "--pane",
    pane,
  ];
  if (opts.timeoutMs !== undefined)
    argv.push("--timeout", String(opts.timeoutMs));
  if (opts.model !== undefined) argv.push("--", ...modelArgv(kind, opts.model));
  else if (opts.args !== undefined) argv.push("--", ...opts.args);
  return { argv, surface: "agent start" };
}

/** Per-kind argv a `model` selector compiles to (see agentStart). */
function modelArgv(kind: AgentKind, model: string): string[] {
  return kind === "opencode" ? ["mini", "-m", model] : ["-m", model];
}

export function agentFocus(target: string): Spec {
  target = v("agentFocus", sc.agentTarget, target);
  return { argv: ["herdr", "agent", "focus", target], surface: "agent focus" };
}

export function agentRename(target: string, name: string): Spec {
  target = v("agentRename", sc.agentTarget, target);
  name = v("agentRename", sc.nonEmptyText, name);
  return {
    argv: ["herdr", "agent", "rename", target, name],
    surface: "agent rename",
  };
}
