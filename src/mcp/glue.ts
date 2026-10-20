import { z } from "zod";
import { runHerdr } from "../herdr/exec.js";
import type { Spec } from "../herdr/spec.js";
import { withTransport, type Transport } from "../herdr/transport-args.js";
import { TransportSchema, toTransport } from "./transport.js";

/**
 * The MCP tool glue — the five helpers every tool registration calls
 * (param-shape wrapping, transport derivation, result building, exec).
 * Lives apart from shared.ts's schema vocabulary on purpose: that file
 * is pure data (zero functions), this one is the plumbing. Tool modules
 * import both; the split keeps each concern single-sourced.
 */

const machine = z
  .string()
  .optional()
  .describe("Registered machine label/id — run there instead of local");
const remote = z
  .string()
  .optional()
  .describe("SSH target — run on a remote herdr session instead of local");

/** Merge transport params into a shape and derive the parsed transport. */
export const withT = <S extends z.ZodRawShape>(shape: S) => ({
  ...shape,
  machine,
  remote,
});
export const transport = (v: {
  machine?: string;
  remote?: string;
}): Transport | undefined =>
  toTransport(
    TransportSchema.parse({ machine: v.machine, remote: v.remote }) ??
      undefined,
  );

export const text = (t: string) => ({
  content: [{ type: "text" as const, text: t }],
});
export const exec = (s: Spec, t?: Transport) => runHerdr(withTransport(s, t));
export const json = (v: unknown) => text(JSON.stringify(v, null, 2));
