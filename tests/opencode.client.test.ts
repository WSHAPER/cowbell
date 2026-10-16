import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { fetchMessages, OpenCodeApiError } from "../src/opencode/client.js";
import { messageList } from "../src/opencode/spec.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sample = readFileSync(
  path.join(root, "tests", "fixtures", "opencode-message-list.sample.json"),
  "utf8",
);

/** The trimmed transcript view the sample envelope must normalize to. */
const expectedTranscript = [
  {
    id: "msg_fixture_user001",
    role: "user",
    created: 1792154000000,
    streamed: undefined,
    agent: undefined,
    model: undefined,
    text: "Fix the flaky test in CI",
    parts: [],
    detail: undefined,
  },
  {
    id: "msg_fixture_evt001",
    role: "synthetic",
    created: 1792154000500,
    streamed: undefined,
    agent: undefined,
    model: undefined,
    text: "The server restarted while you were working.",
    parts: [],
    detail: { description: "Continuing after restart" },
  },
  {
    id: "msg_fixture_evt002",
    role: "idle",
    created: 1792154000600,
    streamed: undefined,
    agent: undefined,
    model: undefined,
    text: undefined,
    parts: [],
    detail: { outcome: "failed" },
  },
  {
    id: "msg_fixture_asst001",
    role: "assistant",
    created: 1792154001000,
    streamed: 1792154005000,
    agent: "build",
    model: {
      id: "fixture-model",
      providerID: "fixture",
      variant: "default",
    },
    text: undefined,
    parts: [
      { type: "reasoning", text: "Look at the retry block first." },
      { type: "text", text: "The retry block races the clock." },
      { type: "tool", name: "shell", status: "completed" },
      { type: "step-start" },
    ],
    detail: undefined,
  },
];

/** The messages our normalized transcript must expose, nothing more. */
describe("fetchMessages normalization", () => {
  it("parses the documented envelope into the trimmed transcript view", async () => {
    const page = await fetchMessages(
      "ses_fixture0001AAAA",
      {},
      async () => sample,
    );
    expect(page.messages).toEqual(expectedTranscript);
  });

  it("forwards limit/order to the emitted argv", async () => {
    let seen: string[] = [];
    await fetchMessages(
      "ses_fixture0001AAAA",
      { limit: 25, order: "asc" },
      async (argv) => {
        seen = argv;
        return sample;
      },
    );
    expect(seen).toEqual(
      messageList("ses_fixture0001AAAA", { limit: 25, order: "asc" }).argv,
    );
  });

  it("undocumented message types degrade to event entries, not failures", async () => {
    const exotic = JSON.stringify({
      data: [{ id: "msg_x1", type: "brand-new-event", time: { created: 1 } }],
    });
    const page = await fetchMessages("ses_x", {}, async () => exotic);
    expect(page.messages[0]!.role).toBe("brand-new-event");
  });
});

describe("fetchMessages failure modes", () => {
  it("non-JSON stdout fails loud (API error bodies land here too)", async () => {
    await expect(
      fetchMessages("ses_x", {}, async () => "HTTP 404 Not Found\n"),
    ).rejects.toThrow(OpenCodeApiError);
  });

  it("envelope drift (no data array) fails loud", async () => {
    await expect(
      fetchMessages("ses_x", {}, async () => JSON.stringify({ data: "nope" })),
    ).rejects.toThrow(/drifted|data/i);
  });

  it("message drift (missing id) fails loud", async () => {
    const bad = JSON.stringify({
      data: [{ type: "user", time: { created: 1 }, text: "t" }],
    });
    await expect(fetchMessages("ses_x", {}, async () => bad)).rejects.toThrow(
      OpenCodeApiError,
    );
  });

  it("non-zero exit (exec rejection) propagates as failure", async () => {
    await expect(
      fetchMessages("ses_x", {}, async () => {
        throw new Error("Command failed: opencode api ... HTTP 404");
      }),
    ).rejects.toThrow();
  });
});
