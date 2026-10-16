import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as sessions from "../../herdr/spec-session.js";
import { withT, transport, text, exec } from "../shared.js";
import type { TransportParams } from "../shared.js";

/**
 * `herdr session` — manage NAMED persistent sessions. Transport
 * params apply: these are API commands like the workspace/agent
 * tools (`herdr --machine <label> <command>` is a documented
 * top-level usage form, and named sessions live on remote servers
 * too — `herdr --remote <target> [--session <name>]`).
 * `session attach` is deliberately NOT wrapped: interactive attach
 * has no sane MCP semantics.
 */
export function registerSessionTools(server: McpServer): void {
  server.tool(
    "session_list",
    "List named persistent sessions (local herdr server by default)",
    withT({}),
    async (v: TransportParams) =>
      text(await exec(sessions.sessionList(), transport(v))),
  );

  server.tool(
    "session_stop",
    "Stop a named persistent session",
    withT({ name: z.string().min(1).describe("Session name") }),
    async (v: TransportParams & { name: string }) =>
      text(await exec(sessions.sessionStop(v.name), transport(v))),
  );

  server.tool(
    "session_delete",
    "Delete a named persistent session — only a STOPPED session can be deleted; stop it first",
    withT({ name: z.string().min(1).describe("Session name") }),
    async (v: TransportParams & { name: string }) =>
      text(await exec(sessions.sessionDelete(v.name), transport(v))),
  );
}
