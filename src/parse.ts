import type { z } from "zod";

/**
 * Shared parse-or-throw — the single validation idiom of the repo
 * (spec builders, output parsers, result contracts all fail loud
 * with the builder named and the offending input echoed).
 *
 * `note` lets external-surface callers say WHAT drifted
 * (e.g. "herdr output drifted from the expected shape").
 */
export function parseOrThrow<S extends z.ZodTypeAny>(
  builder: string,
  schema: S,
  input: unknown,
  note?: string,
): z.output<S> {
  const r = schema.safeParse(input);
  if (!r.success) {
    const issue = r.error.issues[0]!;
    const at = issue.path.length ? `.${String(issue.path.join("."))}` : "";
    throw new Error(
      `${builder}${at}: ${note ? `${note}: ` : ""}${issue.message} (got ${JSON.stringify(input)})`,
    );
  }
  return r.data as z.output<S>;
}

/** JSON.parse then parseOrThrow — non-JSON stdout fails with the parser named. */
export function parseJsonOrThrow<S extends z.ZodTypeAny>(
  builder: string,
  schema: S,
  stdout: string,
  note?: string,
): z.output<S> {
  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch {
    throw new Error(
      `${builder}: stdout is not JSON (got ${JSON.stringify(stdout.slice(0, 120))})`,
    );
  }
  return parseOrThrow(builder, schema, json, note);
}
