import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Spec } from "./spec.js";

const execFileAsync = promisify(execFile);

class HerdrError extends Error {
  constructor(
    public readonly spec: Spec,
    public readonly stderr: string,
  ) {
    super(
      `herdr (${spec.surface}) failed: ${stderr.trim().split("\n").at(-1) ?? stderr}`,
    );
    this.name = "HerdrError";
  }
}

export interface RunOptions {
  timeoutMs?: number;
  maxBuffer?: number;
}

function errText(err: unknown): string {
  const e = err as { stderr?: string; message?: string };
  return e.stderr ?? e.message ?? "unknown error";
}

/** Execute one canonical spec. Throws HerdrError with the exact argv on failure. */
export async function runHerdr(
  spec: Spec,
  opts: RunOptions = {},
): Promise<string> {
  const [binMaybe, ...args] = spec.argv;
  const bin = binMaybe ?? "herdr";
  const timeout = opts.timeoutMs ?? 30_000;
  const maxBuffer = opts.maxBuffer ?? 8 * 1024 * 1024;
  try {
    return await execText(bin, args, { timeout, maxBuffer });
  } catch (err) {
    throw new HerdrError(spec, errText(err));
  }
}

async function execText(
  bin: string,
  args: string[],
  o: { timeout: number; maxBuffer: number },
): Promise<string> {
  const { stdout } = await execFileAsync(bin, args, o);
  return stdout;
}
