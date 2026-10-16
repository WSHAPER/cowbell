/**
 * The canonical herdr CLI surface cowbell is built against — shared
 * vocabulary layer.
 *
 * SINGLE SOURCE for every command we shell out to, split by domain:
 * the builders live in spec-workspace.ts, spec-agent.ts, spec-pane.ts,
 * and spec-worktree.ts; the transport globals live in
 * transport-args.ts. This module holds the shape every builder
 * returns plus the pane-read vocabulary. The drift tests pin each
 * builder's argv EXACTLY, and cross-check every subcommand+flag
 * against the captured upstream surface fixture
 * (tests/fixtures/herdr-surface.txt) — when herdr renames anything,
 * the suite fails with an actionable message instead of a broken
 * fleet.
 */

/** Validated against herdr 0.9.5 (`herdr --help` walk, 2026-10-06). */
export const SUPPORTED_HERDR_VERSION = "0.9.5";

export type Spec = {
  /** Full argv including the `herdr` binary name at [0]. */
  argv: string[];
  /** Stable identifier used by the drift suite (`group subcommand`). */
  surface: string;
};

export type PaneSource = "visible" | "recent" | "recent-unwrapped";
