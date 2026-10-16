import { z } from "zod";

/**
 * Input contracts for the canonical spec builders.
 *
 * The MCP layer validates its own tool schemas; these schemas guard
 * the spec layer itself so EVERY caller (MCP tools, future CLI,
 * scripts) gets identical enforcement. Cheap, parse-once, fail loud
 * with the exact parameter named.
 */

export const paneId = z
  .string()
  .min(1)
  .regex(/^w[a-zA-Z0-9]+:p\d+$/, "pane id must look like w3B:p1");

export const workspaceId = z
  .string()
  .min(1)
  .regex(/^w[a-zA-Z0-9]+$/, "workspace id must look like w3B");

export const agentTarget = z
  .string()
  .min(1, "target must be a name or hosting pane id");

export const nonEmptyText = z.string().min(1);

const optionalLabel = z.string().min(1).optional();

const cwdPath = z.string().min(1).regex(/^\//, "cwd must be an absolute path");

export const timeoutMs = z.number().int().positive();

const lines = z.number().int().min(1).max(2000);

const paneSource = z.enum(["visible", "recent", "recent-unwrapped"]);

export const agentStatus = z.enum([
  "idle",
  "working",
  "blocked",
  "done",
  "unknown",
]);

/**
 * The canonical agent-status vocabulary — the zod enum above, unzipped.
 * schemas.ts owns it because BOTH the CLI spec layer (agent wait
 * --until) and the raw socket wire layer (pane.agent_status_changed)
 * validate against it; spec-agent.ts re-exports for its consumers.
 */
export const AGENT_STATUSES = agentStatus.options;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

export const agentKind = z.enum([
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
]);

export const readOpts = z
  .object({
    lines: lines.optional(),
    source: paneSource.optional(),
  })
  .strict()
  .default({});

export const promptOpts = z
  .object({
    wait: z.boolean().optional(),
    until: z.array(agentStatus).min(1).optional(),
    timeoutMs: timeoutMs.optional(),
  })
  .strict()
  .default({});

/**
 * When a prompt flow submits: `now` (immediately, the default) or
 * `idle` (wait for the agent to go idle first, then submit — the
 * queue-of-one semantics; no general queue, no persisted state).
 */
const deliverWhen = z.enum(["now", "idle"]);

export const promptFlowOpts = z
  .object({
    deliverWhen: deliverWhen.optional(),
    wait: z.boolean().optional(),
    until: z.array(agentStatus).min(1).optional(),
    timeoutMs: timeoutMs.optional(),
  })
  .strict()
  .default({})
  .refine(
    (v) =>
      !(
        v.deliverWhen === "idle" &&
        (v.wait !== undefined || v.until !== undefined)
      ),
    {
      message:
        "deliverWhen 'idle' cannot be combined with wait/until — the flow already waits for idle before submitting",
    },
  );

export const createOpts = z
  .object({
    cwd: cwdPath,
    label: optionalLabel,
    focus: z.boolean().optional(),
  })
  .strict();

export const transport = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("machine"), label: nonEmptyText }).strict(),
  z.object({ kind: z.literal("remote"), sshTarget: nonEmptyText }).strict(),
]);

/**
 * A model selector for agent start, e.g. "zai/glm-5.3" or
 * "zai/glm-5.3#high". Deliberately ONLY non-empty — it is never
 * validated against a live model list: spawn must stay offline-safe,
 * discovery is models_list's job (a separate, read-only tool).
 */
const agentModelId = z.string().min(1);

export const agentStartOpts = z
  .object({
    timeoutMs: timeoutMs.optional(),
    model: agentModelId.optional(),
    args: z
      .array(
        z
          .string()
          .min(1)
          .regex(/^[^\p{C}]*$/u, "no control characters"),
      )
      .min(1)
      .optional(),
  })
  .strict()
  .optional()
  .default({})
  .refine((v) => !(v.model !== undefined && v.args !== undefined), {
    message:
      "model and args are mutually exclusive — model compiles per kind to the agent's model flag (`mini -m` for opencode, `-m` otherwise) after `--`; pass args instead when you need full control of the agent argv",
  });

export const worktreeCreateOpts = z
  .object({
    workspace: workspaceId.optional(),
    cwd: cwdPath.optional(),
    branch: z
      .string()
      .min(1)
      .regex(/^[^\s\p{C}]+$/u, "no whitespace or control characters"),
    base: nonEmptyText.optional(),
    label: optionalLabel,
    focus: z.boolean().optional(),
  })
  .strict()
  .refine((v) => v.workspace !== undefined || v.cwd !== undefined, {
    message: "either workspace or cwd is required",
  });
