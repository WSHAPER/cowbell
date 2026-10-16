import { parseOrThrow as v } from "../parse.js";
import * as sc from "./schemas.js";
import type { Spec } from "./spec.js";

/** `herdr worktree` builders. */

export function worktreeCreate(opts: {
  workspace?: string;
  cwd?: string;
  branch: string;
  base?: string;
  label?: string;
  focus?: boolean;
}): Spec {
  opts = v("worktreeCreate", sc.worktreeCreateOpts, opts);
  const argv = ["herdr", "worktree", "create"];
  if (opts.workspace !== undefined) argv.push("--workspace", opts.workspace);
  if (opts.cwd !== undefined) argv.push("--cwd", opts.cwd);
  argv.push("--branch", opts.branch);
  if (opts.base !== undefined) argv.push("--base", opts.base);
  if (opts.label !== undefined) argv.push("--label", opts.label);
  argv.push(opts.focus === false ? "--no-focus" : "--focus");
  return { argv, surface: "worktree create" };
}

export function worktreeRemove(workspace: string, force = false): Spec {
  workspace = v("worktreeRemove", sc.workspaceId, workspace);
  const argv = ["herdr", "worktree", "remove", "--workspace", workspace];
  if (force) argv.push("--force");
  return { argv, surface: "worktree remove" };
}
