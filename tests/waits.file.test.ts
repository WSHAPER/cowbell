import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendFile, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WAIT_STATES,
  createWaitRegistry,
  fileWaitRecordSchema,
  type FileWaitRecord,
  type WaitRegistry,
  type WaitState,
} from "../src/herdr/waits.js";

/**
 * Real-tmp-file unit tests for the file-wait half of the session-owned
 * registry (file_wait_start): the report-marker watch with the
 * last-write-stability gate. No mock socket needed — file waits never
 * touch the herdr socket; they poll the local filesystem, which these
 * tests exercise for real under os.tmpdir().
 */

/** Every record the registry hands out must satisfy the pinned contract. */
function contract(r: FileWaitRecord): WaitState {
  expect(fileWaitRecordSchema.parse(r)).toEqual(r);
  expect(WAIT_STATES).toContain(r.state);
  return r.state;
}

function one(waits: WaitRegistry, id: string): FileWaitRecord {
  const r = waits.waitStatus(id);
  if (!("wait_id" in r) || !("marker" in r))
    throw new Error(`expected one file wait, got ${JSON.stringify(r)}`);
  return r;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Backdate mtime so an existing file counts as long-quiet. */
async function backdate(path: string, ms = 10_000): Promise<void> {
  const when = new Date(Date.now() - ms);
  await utimes(path, when, when);
}

let dir: string;
const file = (name: string): string => join(dir, name);

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cowbell-filewait-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("file waits: immediate fire", () => {
  it("fires at start (no poller) when the marker is present and the file is already quiet", async () => {
    const path = file("report.md");
    await writeFile(path, "# Work log\n## Residual candidates\n- none\n");
    await backdate(path);
    const reg = createWaitRegistry();
    const rec = await reg.fileWaitStart(
      path,
      "^#{1,6}\\s*(Status|Residual)\\s+candidates",
      200,
      5_000,
    );
    expect(contract(rec)).toBe("fired");
    expect(rec.target).toBe(path);
    expect(rec.marker).toBe("^#{1,6}\\s*(Status|Residual)\\s+candidates");
    expect(rec.stability_ms).toBe(200);
    expect(rec.timeout_ms).toBe(5_000);
    expect(rec.result?.line).toBe("## Residual candidates");
    // Integer-ms mtime as the filesystem itself reports it (same
    // rounding on both sides of the comparison).
    const { stat } = await import("node:fs/promises");
    expect(rec.result?.mtime_ms).toBe(Math.round((await stat(path)).mtimeMs));
    // The fired record stays visible in the process-owned list.
    expect(reg.waitStatus()).toEqual({ waits: [rec] });
  });

  it("does NOT fire immediately when the marker is present but the file was just written", async () => {
    const path = file("report.md");
    await writeFile(path, "## Done\n"); // mtime = now: quiet window not served yet
    const reg = createWaitRegistry();
    const rec = await reg.fileWaitStart(path, "^## Done$", 400, 5_000);
    expect(rec.state).toBe("pending");
    await vi.waitFor(
      () => expect(contract(one(reg, rec.wait_id))).toBe("fired"),
      { timeout: 3_000 },
    );
    expect(one(reg, rec.wait_id).result?.line).toBe("## Done");
  });
});

describe("file waits: the false-positive cures", () => {
  it("progressive writes fire only after the FINAL chunk has been quiet", async () => {
    const path = file("report.md");
    await writeFile(path, "# report\n");
    const reg = createWaitRegistry();
    const rec = await reg.fileWaitStart(path, "^## Done$", 250, 8_000);
    expect(rec.state).toBe("pending");
    for (const chunk of ["## Section A\n", "body text\n", "## Done\nfinal\n"]) {
      await sleep(150);
      await appendFile(path, chunk);
    }
    // Marker IS present now (~150ms of quiet) but stability_ms is 250.
    await sleep(100);
    expect(one(reg, rec.wait_id).state).toBe("pending");
    await vi.waitFor(
      () => expect(contract(one(reg, rec.wait_id))).toBe("fired"),
      { timeout: 3_000 },
    );
    expect(one(reg, rec.wait_id).result?.line).toBe("## Done");
  });

  it("a marker seen EARLY cannot fire: every later write resets the quiet clock", async () => {
    const path = file("report.md");
    await writeFile(path, "# report\n## Done\n"); // marker present from byte one
    const reg = createWaitRegistry();
    const rec = await reg.fileWaitStart(path, "^## Done$", 400, 8_000);
    await sleep(200);
    await appendFile(path, "appendix written later\n");
    await sleep(200);
    await appendFile(path, "even more content\n");
    // Without the reset this would have fired at ~t0+400; with it, the
    // clock restarted at the last observed write (~t400).
    await sleep(150); // ~t550: past the naive threshold, far from the real one
    expect(one(reg, rec.wait_id).state).toBe("pending");
    await vi.waitFor(() => expect(one(reg, rec.wait_id).state).toBe("fired"), {
      timeout: 4_000,
    });
  });

  it(
    "regex markers survive heading drift; the literal grep that broke the fleet does not",
    headingDriftSurvival,
  );
});

async function headingDriftSurvival() {
  const path = file("report.md");
  // The observed drift: watchers grepped "Status: done", reports said otherwise.
  await writeFile(
    path,
    "# Work log\n## Residual candidates\n### Status — done\n",
  );
  await backdate(path);
  const reg = createWaitRegistry();

  const tolerant = await reg.fileWaitStart(
    path,
    "^#{1,6}\\s*(Status|Residual)",
    150,
    5_000,
  );
  expect(tolerant.state).toBe("fired");
  expect(tolerant.result?.line).toBe("## Residual candidates");

  // The literal grep that broke the fleet ("Status: done") misses the
  // drifted heading entirely — pinned on a fresh copy via timeout.
  const path2 = file("report2.md");
  await writeFile(path2, "# Work log\n## Residual candidates\n");
  await backdate(path2);
  const literal = await reg.fileWaitStart(path2, "^Status: done$", 150, 300);
  expect(literal.state).toBe("pending");
  await vi.waitFor(
    () => expect(one(reg, literal.wait_id).state).toBe("timed_out"),
    {
      timeout: 2_000,
    },
  );
}

describe("file waits: start-time validation (fail fast, clear reason)", () => {
  it("rejects a missing path", async () => {
    const reg = createWaitRegistry();
    await expect(
      reg.fileWaitStart(join(dir, "ghost.md"), "^##", 100, 1_000),
    ).rejects.toThrow(/does not exist/);
  });

  it("rejects a relative path", async () => {
    const reg = createWaitRegistry();
    await expect(
      reg.fileWaitStart("tmp/report.md", "^##", 100, 1_000),
    ).rejects.toThrow(/absolute/);
  });

  it("rejects a directory", async () => {
    const reg = createWaitRegistry();
    await expect(reg.fileWaitStart(dir, "^##", 100, 1_000)).rejects.toThrow(
      /not a regular file/,
    );
  });

  it("rejects an invalid marker regex", async () => {
    const path = file("report.md");
    await writeFile(path, "x\n");
    const reg = createWaitRegistry();
    await expect(
      reg.fileWaitStart(path, "^([unclosed", 100, 1_000),
    ).rejects.toThrow(/not a valid regular expression/);
  });
});

describe("file waits: timeout, deletion, cancel", () => {
  it("times out client-side when the marker never appears", async () => {
    const path = file("report.md");
    await writeFile(path, "# partial report, marker never written\n");
    const reg = createWaitRegistry();
    const rec = await reg.fileWaitStart(path, "^## Done$", 100, 300);
    expect(rec.state).toBe("pending");
    await vi.waitFor(
      () => expect(contract(one(reg, rec.wait_id))).toBe("timed_out"),
      { timeout: 2_000 },
    );
    const after = one(reg, rec.wait_id);
    expect(after.result).toBeUndefined();
    expect(after.reason).toBeUndefined();
  });

  it("fails (never rots pending) when the file is deleted mid-wait", async () => {
    const path = file("report.md");
    await writeFile(path, "# in progress\n");
    const reg = createWaitRegistry();
    const rec = await reg.fileWaitStart(path, "^## Done$", 200, 8_000);
    await sleep(100);
    await rm(path);
    await vi.waitFor(
      () => expect(contract(one(reg, rec.wait_id))).toBe("failed"),
      { timeout: 2_000 },
    );
    expect(one(reg, rec.wait_id).reason).toMatch(/deleted/);
    // Failed stays reportable — it is a terminal state, not a forgotten one.
    expect(one(reg, rec.wait_id).result).toBeUndefined();
  });

  it("cancel forgets the wait; a later marker cannot resurrect it", async () => {
    const path = file("report.md");
    await writeFile(path, "# partial\n");
    const reg = createWaitRegistry();
    const rec = await reg.fileWaitStart(path, "^## Done$", 200, 8_000);
    expect(reg.waitCancel({ wait_id: rec.wait_id })).toEqual({
      cancelled: [rec.wait_id],
    });
    expect(reg.waitStatus()).toEqual({ waits: [] });
    await appendFile(path, "## Done\n");
    await backdate(path, 5_000);
    await sleep(400); // past marker + stability: still nothing
    expect(() => reg.waitStatus(rec.wait_id)).toThrow(/not owned/);
  });
});

describe("file waits: one registry, ids intermix", () => {
  it("two waits on the SAME path track different markers independently (shared poller)", async () => {
    const path = file("report.md");
    await writeFile(path, "# log\n## Residual candidates\n");
    await backdate(path);
    const reg = createWaitRegistry();
    const hit = await reg.fileWaitStart(path, "^## Residual", 150, 5_000);
    const miss = await reg.fileWaitStart(path, "^## Done$", 150, 400);
    expect(hit.state).toBe("fired"); // immediate: matched + already quiet
    await vi.waitFor(
      () => expect(one(reg, miss.wait_id).state).toBe("timed_out"),
      {
        timeout: 2_000,
      },
    );
    const all = reg.waitStatus() as { waits: FileWaitRecord[] };
    expect(all.waits.map((w) => w.wait_id).sort()).toEqual(
      [hit.wait_id, miss.wait_id].sort(),
    );
  });

  it("waitCancel({all:true}) clears file waits across paths", async () => {
    const a = file("a.md");
    const b = file("b.md");
    await writeFile(a, "# a\n");
    await writeFile(b, "# b\n");
    const reg = createWaitRegistry();
    const wa = await reg.fileWaitStart(a, "^##", 200, 8_000);
    const wb = await reg.fileWaitStart(b, "^##", 200, 8_000);
    const cancelled = reg.waitCancel({ all: true });
    expect(cancelled.cancelled.sort()).toEqual([wa.wait_id, wb.wait_id].sort());
    expect(reg.waitStatus()).toEqual({ waits: [] });
  });
});
