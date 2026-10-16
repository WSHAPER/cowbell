import { parseOrThrow as v } from "../parse.js";
import * as sc from "./schemas.js";
import type { Spec } from "./spec.js";

/**
 * `herdr session` builders (validated against herdr 0.9.5).
 *
 * Named persistent sessions are SERVER-scoped (`herdr --session <name>`
 * use-or-create + `herdr session list/stop/delete` over the socket
 * API), so the transport globals apply like every other API command.
 * `session attach` is deliberately NOT wrapped: interactive attach
 * has no sane MCP semantics.
 *
 * No `--json` anywhere: no existing builder passes it — the tools
 * surface the CLI's default output as text.
 */

export function sessionList(): Spec {
  return { argv: ["herdr", "session", "list"], surface: "session list" };
}

export function sessionStop(name: string): Spec {
  name = v("sessionStop", sc.nonEmptyText, name);
  return { argv: ["herdr", "session", "stop", name], surface: "session stop" };
}

export function sessionDelete(name: string): Spec {
  name = v("sessionDelete", sc.nonEmptyText, name);
  return {
    argv: ["herdr", "session", "delete", name],
    surface: "session delete",
  };
}
