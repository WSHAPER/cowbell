import { parseOrThrow as v } from "../parse.js";
import * as sc from "./schemas.js";
import type { Spec } from "./spec.js";

/**
 * `herdr machine` builders (validated against herdr 0.9.5) — the
 * LOCAL saved-SSH-machine registry.
 *
 * NO transport globals by design: `--machine`/`--remote` route an
 * API command to a herdr server (herdr's own help labels those
 * groups "helpers over the socket API"), while `machine` is
 * "Manage saved SSH machines" — this client's saved registry. See
 * registerMachineTools in src/mcp/server.ts for the MCP-side twin
 * of this decision.
 *
 * `machine add` and `machine reconnect` are deliberately NOT
 * wrapped: interactive SSH authentication flows with no sane MCP
 * semantics.
 */

/** Labels and profile ids are opaque to cowbell — non-empty is all herdr asks. */

export function machineList(): Spec {
  return { argv: ["herdr", "machine", "list"], surface: "machine list" };
}

/** `status` takes an OPTIONAL positional: all saved machines when omitted. */
export function machineStatus(labelOrId?: string): Spec {
  if (labelOrId === undefined) {
    return { argv: ["herdr", "machine", "status"], surface: "machine status" };
  }
  labelOrId = v("machineStatus", sc.nonEmptyText, labelOrId);
  return {
    argv: ["herdr", "machine", "status", labelOrId],
    surface: "machine status",
  };
}

/** Usage order is `rename --label <LABEL> <PROFILE_ID>` — flag before positional. */
export function machineRename(profileId: string, label: string): Spec {
  profileId = v("machineRename", sc.nonEmptyText, profileId);
  label = v("machineRename", sc.nonEmptyText, label);
  return {
    argv: ["herdr", "machine", "rename", "--label", label, profileId],
    surface: "machine rename",
  };
}

export function machineRemove(profileId: string): Spec {
  profileId = v("machineRemove", sc.nonEmptyText, profileId);
  return {
    argv: ["herdr", "machine", "remove", profileId],
    surface: "machine remove",
  };
}

export function machineEnable(profileId: string): Spec {
  profileId = v("machineEnable", sc.nonEmptyText, profileId);
  return {
    argv: ["herdr", "machine", "enable", profileId],
    surface: "machine enable",
  };
}

export function machineDisable(profileId: string): Spec {
  profileId = v("machineDisable", sc.nonEmptyText, profileId);
  return {
    argv: ["herdr", "machine", "disable", profileId],
    surface: "machine disable",
  };
}
