import { z } from "zod";
import { parseOrThrow as v } from "../parse.js";

/**
 * The canonical opencode `api` CLI surface cowbell is built against.
 *
 * SINGLE SOURCE for every opencode api call we shell out to, mirroring
 * the herdr spec-* modules. The opencode background service exposes
 * its routes via `opencode api GET /openapi.json`; the drift fixtures
 * (tests/fixtures/opencode-session-message.json from
 * scripts/dump-opencode-surface.sh, tests/fixtures/opencode-models.json
 * from scripts/dump-opencode-models.sh) pin the session.message.list
 * and model.list/model.default operations so renames fail the suite,
 * not the fleet. The CLI itself handles background-service
 * discovery + auth.
 */

/**
 * An opencode api call. Structurally the same shape as a herdr Spec
 * (argv + surface) but an independent vocabulary — the two CLIs
 * evolve separately, so opencode owns its own type instead of
 * importing herdr's.
 */
export type ApiSpec = {
  /** Full argv including the `opencode` binary name at [0]. */
  argv: string[];
  /** Stable identifier used by the drift suite. */
  surface: string;
};

/** opencode session ids look like "ses_...". */
export const sessionId = z
  .string()
  .min(1)
  .regex(/^ses_[A-Za-z0-9]+$/, "session id must look like ses_...");

export type MessageOrder = "asc" | "desc";

const listOpts = z
  .object({
    limit: z.number().int().min(1).max(200).optional(),
    order: z.enum(["asc", "desc"]).optional(),
  })
  .strict()
  .default({});

/**
 * List a session's messages via the background-service HTTP API
 * (operation `session.message.list`, GET /api/session/{sessionID}/message).
 * Parameters: sessionID (path), limit + order (query).
 */
export function messageList(
  session: string,
  opts: { limit?: number; order?: MessageOrder } = {},
): ApiSpec {
  session = v("messageList", sessionId, session);
  opts = v("messageList", listOpts, opts);
  const argv = [
    "opencode",
    "api",
    "session.message.list",
    "--param",
    `sessionID=${session}`,
  ];
  if (opts.limit !== undefined) argv.push("--param", `limit=${opts.limit}`);
  if (opts.order !== undefined) argv.push("--param", `order=${opts.order}`);
  return { argv, surface: "opencode session.message.list" };
}

/**
 * List every model the local opencode service knows about
 * (operation `model.list`, GET /api/model). No parameters — the
 * service resolves its own location; machine/remote do not apply.
 */
export function modelList(): ApiSpec {
  return {
    argv: ["opencode", "api", "model.list"],
    surface: "opencode model.list",
  };
}

/**
 * The model used when a session has no explicit selection
 * (operation `model.default`, GET /api/model/default). The response
 * `data` is nullable — a service with no default configured.
 */
export function modelDefault(): ApiSpec {
  return {
    argv: ["opencode", "api", "model.default"],
    surface: "opencode model.default",
  };
}
