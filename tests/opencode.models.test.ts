import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { fetchModels, OpenCodeApiError } from "../src/opencode/client.js";
import { modelDefault, modelList } from "../src/opencode/spec.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sample = JSON.parse(
  readFileSync(
    path.join(root, "tests", "fixtures", "opencode-models.sample.json"),
    "utf8",
  ),
) as { list: unknown; default: unknown };

/** Serves the fixture envelopes by operation id, recording argvs. */
function fixtureExec(seen: string[][]) {
  return async (argv: string[]): Promise<string> => {
    seen.push(argv);
    switch (argv[2]) {
      case "model.list":
        return JSON.stringify(sample.list);
      case "model.default":
        return JSON.stringify(sample.default);
      default:
        throw new Error(`unexpected opencode api argv: ${argv.join(" ")}`);
    }
  };
}

/** The trimmed models view the sample envelopes must normalize to. */
const expectedModels = {
  models: [
    {
      model: "fixture/fixture-model-v2",
      provider: "fixture",
      name: "Fixture Model",
      variants: ["low", "high"],
      default: false,
    },
    {
      model: "fixture/fixture-model-pro",
      provider: "fixture",
      name: "Fixture Model Pro",
      variants: [],
      default: false,
    },
    {
      model: "zai/glm-5.3",
      provider: "zai",
      name: "GLM-5.3",
      variants: ["low", "high", "max"],
      default: true,
    },
  ],
  default: "zai/glm-5.3",
};

describe("fetchModels normalization", () => {
  it("parses the documented envelopes into the trimmed selector view", async () => {
    const seen: string[][] = [];
    const r = await fetchModels(fixtureExec(seen));
    expect(r).toEqual(expectedModels);
  });

  it("marks the default on its entry AND returns it at the top level", async () => {
    const r = await fetchModels(fixtureExec([]));
    expect(r.default).toBe("zai/glm-5.3");
    const flagged = r.models.filter((m) => m.default);
    expect(flagged).toHaveLength(1);
    expect(flagged[0]!.model).toBe(r.default);
  });

  it("selectors use modelID (providerID/modelID), not the entry id", async () => {
    const r = await fetchModels(fixtureExec([]));
    // id "fixture-model" vs modelID "fixture-model-v2": modelID wins.
    expect(r.models[0]!.model).toBe("fixture/fixture-model-v2");
  });

  it("emits exactly the pinned model.list + model.default argvs", async () => {
    const seen: string[][] = [];
    await fetchModels(fixtureExec(seen));
    expect(seen).toEqual([modelList().argv, modelDefault().argv]);
  });

  it("null default (nothing configured) stays null, no entry flagged", async () => {
    const r = await fetchModels(async (argv) =>
      argv[2] === "model.default"
        ? JSON.stringify({ location: { directory: "/x" }, data: null })
        : JSON.stringify(sample.list),
    );
    expect(r.default).toBeNull();
    expect(r.models.every((m) => !m.default)).toBe(true);
  });
});

describe("fetchModels failure modes", () => {
  it("non-JSON stdout fails loud", async () => {
    await expect(
      fetchModels(async () => "HTTP 503 Service Unavailable\n"),
    ).rejects.toThrow(OpenCodeApiError);
  });

  it("list drift (data not an array) fails loud naming the surface", async () => {
    await expect(
      fetchModels(async (argv) =>
        argv[2] === "model.list"
          ? JSON.stringify({ data: "nope" })
          : JSON.stringify(sample.default),
      ),
    ).rejects.toThrow(/model\.list.*drifted|drifted/s);
  });

  it("entry drift (missing providerID) fails loud", async () => {
    const bad = {
      location: { directory: "/x" },
      data: [{ id: "m", modelID: "m", name: "M", variants: [] }],
    };
    await expect(
      fetchModels(async (argv) =>
        argv[2] === "model.list"
          ? JSON.stringify(bad)
          : JSON.stringify({ location: { directory: "/x" }, data: null }),
      ),
    ).rejects.toThrow(OpenCodeApiError);
  });

  it("default envelope drift (no data key) fails loud", async () => {
    await expect(
      fetchModels(async (argv) =>
        argv[2] === "model.default"
          ? JSON.stringify({ location: { directory: "/x" } })
          : JSON.stringify(sample.list),
      ),
    ).rejects.toThrow(OpenCodeApiError);
  });
});
