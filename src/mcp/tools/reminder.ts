import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WaitRegistry } from "../../herdr/waits.js";
import { json } from "../glue.js";
import { reminderStartShape } from "../shared.js";
import type { ReminderStartParams } from "../shared.js";

/**
 * SCHEDULED SELF-REMINDERS — the registry's third wait kind, whose
 * terminal act is an injection: at the scheduled time the registry
 * calls the opencode session.prompt API on the target session. No
 * MCP push channel reaches an opencode session (the wait_next
 * research verdict, anomalyco/opencode#48855), so the injected
 * prompt IS the wakeup. Deliberately no transport params: the
 * injection rides the local opencode background service.
 */

/** opencode's documented per-request session identity channel. */
const SESSION_META_KEY = "ai.opencode/sessionID";

/**
 * Explicit param wins (cross-session reminders); then the calling
 * session from request _meta; else an honest start error — arming a
 * reminder that cannot resolve its target would only ever fail at
 * fire time.
 */
function resolveCallingSession(
  explicit: string | undefined,
  meta: unknown,
): string {
  if (explicit !== undefined) return explicit;
  const fromMeta = (meta as Record<string, unknown> | undefined)?.[
    SESSION_META_KEY
  ];
  if (typeof fromMeta === "string" && fromMeta.length > 0) return fromMeta;
  throw new Error(
    "reminder_start: cannot resolve the calling session — pass session_id explicitly, " +
      "or call from an opencode session that sends the ai.opencode/sessionID request meta",
  );
}

export function registerReminderTools(
  server: McpServer,
  waits: WaitRegistry,
): void {
  server.tool(
    "reminder_start",
    "Arm a SCHEDULED SELF-REMINDER for the calling session: at the chosen time cowbell INJECTS `text` " +
      "into that opencode session via the session.prompt API (delivery steer by default — it starts a " +
      "turn on an idle session and lands in a busy one), which is what wakes you: no MCP push channel " +
      "exists (anomalyco/opencode#48855), the injected prompt IS the wakeup. Schedule: exactly one of " +
      "in_ms (relative) | at_ms (absolute epoch ms, strictly future); recurring every_ms lands with the " +
      "fleet wave. Target: the calling session by default (resolved from the request's " +
      "ai.opencode/sessionID meta); pass session_id to remind another session. SESSION-OWNED like every " +
      "wait: the reminder lives in-memory in THIS cowbell process and DIES WITH IT (an opencode server " +
      "restart or config reload drops pending reminders) — a durability tier (opencode automations) is a " +
      "deliberate follow-up, not a property of this tool. Returns the reminder record (wait_id — poll " +
      "wait_status or drain wait_next; cancel via wait_cancel; kind 'reminder', target = the session id, " +
      "until_ms hard end bound defaulting to started + 7 days). A failed fire (e.g. background service " +
      "down at fire time) records state 'failed' + reason after its bounded retries. NOTE: this MUTATES " +
      "the target conversation on a timer — that is the feature. machine/remote do not apply.",
    reminderStartShape,
    (v: ReminderStartParams, extra: { _meta?: Record<string, unknown> }) =>
      json(
        waits.reminderStart({
          session: resolveCallingSession(v.session_id, extra._meta),
          text: v.text,
          in_ms: v.in_ms,
          at_ms: v.at_ms,
          every_ms: v.every_ms,
          until_ms: v.until_ms,
          delivery: v.delivery,
        }),
      ),
  );
}
