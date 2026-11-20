import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import * as oc from "../src/opencode/spec.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const fixture = path.join(
  root,
  "tests",
  "fixtures",
  "opencode-session-prompt.json",
);

interface CapturedPromptSurface {
  operationId: string;
  method: string;
  path: string;
  parameters: Array<{ name: string; in: string; required: boolean }>;
  bodyRequired: boolean;
  bodySchemaPins: {
    bodyProperties: string[];
    requiredKeys: string[];
    textMinLength: number | null;
    deliveryEnum: string[];
  };
}

function loadSurface(): CapturedPromptSurface {
  if (!existsSync(fixture)) {
    throw new Error(
      "tests/fixtures/opencode-session-prompt.json missing — run: bash scripts/dump-opencode-reminder.sh",
    );
  }
  return JSON.parse(readFileSync(fixture, "utf8")) as CapturedPromptSurface;
}

/** The --data JSON payload a sessionPrompt argv carries. */
function dataBody(argv: string[]): Record<string, unknown> {
  const ix = argv.indexOf("--data");
  if (ix === -1 || ix + 1 >= argv.length) {
    throw new Error("sessionPrompt argv carries no --data payload");
  }
  return JSON.parse(argv[ix + 1]!) as Record<string, unknown>;
}

/**
 * The session.prompt drift tripwire (twin of opencode.drift.test.ts,
 * plus the POST body direction). The fixture captures the operation
 * from the running opencode background service's /openapi.json
 * (regenerate: bash scripts/dump-opencode-reminder.sh). When opencode
 * renames the operation, drops the sessionID path parameter, or
 * reshapes the request body keys we pin, this fails naming the exact
 * token.
 */
describe("opencode session.prompt drift", () => {
  const surface = loadSurface();

  it("fixture pins the operation identity", () => {
    expect(surface.operationId).toBe("session.prompt");
    expect(surface.method).toBe("post");
    expect(surface.path).toBe("/api/session/{sessionID}/prompt");
  });

  it("operation id we emit exists upstream", () => {
    expect(oc.sessionPrompt("ses_x", "wake up").argv[2]).toBe(
      surface.operationId,
    );
  });

  it("parameters we emit exist upstream", () => {
    const emitted = oc
      .sessionPrompt("ses_x", "wake up")
      .argv.filter((a) => a.startsWith("sessionID="))
      .map((a) => a.split("=")[0]);
    for (const param of emitted) {
      expect(
        surface.parameters.some((p) => p.name === param),
        `session.prompt emits \`${param}\` but the captured /openapi.json does not declare it — OPENCODE DRIFT. Regenerate the fixture and update src/opencode/spec.ts.`,
      ).toBe(true);
    }
  });

  it("--data body keys we emit are declared upstream properties", () => {
    for (const key of Object.keys(
      dataBody(oc.sessionPrompt("ses_x", "t").argv),
    )) {
      expect(
        surface.bodySchemaPins.bodyProperties,
        `session.prompt --data sends \`${key}\` but the captured request body does not declare it — OPENCODE DRIFT. Regenerate the fixture and update src/opencode/spec.ts.`,
      ).toContain(key);
    }
  });

  it("text stays a required body key upstream", () => {
    expect(
      surface.bodySchemaPins.requiredKeys,
      "session.prompt body no longer requires `text` — OPENCODE DRIFT. Regenerate the fixture and re-check spec.sessionPrompt.",
    ).toContain("text");
  });

  it("delivery values we emit stay in the upstream enum", () => {
    for (const delivery of ["steer", "queue"] as const) {
      const body = dataBody(oc.sessionPrompt("ses_x", "t", delivery).argv);
      expect(
        surface.bodySchemaPins.deliveryEnum,
        `session.prompt delivery \`${String(body.delivery)}\` missing from the captured enum — OPENCODE DRIFT. Regenerate the fixture and update spec.PromptDelivery.`,
      ).toContain(body.delivery);
    }
  });

  it("request body stays required (a body-less prompt is a different op)", () => {
    expect(surface.bodyRequired).toBe(true);
  });

  it("upstream pins no text minLength (the non-empty check is ours)", () => {
    // If this trips, upstream started constraining length — re-check
    // sessionPrompt's local z.string().min(1) against the new bound.
    expect(surface.bodySchemaPins.textMinLength).toBeNull();
  });
});
