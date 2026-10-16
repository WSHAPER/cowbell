import { createServer, type Server, type Socket } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

/**
 * A NARROW mock of the real herdr socket server — just enough wire
 * behavior to exercise the wait registry:
 *
 *   - newline-delimited JSON, ONE request per connection
 *   - agent.list answered with the current (mutable) agent list
 *   - events.subscribe acknowledged with subscription_started and the
 *     connection held open for pushed {event, data} lines
 *   - test controls to push status events, deliver an events_lost
 *     error, reject a subscribe with not_found, or kill everything
 *
 * It never spawns a herdr server — the point is narrowing, not
 * impersonating the whole surface.
 */
export class MockHerdrSocket {
  readonly socketPath: string;
  private readonly server: Server;
  private readonly dir: string;
  private readonly subs = new Map<Socket, { id: string; paneId: string }>();
  private buffer = new WeakMap<Socket, string>();

  /** The live agent list served to every agent.list request. */
  agents: Array<Record<string, unknown>> = [];
  /** Reject the next events.subscribe with not_found (once). */
  rejectNextSubscribe = false;
  subscribes = 0;
  agentListRequests = 0;
  pushedEvents = 0;

  constructor() {
    this.dir = mkdtempSync(path.join(tmpdir(), "cowbell-mock-"));
    this.socketPath = path.join(this.dir, `${randomUUID()}.sock`);
    this.server = createServer((socket) => this.onConnection(socket));
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) =>
      this.server.listen(this.socketPath, resolve),
    );
  }

  async stop(): Promise<void> {
    for (const [socket] of this.subs) socket.destroy();
    this.subs.clear();
    if (this.server.listening) {
      await new Promise<void>((resolve) => this.server.close(() => resolve()));
    }
    rmSync(this.dir, { recursive: true, force: true });
  }

  /** Push one pane.agent_status_changed event to matching subscribers. */
  pushStatusEvent(paneId: string, status: string): void {
    this.pushedEvents += 1;
    this.broadcast(
      JSON.stringify({
        event: "pane.agent_status_changed",
        data: { pane_id: paneId, workspace_id: "w1", agent_status: status },
      }),
      paneId,
    );
  }

  /**
   * Deliver the events_lost contract: an error response echoing the
   * subscribe id, then close that subscription connection.
   */
  emitEventsLost(): void {
    const last = [...this.subs.entries()].at(-1);
    if (!last) return;
    const [socket, sub] = last;
    socket.write(
      `${JSON.stringify({
        id: sub.id,
        error: {
          code: "events_lost",
          message: "event subscription fell behind retained history",
        },
      })}\n`,
    );
    socket.destroy();
    this.subs.delete(socket);
  }

  /** Destroy every connection and close the listener (server death). */
  kill(): void {
    for (const [socket] of this.subs) socket.destroy();
    this.subs.clear();
    this.server.close();
  }

  liveSubscriptions(): number {
    return this.subs.size;
  }

  private broadcast(line: string, paneId: string): void {
    for (const [socket, sub] of this.subs) {
      if (sub.paneId === paneId && !socket.destroyed) socket.write(`${line}\n`);
    }
  }

  private onConnection(socket: Socket): void {
    this.buffer.set(socket, "");
    socket.on("data", (d) => this.onData(socket, d));
    socket.on("error", () => this.subs.delete(socket));
    socket.on("close", () => this.subs.delete(socket));
  }

  private onData(socket: Socket, chunk: Buffer): void {
    let buf = (this.buffer.get(socket) ?? "") + chunk.toString("utf8");
    let at: number;
    while ((at = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, at);
      buf = buf.slice(at + 1);
      if (line.trim())
        this.handleLine(
          socket,
          JSON.parse(line) as {
            id?: string;
            method?: string;
            params?: { subscriptions?: Array<{ pane_id?: string }> };
          },
        );
    }
    this.buffer.set(socket, buf);
  }

  private handleLine(
    socket: Socket,
    req: {
      id?: string;
      method?: string;
      params?: { subscriptions?: Array<{ pane_id?: string }> };
    },
  ): void {
    const id = req.id ?? "";
    if (req.method === "agent.list") {
      this.agentListRequests += 1;
      socket.write(
        `${JSON.stringify({
          id,
          result: { type: "agent_list", agents: this.agents },
        })}\n`,
      );
      socket.end();
      return;
    }
    if (req.method === "events.subscribe") {
      if (this.rejectNextSubscribe) {
        this.rejectNextSubscribe = false;
        socket.write(
          `${JSON.stringify({
            id,
            error: { code: "not_found", message: "pane not found" },
          })}\n`,
        );
        socket.destroy();
        return;
      }
      this.subscribes += 1;
      this.subs.set(socket, {
        id,
        paneId: req.params?.subscriptions?.[0]?.pane_id ?? "",
      });
      socket.write(
        `${JSON.stringify({ id, result: { type: "subscription_started" } })}\n`,
      );
      return;
    }
    socket.write(
      `${JSON.stringify({
        id,
        error: {
          code: "method_not_found",
          message: `no such method ${req.method}`,
        },
      })}\n`,
    );
    socket.destroy();
  }
}
