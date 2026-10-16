import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  AGENT_STATUS_EVENT,
  EVENTS_SUBSCRIBE_METHOD,
  agentStatusSubscription,
} from "../src/herdr/socket.js";
import { AGENT_STATUSES } from "../src/herdr/schemas.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const fixture = path.join(
  root,
  "tests",
  "fixtures",
  "herdr-events-surface.json",
);

interface CapturedSurface {
  protocol: number;
  subscribe_method: string;
  subscribe_params_required: string[];
  agent_status_subscription: {
    type: string;
    required: string[];
    optional: string[];
  };
  event_kinds: string[];
  agent_status_event_required: string[];
  agent_statuses: string[];
}

function loadSurface(): CapturedSurface {
  if (!existsSync(fixture)) {
    throw new Error(
      "tests/fixtures/herdr-events-surface.json missing — run: bash scripts/dump-herdr-events-surface.sh",
    );
  }
  return JSON.parse(readFileSync(fixture, "utf8")) as CapturedSurface;
}

/**
 * The herdr events-socket drift tripwire (twin of
 * upstream.drift.test.ts / opencode.drift.test.ts).
 *
 * The fixture is the captured events.subscribe surface from the
 * running herdr server's bundled API schema (regenerate: bash
 * scripts/dump-herdr-events-surface.sh). When herdr renames the
 * method, the subscription type, or drops a field the wait registry
 * reads, this fails naming the exact token.
 */
describe("herdr events socket drift", () => {
  const surface = loadSurface();

  it("fixture pins the method identity", () => {
    expect(surface.subscribe_method).toBe("events.subscribe");
    expect(surface.protocol).toBeGreaterThan(0);
  });

  it("method we emit exists upstream", () => {
    expect(EVENTS_SUBSCRIBE_METHOD).toBe(surface.subscribe_method);
  });

  it("subscription entry we emit is a declared variant", () => {
    const sub = agentStatusSubscription("w1:p1");
    expect(sub.type).toBe(surface.agent_status_subscription.type);
    expect(sub.type).toBe(AGENT_STATUS_EVENT);
    for (const key of Object.keys(sub)) {
      expect(
        [
          ...surface.agent_status_subscription.required,
          ...surface.agent_status_subscription.optional,
        ],
        `subscription key \`${key}\` is not declared on the captured pane.agent_status_changed variant — HERDR DRIFT. Regenerate the fixture (npm run reference:herdr-events) and update src/herdr/socket.ts.`,
      ).toContain(key);
    }
  });

  it("subscribe params wrap the entries in subscriptions", () => {
    expect(surface.subscribe_params_required).toEqual(["subscriptions"]);
  });

  it("event kind we parse exists upstream", () => {
    expect(surface.event_kinds).toContain(AGENT_STATUS_EVENT);
  });

  it("fields we read are required upstream", () => {
    for (const field of ["pane_id", "agent_status"]) {
      expect(
        surface.agent_status_event_required,
        `PaneAgentStatusChangedEvent field \`${field}\` is no longer required upstream — HERDR DRIFT. Regenerate the fixture and update src/herdr/socket.ts.`,
      ).toContain(field);
    }
  });

  it("status vocabulary matches upstream", () => {
    expect(AGENT_STATUSES).toEqual(surface.agent_statuses);
  });
});
