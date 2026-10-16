import { z } from "zod";
import { parseOrThrow as v } from "../parse.js";
import * as sc from "./schemas.js";
import type { Spec } from "./spec.js";

/**
 * `herdr tab` builders (validated against herdr 0.9.5 — grammar
 * re-verified via `herdr tab <sub> --help`; every command runs over
 * the socket API, so the MCP layer wraps them with transport params).
 *
 * Tab ids are workspace-scoped like pane ids, e.g. w36:t1.
 */

const tabId = z
  .string()
  .min(1)
  .regex(/^w[a-zA-Z0-9]+:t\d+$/, "tab id must look like w36:t1");

const cwdPath = z.string().min(1).regex(/^\//, "cwd must be an absolute path");

/** `tab list` opts — omitted workspace targets the active workspace. */
const tabListOpts = z
  .object({
    workspace: sc.workspaceId.optional(),
  })
  .strict()
  .default({});

/**
 * `tab create` opts — everything optional per `tab create --help`:
 * with neither flag herdr targets the ACTIVE workspace and its
 * default cwd; the omission is passed straight through.
 */
const tabCreateOpts = z
  .object({
    workspace: sc.workspaceId.optional(),
    cwd: cwdPath.optional(),
  })
  .strict()
  .default({});

export function tabList(opts: { workspace?: string } = {}): Spec {
  opts = v("tabList", tabListOpts, opts);
  const argv = ["herdr", "tab", "list"];
  if (opts.workspace !== undefined) argv.push("--workspace", opts.workspace);
  return { argv, surface: "tab list" };
}

export function tabCreate(
  opts: {
    workspace?: string;
    cwd?: string;
  } = {},
): Spec {
  opts = v("tabCreate", tabCreateOpts, opts);
  const argv = ["herdr", "tab", "create"];
  if (opts.workspace !== undefined) argv.push("--workspace", opts.workspace);
  if (opts.cwd !== undefined) argv.push("--cwd", opts.cwd);
  return { argv, surface: "tab create" };
}

export function tabGet(id: string): Spec {
  id = v("tabGet", tabId, id);
  return { argv: ["herdr", "tab", "get", id], surface: "tab get" };
}

export function tabFocus(id: string): Spec {
  id = v("tabFocus", tabId, id);
  return { argv: ["herdr", "tab", "focus", id], surface: "tab focus" };
}

/**
 * Rename a tab. `<LABEL>...` is variadic in herdr's grammar, but the
 * label is passed as ONE argv element — the paneRun precedent for
 * variadic positionals: runHerdr uses execFile (no shell), so the
 * element reaches herdr verbatim, and a single element is the
 * identity under every join rule the CLI might apply (join with
 * spaces, take one). Splitting on whitespace would be the only way
 * to corrupt a multi-word label, so cowbell never splits.
 */
export function tabRename(id: string, label: string): Spec {
  id = v("tabRename", tabId, id);
  label = v("tabRename", sc.nonEmptyText, label);
  return {
    argv: ["herdr", "tab", "rename", id, label],
    surface: "tab rename",
  };
}

export function tabClose(id: string): Spec {
  id = v("tabClose", tabId, id);
  return { argv: ["herdr", "tab", "close", id], surface: "tab close" };
}
