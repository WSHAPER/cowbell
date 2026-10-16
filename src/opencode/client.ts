import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as oc from "./schemas.js";
import * as spec from "./spec.js";

/**
 * The only module that touches the opencode process boundary. The
 * `opencode api` CLI resolves + authenticates against the running
 * background service for us; we pin the argv (spec.ts), execute, and
 * validate the response (schemas.ts) into the normalized transcript.
 */

const execFileAsync = promisify(execFile);

export class OpenCodeApiError extends Error {
  constructor(
    public readonly surface: string,
    public readonly detail: string,
  ) {
    super(`opencode api (${surface}) failed: ${detail}`);
    this.name = "OpenCodeApiError";
  }
}

export type ExecFn = (argv: string[]) => Promise<string>;

/** Execute one opencode api spec argv. Throws OpenCodeApiError on failure. */
export const execOpenCode: ExecFn = async (argv: string[]) => {
  const surface = argv[2] ?? "opencode api";
  const timeout = 30_000;
  const maxBuffer = 8 * 1024 * 1024;
  try {
    const { stdout } = await execFileAsync(argv[0]!, argv.slice(1), {
      timeout,
      maxBuffer,
    });
    return stdout;
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    const detail = (e.stderr ?? e.message ?? "unknown error").trim();
    throw new OpenCodeApiError(surface, detail.split("\n").at(-1) ?? detail);
  }
};

export interface ListOpts {
  limit?: number;
  order?: spec.MessageOrder;
}

/**
 * Fetch + validate one page of a session's messages, oldest-first
 * when order is omitted by the caller's choice. Unknown part types
 * are preserved as bare {type} markers instead of failing the read.
 */
export async function fetchMessages(
  session: string,
  opts: ListOpts = {},
  exec: ExecFn = execOpenCode,
): Promise<oc.TranscriptPage> {
  const s: spec.ApiSpec = spec.messageList(session, opts);
  const stdout = await exec(s.argv);
  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch {
    throw new OpenCodeApiError(
      s.surface,
      `response is not JSON (got ${JSON.stringify(stdout.slice(0, 120))})`,
    );
  }
  const parsed = oc.messagesEnvelopeSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    const at = issue.path.length ? `.${String(issue.path.join("."))}` : "";
    throw new OpenCodeApiError(
      s.surface,
      `response drifted from the documented shape${at}: ${issue.message}`,
    );
  }
  return oc.transcriptPageSchema.parse({
    messages: parsed.data.data.map(normalize),
  });
}

function normalize(m: oc.RawMessage): oc.TranscriptMessage {
  const out: oc.TranscriptMessage = {
    id: m.id,
    role: m.type,
    created: m.time.created,
    streamed: typeof m.time.streamed === "number" ? m.time.streamed : undefined,
    agent: m.agent,
    model: m.model,
    text: m.text,
    parts: (m.content ?? []).map((p) => {
      const t = p.type;
      if (t === "text" || t === "reasoning")
        return { type: t, text: typeof p.text === "string" ? p.text : "" };
      if (t === "tool")
        return {
          type: t,
          name: typeof p.name === "string" ? p.name : "",
          status: readStatus(p),
        };
      return { type: t };
    }),
    detail: pickDetail(m),
  };
  return out;
}

/** Compact context for event messages (idle outcome, switches, ...). */
function pickDetail(m: oc.RawMessage): Record<string, unknown> | undefined {
  const detail: Record<string, unknown> = {};
  for (const key of [
    "outcome",
    "previous",
    "description",
    "command",
    "status",
    "name",
  ] as const) {
    const v = (m as Record<string, unknown>)[key];
    if (v !== undefined) detail[key] = v;
  }
  if (m.model !== undefined && m.type !== "assistant")
    detail.model = m.model.id;
  return Object.keys(detail).length ? detail : undefined;
}

function readStatus(p: { type: string } & Record<string, unknown>): string {
  const state = p.state as { status?: unknown } | undefined;
  return typeof state?.status === "string" ? state.status : "unknown";
}
