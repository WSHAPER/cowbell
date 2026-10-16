import { parseOrThrow as v } from "../parse.js";
import * as sc from "./schemas.js";
import type { Spec } from "./spec.js";

/**
 * Where a command runs. LOCAL is the default everywhere; remote forms
 * are OPT-IN per call (a remote herdr session's workspaces/agents are
 * invisible in the local UI — mixing them silently is how fleets get
 * lost, so the caller must say so explicitly every time).
 */
export type Transport =
  { kind: "machine"; label: string } | { kind: "remote"; sshTarget: string };

/** Insert the transport globals after the binary name. */
export function withTransport(spec: Spec, t?: Transport): Spec {
  if (!t) return spec;
  t = v("withTransport", sc.transport, t);
  const [binMaybe, ...rest] = spec.argv;
  const bin = binMaybe ?? "herdr";
  const prefix =
    t.kind === "machine" ? ["--machine", t.label] : ["--remote", t.sshTarget];
  return { argv: [bin, ...prefix, ...rest], surface: spec.surface };
}
