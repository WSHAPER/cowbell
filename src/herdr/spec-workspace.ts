import { parseOrThrow as v } from "../parse.js";
import * as sc from "./schemas.js";
import type { Spec } from "./spec.js";

/** `herdr workspace` builders (validated against herdr 0.9.5). */

export function workspaceList(): Spec {
  return { argv: ["herdr", "workspace", "list"], surface: "workspace list" };
}

export function workspaceGet(id: string): Spec {
  id = v("workspaceGet", sc.workspaceId, id);
  return { argv: ["herdr", "workspace", "get", id], surface: "workspace get" };
}

export function workspaceCreate(opts: {
  cwd: string;
  label?: string;
  focus?: boolean;
}): Spec {
  opts = v("workspaceCreate", sc.createOpts, opts);
  const argv = ["herdr", "workspace", "create", "--cwd", opts.cwd];
  if (opts.label !== undefined) argv.push("--label", opts.label);
  argv.push(opts.focus === false ? "--no-focus" : "--focus");
  return { argv, surface: "workspace create" };
}

export function workspaceClose(id: string): Spec {
  id = v("workspaceClose", sc.workspaceId, id);
  return {
    argv: ["herdr", "workspace", "close", id],
    surface: "workspace close",
  };
}

export function workspaceFocus(id: string): Spec {
  id = v("workspaceFocus", sc.workspaceId, id);
  return {
    argv: ["herdr", "workspace", "focus", id],
    surface: "workspace focus",
  };
}
