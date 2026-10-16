import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import * as oc from "../src/opencode/spec.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const fixture = path.join(root, "tests", "fixtures", "opencode-models.json");

interface CapturedModelSurface {
  list: {
    operationId: string;
    method: string;
    path: string;
    parameters: Array<{ name: string; in: string; required: boolean }>;
  };
  default: {
    operationId: string;
    method: string;
    path: string;
    parameters: Array<{ name: string; in: string; required: boolean }>;
    dataNullable: boolean;
  };
  modelInfoRequired: string[];
  variantRequired: string[];
}

function loadSurface(): CapturedModelSurface {
  if (!existsSync(fixture)) {
    throw new Error(
      "tests/fixtures/opencode-models.json missing — run: bash scripts/dump-opencode-models.sh",
    );
  }
  return JSON.parse(readFileSync(fixture, "utf8")) as CapturedModelSurface;
}

/**
 * The models drift tripwire (twin of opencode.drift.test.ts). The
 * fixture captures model.list + model.default from the running
 * opencode background service's /openapi.json (regenerate: bash
 * scripts/dump-opencode-models.sh). When opencode renames either
 * operation or drops a Model.Info key our raw schema pins, this
 * fails naming the exact token.
 */
describe("opencode model surface drift", () => {
  const surface = loadSurface();

  it("fixture pins both operation identities", () => {
    expect(surface.list.operationId).toBe("model.list");
    expect(surface.list.path).toBe("/api/model");
    expect(surface.default.operationId).toBe("model.default");
    expect(surface.default.path).toBe("/api/model/default");
  });

  it("operation ids we emit exist upstream", () => {
    expect(oc.modelList().argv[2]).toBe(surface.list.operationId);
    expect(oc.modelDefault().argv[2]).toBe(surface.default.operationId);
  });

  it("we emit no parameters the captured surface does not declare", () => {
    // model.list/model.default take no --param flags today; the only
    // upstream parameter (location) is deliberately not forwarded —
    // discovery is local-only. A builder regression that starts
    // emitting params must re-check them against the capture.
    for (const spec of [oc.modelList(), oc.modelDefault()]) {
      expect(
        spec.argv.filter((a) => a === "--param"),
        `${spec.surface} must not emit --param without a drift re-check`,
      ).toEqual([]);
    }
  });

  it("Model.Info keys our raw schema pins are still required upstream", () => {
    // The subset src/opencode/schemas.ts rawModelInfo reads.
    for (const key of ["id", "modelID", "providerID", "name", "variants"]) {
      expect(
        surface.modelInfoRequired,
        `Model.Info key \`${key}\` no longer required upstream — OPENCODE DRIFT. Regenerate the fixture and update src/opencode/schemas.ts.`,
      ).toContain(key);
    }
  });

  it("variant entries still carry an id", () => {
    expect(surface.variantRequired).toContain("id");
  });

  it("default data stays nullable (a service may have no default)", () => {
    expect(surface.default.dataNullable).toBe(true);
  });
});
