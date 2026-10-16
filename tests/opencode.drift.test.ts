import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import * as oc from "../src/opencode/spec.js";
import { MESSAGE_TYPES } from "../src/opencode/schemas.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const fixture = path.join(
  root,
  "tests",
  "fixtures",
  "opencode-session-message.json",
);

interface CapturedSurface {
  operationId: string;
  method: string;
  path: string;
  parameters: Array<{ name: string; in: string }>;
  partTypes: string[];
  messageTypes: string[];
}

function loadSurface(): CapturedSurface {
  if (!existsSync(fixture)) {
    throw new Error(
      "tests/fixtures/opencode-session-message.json missing — run: bash scripts/dump-opencode-surface.sh",
    );
  }
  return JSON.parse(readFileSync(fixture, "utf8")) as CapturedSurface;
}

/**
 * The opencode drift tripwire (twin of upstream.drift.test.ts).
 *
 * The fixture is the captured session.message.list operation from the
 * running opencode background service's /openapi.json (regenerate:
 * bash scripts/dump-opencode-surface.sh). When opencode renames the
 * operation or drops a parameter we emit, this fails naming the
 * exact token.
 */
describe("opencode surface drift", () => {
  const surface = loadSurface();

  it("fixture pins the operation identity", () => {
    expect(surface.operationId).toBe("session.message.list");
    expect(surface.path).toBe("/api/session/{sessionID}/message");
  });

  it("operation id we emit exists upstream", () => {
    expect(oc.messageList("ses_x").argv[2]).toBe(surface.operationId);
  });

  it("parameters we emit exist upstream", () => {
    const emit = (opts: { limit?: number; order?: "asc" } = {}) =>
      oc
        .messageList("ses_x", opts)
        .argv.filter(
          (a) =>
            a.startsWith("sessionID=") ||
            a.startsWith("limit=") ||
            a.startsWith("order="),
        )
        .map((a) => a.split("=")[0]);
    for (const param of emit({ limit: 5, order: "asc" })) {
      expect(
        surface.parameters.some((p) => p.name === param),
        `session.message.list emits \`${param}\` but the captured /openapi.json does not declare it — OPENCODE DRIFT. Regenerate the fixture and update src/opencode/spec.ts.`,
      ).toBe(true);
    }
  });

  it("part types we normalize exist upstream", () => {
    for (const part of ["Text", "Reasoning", "Tool"] as const) {
      expect(
        surface.partTypes,
        `assistant part \`${part}\` missing from the captured content union — OPENCODE DRIFT`,
      ).toContain(part);
    }
  });

  it("message types we surface exist upstream", () => {
    for (const type of MESSAGE_TYPES) {
      expect(
        surface.messageTypes,
        `message type \`${type}\` missing from the captured Session.Message.Info union — OPENCODE DRIFT`,
      ).toContain(type);
    }
  });
});
