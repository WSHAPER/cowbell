import { connect, type Socket } from "node:net";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { AGENT_STATUSES, type AgentStatus } from "./schemas.js";

/**
 * Raw herdr socket client — the layer UNDER the CLI specs.
 *
 * Wire contract (herdr 0.9.5, socket protocol 22; pinned by
 * tests/fixtures/herdr-events-surface.json, regenerate: npm run
 * reference:herdr-events):
 *
 *   - newline-delimited JSON over a local unix socket
 *   - ONE request per connection: a request line answered with a
 *     response ends that connection's request phase, and a second
 *     request on a live event stream CLOSES it (verified live:
 *     outcome="stream_closed") — authoritative reads during a wait
 *     always go out on their own short-lived connection
 *   - `events.subscribe` keeps the connection open: the
 *     subscription_started response first, then pushed {event, data}
 *     lines; lifecycle subscriptions do NOT replay past events
 *   - `events_lost`: when a subscriber falls behind retained history
 *     the server sends an error response carrying the original
 *     request id and error.code "events_lost", then closes that
 *     subscription connection — the client must resubscribe and
 *     reconcile via authoritative reads, never replay buffers
 */

/** The pinned drift tokens — cross-checked against the captured schema. */
export const EVENTS_SUBSCRIBE_METHOD = "events.subscribe";
export const AGENT_STATUS_EVENT = "pane.agent_status_changed";

/** The subscription entry we emit for one pane (all statuses). */
export function agentStatusSubscription(paneId: string): {
  type: string;
  pane_id: string;
  agent_status: null;
} {
  return { type: AGENT_STATUS_EVENT, pane_id: paneId, agent_status: null };
}

/** Socket error carrying the herdr `error.code` when there was one. */
export class HerdrSocketError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
  ) {
    super(message);
    this.name = "HerdrSocketError";
  }
}

/**
 * Socket path resolution, mirroring herdr's own order minus the CLI
 * flags: HERDR_SOCKET_PATH, then a HERDR_SESSION named session, then
 * the default session socket.
 */
export function herdrSocketPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.HERDR_SOCKET_PATH) return env.HERDR_SOCKET_PATH;
  const config = path.join(homedir(), ".config", "herdr");
  if (env.HERDR_SESSION)
    return path.join(config, "sessions", env.HERDR_SESSION, "herdr.sock");
  return path.join(config, "herdr.sock");
}

// -- wire schemas -----------------------------------------------------------

const successEnvelope = z
  .object({ id: z.string(), result: z.unknown() })
  .passthrough();

const errorEnvelope = z
  .object({
    id: z.string(),
    error: z.object({ code: z.string(), message: z.string() }).passthrough(),
  })
  .passthrough();

/** One pushed pane.agent_status_changed line (fields we rely on). */
export interface AgentStatusEvent {
  pane_id: string;
  workspace_id: string;
  agent_status: AgentStatus;
}

const statusEventEnvelope = z.object({
  event: z.literal(AGENT_STATUS_EVENT),
  data: z
    .object({
      pane_id: z.string(),
      workspace_id: z.string(),
      agent_status: z.enum(AGENT_STATUSES),
    })
    .passthrough(),
});

/** What one wire line can be, in classification order. */
type WireLine =
  | { kind: "error"; code: string; message: string }
  | { kind: "status_event"; event: AgentStatusEvent }
  | { kind: "success"; result: unknown }
  | { kind: "unknown" };

function parseWireLine(line: string): WireLine {
  const parsed: unknown = JSON.parse(line);
  const err = errorEnvelope.safeParse(parsed);
  if (err.success)
    return {
      kind: "error",
      code: err.data.error.code,
      message: err.data.error.message,
    };
  const event = statusEventEnvelope.safeParse(parsed);
  if (event.success) return { kind: "status_event", event: event.data.data };
  const ok = successEnvelope.safeParse(parsed);
  if (ok.success) return { kind: "success", result: ok.data.result };
  return { kind: "unknown" }; // forward compat: ignore unrecognized shapes
}

/** Split a byte stream into newline-delimited JSON lines. */
class LineReader {
  private buf = "";
  constructor(private readonly onLine: (line: string) => void) {}
  push(chunk: Buffer): void {
    this.buf += chunk.toString("utf8");
    let at: number;
    while ((at = this.buf.indexOf("\n")) !== -1) {
      const line = this.buf.slice(0, at);
      this.buf = this.buf.slice(at + 1);
      if (line.trim()) this.onLine(line);
    }
  }
}

function socketError(
  where: string,
  code: string,
  message: string,
): HerdrSocketError {
  return new HerdrSocketError(
    `herdr socket ${where} error ${code}: ${message}`,
    code,
  );
}

// -- one-shot requests ------------------------------------------------------

/**
 * Send ONE request on a fresh connection and resolve its result.
 * Rejects with HerdrSocketError (code set when herdr answered with an
 * error envelope). The socket is always destroyed afterwards.
 */
export function herdrSocketRequest(
  method: string,
  params: unknown,
  opts: { socketPath?: string; timeoutMs?: number } = {},
): Promise<unknown> {
  const socketPath = opts.socketPath ?? herdrSocketPath();
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    const timer = setTimeout(
      () =>
        reject(
          new HerdrSocketError(
            `herdr socket ${method} timed out after ${opts.timeoutMs ?? 5000}ms on ${socketPath}`,
            "timeout",
          ),
        ),
      opts.timeoutMs ?? 5000,
    );
    const settle = (fn: () => void) => {
      clearTimeout(timer);
      socket.destroy();
      fn();
    };
    socket.on("error", (err) =>
      settle(() =>
        reject(
          new HerdrSocketError(
            `herdr socket ${method} failed on ${socketPath}: ${err.message}`,
            "connection_error",
          ),
        ),
      ),
    );
    const reader = new LineReader((line) => {
      const wire = parseWireLine(line);
      if (wire.kind === "error")
        settle(() => reject(socketError(method, wire.code, wire.message)));
      else if (wire.kind === "success") settle(() => resolve(wire.result));
    });
    socket.on("data", (d) => reader.push(d));
    socket.on("connect", () =>
      socket.write(
        `${JSON.stringify({ id: `cowbell:${method}`, method, params })}\n`,
      ),
    );
  });
}

// -- event streams ----------------------------------------------------------

export interface AgentStatusStreamHandlers {
  onEvent: (e: AgentStatusEvent) => void;
  /**
   * The stream died AFTER it was live: an events_lost error or a
   * transport-level close/error. Buffered events are gone — recover
   * by resubscribing and reconciling from authoritative reads.
   */
  onLost: (code: string, message: string) => void;
}

export interface AgentStatusStream {
  close(): void;
}

/**
 * The subscription half of the wire, one instance per open stream:
 * connecting -> subscribed (after subscription_started) -> dead.
 */
class AgentStatusSubscription {
  private state: "connecting" | "subscribed" | "dead" = "connecting";

  constructor(
    private readonly socket: Socket,
    private readonly handlers: AgentStatusStreamHandlers,
    private readonly timer: ReturnType<typeof setTimeout>,
  ) {}

  start(
    resolve: (stream: AgentStatusStream) => void,
    reject: (err: HerdrSocketError) => void,
  ): void {
    this.reject = reject;
    const reader = new LineReader((line) => {
      try {
        this.onLine(line, resolve);
      } catch (err) {
        this.fail("protocol_drift", String(err));
      }
    });
    this.socket.on("data", (d) => reader.push(d));
    this.socket.on("error", (err) =>
      this.fail("connection_error", err.message),
    );
    this.socket.on("close", () =>
      this.fail("connection_closed", "subscription connection closed"),
    );
  }

  sendSubscribe(paneId: string): void {
    this.socket.write(
      `${JSON.stringify({
        id: `cowbell:subscribe:${paneId}`,
        method: EVENTS_SUBSCRIBE_METHOD,
        params: { subscriptions: [agentStatusSubscription(paneId)] },
      })}\n`,
    );
  }

  private reject: (err: HerdrSocketError) => void = () => {};

  private onLine(
    line: string,
    resolve: (stream: AgentStatusStream) => void,
  ): void {
    const wire = parseWireLine(line);
    if (wire.kind === "error") this.fail(wire.code, wire.message);
    else if (wire.kind === "status_event") this.deliver(wire.event);
    else if (wire.kind === "success") this.onResponse(wire.result, resolve);
  }

  /** While live, events flow; before the ack they are premature. */
  private deliver(event: AgentStatusEvent): void {
    if (this.state === "subscribed") this.handlers.onEvent(event);
  }

  private onResponse(
    result: unknown,
    resolve: (stream: AgentStatusStream) => void,
  ): void {
    if (this.state !== "connecting") return; // late response: not ours
    if ((result as { type?: unknown })?.type !== "subscription_started") {
      this.fail(
        "protocol_drift",
        `expected subscription_started ack, got ${JSON.stringify((result as { type?: unknown })?.type)}`,
      );
      return;
    }
    this.state = "subscribed";
    clearTimeout(this.timer);
    resolve({ close: () => this.close() });
  }

  /** Terminal: report via onLost when live, otherwise reject upstream. */
  private fail(code: string, message: string): void {
    if (this.state === "dead") return;
    const wasLive = this.state === "subscribed";
    this.state = "dead";
    clearTimeout(this.timer);
    this.socket.destroy();
    if (wasLive) this.handlers.onLost(code, message);
    else this.reject(socketError(EVENTS_SUBSCRIBE_METHOD, code, message));
  }

  close(): void {
    this.state = "dead";
    clearTimeout(this.timer);
    this.socket.destroy();
  }
}

/**
 * Open one pane.agent_status_changed subscription. Resolves with the
 * live stream handle after subscription_started; rejects
 * (HerdrSocketError) when herdr refuses the subscription (e.g.
 * not_found: all entries must be valid or the whole request is
 * rejected and the connection closed). After resolve, exactly one
 * onLost is delivered when the stream ends, for any reason.
 */
export function openAgentStatusStream(
  paneId: string,
  handlers: AgentStatusStreamHandlers,
  opts: { socketPath?: string; timeoutMs?: number } = {},
): Promise<AgentStatusStream> {
  const socketPath = opts.socketPath ?? herdrSocketPath();
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(
        new HerdrSocketError(
          `herdr socket ${EVENTS_SUBSCRIBE_METHOD} timed out after ${opts.timeoutMs ?? 5000}ms on ${socketPath}`,
          "timeout",
        ),
      );
    }, opts.timeoutMs ?? 5000);
    // Pre-connection failures (e.g. ECONNREFUSED) reject here; once
    // connected the subscription owns the error surface.
    const onConnectError = (err: Error) => {
      clearTimeout(timer);
      socket.destroy();
      reject(
        new HerdrSocketError(
          `herdr socket ${EVENTS_SUBSCRIBE_METHOD} failed on ${socketPath}: ${err.message}`,
          "connection_error",
        ),
      );
    };
    socket.on("error", onConnectError);
    socket.on("connect", () => {
      socket.off("error", onConnectError);
      const sub = new AgentStatusSubscription(socket, handlers, timer);
      sub.start(resolve, reject);
      sub.sendSubscribe(paneId);
    });
  });
}
