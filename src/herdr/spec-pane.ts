import { z } from "zod";
import { parseOrThrow as v } from "../parse.js";
import * as sc from "./schemas.js";
import type { PaneSource, Spec } from "./spec.js";

/** `herdr pane` builders (the reliable fallback primitives — all verified working). */

export function paneGet(pane: string): Spec {
  pane = v("paneGet", sc.paneId, pane);
  return { argv: ["herdr", "pane", "get", pane], surface: "pane get" };
}

export function paneRead(
  pane: string,
  opts: { lines?: number; source?: PaneSource } = {},
): Spec {
  pane = v("paneRead", sc.paneId, pane);
  opts = v("paneRead", sc.readOpts, opts);
  const argv = ["herdr", "pane", "read", pane];
  if (opts.source !== undefined) argv.push("--source", opts.source);
  argv.push("--lines", String(opts.lines ?? 200));
  return { argv, surface: "pane read" };
}

/** Type text WITHOUT Enter (agent input box). */
export function paneSendText(pane: string, text: string): Spec {
  pane = v("paneSendText", sc.paneId, pane);
  text = v("paneSendText", sc.nonEmptyText, text);
  return {
    argv: ["herdr", "pane", "send-text", pane, text],
    surface: "pane send-text",
  };
}

/** Key names, e.g. ["enter"], ["esc", "esc"]. */
export function paneSendKeys(pane: string, keys: string[]): Spec {
  pane = v("paneSendKeys", sc.paneId, pane);
  keys = v("paneSendKeys", z.array(sc.nonEmptyText).min(1), keys);
  return {
    argv: ["herdr", "pane", "send-keys", pane, ...keys],
    surface: "pane send-keys",
  };
}

/** Type a command AND press Enter (shell panes). */
export function paneRun(pane: string, command: string): Spec {
  pane = v("paneRun", sc.paneId, pane);
  command = v("paneRun", sc.nonEmptyText, command);
  return { argv: ["herdr", "pane", "run", pane, command], surface: "pane run" };
}
