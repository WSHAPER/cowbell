import { describe, expect, it } from "vitest";
import * as oc from "../src/opencode/spec.js";

/**
 * EXACT argv pins for the opencode api surface, mirroring the herdr
 * spec pins. The opencode drift suite cross-checks these tokens
 * against the captured operation fixture.
 */
describe("opencode argv pins", () => {
  it("messageList: operation + sessionID path param", () => {
    expect(oc.messageList("ses_fixture0001AAAA").argv).toEqual([
      "opencode",
      "api",
      "session.message.list",
      "--param",
      "sessionID=ses_fixture0001AAAA",
    ]);
  });

  it("messageList: limit + order ride as --param query params", () => {
    expect(
      oc.messageList("ses_fixture0001AAAA", { limit: 50, order: "asc" }).argv,
    ).toEqual([
      "opencode",
      "api",
      "session.message.list",
      "--param",
      "sessionID=ses_fixture0001AAAA",
      "--param",
      "limit=50",
      "--param",
      "order=asc",
    ]);
  });

  it("modelList/modelDefault: bare operation ids, no params", () => {
    expect(oc.modelList().argv).toEqual(["opencode", "api", "model.list"]);
    expect(oc.modelDefault().argv).toEqual([
      "opencode",
      "api",
      "model.default",
    ]);
  });
});

describe("opencode input validation", () => {
  const rejects = (fn: () => unknown, needle: string) => {
    expect(fn).toThrow(needle);
  };

  it("session ids must look like ses_...", () => {
    rejects(() => oc.messageList("w36:p1"), "messageList");
    rejects(() => oc.messageList(""), "messageList");
  });

  it("limit is 1..200, order is asc|desc", () => {
    rejects(() => oc.messageList("ses_x", { limit: 0 }), "messageList");
    rejects(() => oc.messageList("ses_x", { limit: 500 }), "messageList");
    rejects(
      () => oc.messageList("ses_x", { order: "newest" as unknown as "asc" }),
      "messageList",
    );
    expect(() =>
      oc.messageList("ses_x", { limit: 200, order: "desc" }),
    ).not.toThrow();
  });
});
