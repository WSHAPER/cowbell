import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseAgentInfo, parseAgentList } from "../src/herdr/outputs.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const fx = (name: string) =>
  readFileSync(path.join(root, "tests", "fixtures", name), "utf8");

/**
 * herdr's JSON stdout contracts, pinned against fixtures captured
 * from the real CLI shape. agent_session{source, agent, kind, value}
 * is the native session reference the structured channel needs.
 */
describe("herdr agent output parsing", () => {
  it("agent get: recognized agents carry agent_session", () => {
    const info = parseAgentInfo(fx("herdr-agent-get.session.json"));
    expect(info.agent).toBe("opencode");
    expect(info.pane_id).toBe("w20:p1");
    expect(info.agent_session).toEqual({
      agent: "opencode",
      kind: "id",
      source: "herdr:opencode",
      value: "ses_fixture0001AAAAAAAAAAAAAAAA",
    });
  });

  it("agent get: pane-level agents simply lack agent_session", () => {
    const info = parseAgentInfo(fx("herdr-agent-get.no-session.json"));
    expect(info.name).toBe("agent-comm");
    expect(info.agent_session).toBeUndefined();
  });

  it("agent list: entries share the same contract", () => {
    const agents = parseAgentList(fx("herdr-agent-list.json"));
    expect(agents).toHaveLength(2);
    expect(agents[0]!.agent_session?.value).toBe(
      "ses_fixture0001AAAAAAAAAAAAAAAA",
    );
    expect(agents[1]!.agent_session).toBeUndefined();
  });

  it("non-JSON stdout fails loud with the parser named", () => {
    expect(() => parseAgentInfo("not json")).toThrow("parseAgentInfo");
  });

  it("contract drift (result.agent missing) fails loud", () => {
    expect(() =>
      parseAgentInfo(JSON.stringify({ result: { type: "agent_info" } })),
    ).toThrow(/drifted/);
    expect(() =>
      parseAgentInfo(
        JSON.stringify({
          result: { agent: { agent: "" }, type: "agent_info" },
        }),
      ),
    ).toThrow(/drifted/);
  });

  it("envelope drift (wrong type marker) fails loud", () => {
    expect(() =>
      parseAgentInfo(
        JSON.stringify({ result: { agent: {}, type: "agent_list" } }),
      ),
    ).toThrow(/drifted/);
  });
});
