import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { WaitRegistry } from "../../herdr/waits.js";
import { json, waitStartShape } from "../shared.js";
import type {
  WaitStartParams,
  WaitStatusParams,
  WaitCancelParams,
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
  registerWaitQueryTools(server, waits);
}

/** wait_status + wait_cancel: the observation/abandonment surface. */
function registerWaitQueryTools(server: McpServer, waits: WaitRegistry): void {
  server.tool(
    "wait_status",
    "Report one wait (pass wait_id) or every wait owned by THIS cowbell process (omit it): " +
      "{wait_id, target, pane_id, until, state: pending|fired|timed_out, result?, started_ms}. " +
      "fired carries result (the status that fired); timed_out carries none. All state is " +
      "in-memory in this process — waits owned by other sessions or cowbell instances are " +
      "invisible by design (there is no registry on disk or in the herdr server), and everything " +
      "is gone when the process dies.",
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
    "Cancel waits owned by THIS cowbell process — one ({wait_id}) or all ({all: true}), exactly " +
      "one of the two. Cancelling closes the subscription and forgets the wait (it disappears " +
      "from wait_status; fired/timed_out waits are simply forgotten). Never touches another " +
      "process's or session's waits — ownership is process-scoped by construction.",
    {
      wait_id: z.string().min(1).optional(),
      all: z.boolean().optional(),
    },
    (v: WaitCancelParams) => Promise.resolve(json(waits.waitCancel(v))),
  );
}
