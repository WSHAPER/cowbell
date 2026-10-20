import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  agentHealth,
  DEFAULT_RECENT_MS,
  DEFAULT_TAIL,
} from "../../herdr/health.js";
import { withT, transport, json } from "../glue.js";
import { target } from "../shared.js";
import type { TransportParams } from "../shared.js";

/**
 * The health tool: the honest "is this agent actually alive and
 * progressing" signal — three orthogonal signals in one verdict,
 * because agent_status alone cannot see transport-error stalls
 * (idle agent, errored turn) or herdr-restart session deaths.
 */
const DESCRIPTION =
  "One JSON health verdict for an agent, combining three orthogonal signals " +
  "(each alone lies): (1) PROCESS — herdr agent get; agent_not_found means the " +
  "agent process is gone (a herdr restart kills agents while workspaces and " +
  "on-disk artifacts survive; when the target is a pane id the pane is " +
  "cross-checked — restart death leaves the pane, recovery is a fresh " +
  "agent_start + reconstruction directive). (2) STATE — the detected " +
  "agent_status WITH its blind spot: pane-level agents (no native " +
  "agent_session, e.g. model-spawned mini opencode) detect state by pane " +
  "scraping and report idle forever; the response says so instead of lying. " +
  "(3) TRANSCRIPT ERROR TAIL — the last N structured events from the local " +
  "opencode API; error-ish events (transport timeouts, API errors, aborted " +
  "turns) surface with timestamps, so 'idle + recent transport error' is " +
  "visible as the silent-stall signature. Text signatures match " +
  "machine-generated event messages only (system/synthetic/shell) — never " +
  "user or assistant prose, which narrates or quotes errors without " +
  "stalling. Unavailable, with the reason, for " +
  "pane-level/non-opencode agents, machine/remote transports, or an " +
  "unreachable API. VERDICT DERIVATION (conservative, first match wins): " +
  "dead := agent get fails with agent_not_found (pane/process gone); " +
  "stalled-suspect := state idle|unknown AND a recent error event in the " +
  "tail — recent means within recent_ms of the check OR the error is the " +
  "newest recorded act (idle markers do not count as acts; a turn that " +
  "ended on an error with nothing after it stays suspect however long ago); " +
  "progressing := herdr reports working (listed errors do " +
  "not outrank it); healthy := everything else (alive, no adverse evidence; " +
  "non-recent errors stay listed in the tail).";

type HealthParams = TransportParams & {
  target: string;
  tail?: number;
  recent_ms?: number;
};

export function registerAgentHealthTools(server: McpServer): void {
  server.tool(
    "agent_health",
    DESCRIPTION,
    withT({
      target,
      tail: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .describe(
          `Structured transcript events to scan for the error tail (default ${DEFAULT_TAIL})`,
        ),
      recent_ms: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          `Recency window for the stalled-suspect test in ms (default ${DEFAULT_RECENT_MS} = 15 min); an error older than this still counts when it is the newest recorded act`,
        ),
    }),
    async (v: HealthParams) =>
      json(
        await agentHealth(v.target, {
          tail: v.tail,
          recentMs: v.recent_ms,
          transport: transport(v),
        }),
      ),
  );
}
