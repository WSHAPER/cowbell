#!/usr/bin/env node
// cowbell — the literal live e2e from the wait-ownership design:
// wait_start on OUR OWN pane until idle. It MUST fire — self-verifying
// against real herdr, read-only (subscribe + authoritative reads).
//
// Run from inside a herdr-managed pane (HERDR_PANE_ID is injected).
// The wait is owned by THIS process; it fires when the pane's agent
// goes idle (i.e. when the agent that launched this script finishes
// its turn). Evidence is written to the JSON path in argv[2].
//
// CAVEAT (found live): launch this DETACHED (setsid/nohup), not as a
// tracked background task of the watched agent — a tracked task keeps
// the agent's session "working", so the pane never idles and the wait
// can only time out. The watcher must not keep the watched busy.
//
//   node scripts/lib/wait-own-pane.mjs <evidence.json> [timeout_ms]
//
// Requires `npm run build` (uses dist/). Exit 0 only when fired.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createWaitRegistry } from "../../dist/herdr/waits.js";

const outPath = process.argv[2];
const timeoutMs = Number(process.argv[3] ?? 240_000);
const pane = process.env.HERDR_PANE_ID;
const t0 = Date.now();

function evidence(record, note) {
  return {
    pane,
    until: ["idle"],
    timeout_ms: timeoutMs,
    socket: "real herdr (HERDR_SOCKET_PATH or default)",
    note,
    elapsed_ms: Date.now() - t0,
    record,
    fired: record?.state === "fired",
  };
}

function verdict(payload) {
  if (payload.fired)
    return `✓ own-pane wait FIRED (${payload.record.result}) after ${payload.elapsed_ms}ms`;
  return `✗ own-pane wait ${payload.note ?? `ended ${payload.record?.state}`} after ${payload.elapsed_ms}ms`;
}

function exitWith(payload) {
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`);
  console.error(verdict(payload));
  process.exit(payload.fired ? 0 : 1);
}

function requireArgs() {
  if (!outPath || !pane) {
    console.error(
      "usage: wait-own-pane.mjs <evidence.json> [timeout_ms] — and run inside a herdr-managed pane (HERDR_PANE_ID)",
    );
    process.exit(2);
  }
}

async function watchForIdle(waits) {
  const rec = await waits.waitStart(pane, ["idle"], timeoutMs);
  for (;;) {
    const r = waits.waitStatus(rec.wait_id);
    if ("wait_id" in r && r.state !== "pending")
      exitWith(evidence(r, undefined));
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

requireArgs();
try {
  await watchForIdle(createWaitRegistry());
} catch (err) {
  exitWith(evidence(undefined, String(err)));
}
