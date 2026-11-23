import { beforeEach, describe, expect, test, vi } from "vitest";

const spawned = vi.hoisted(() => ({ sync: vi.fn(), async: vi.fn() }));
vi.mock("node:child_process", () => ({
  execFileSync: spawned.sync,
  execFile: spawned.async,
}));

import { snapshotProcessTable, snapshotProcessTableAsync } from "../src/tree.js";

describe("a non-positive snapshot timeout never spawns ps", () => {
  beforeEach(() => {
    spawned.sync.mockReset();
    spawned.async.mockReset();
  });

  test("snapshotProcessTable(0) returns null without spawning", () => {
    for (const t of [0, -1, Number.NaN]) expect(snapshotProcessTable(t)).toBeNull();
    expect(spawned.sync).not.toHaveBeenCalled();
  });

  test("snapshotProcessTableAsync(0) returns null without spawning", async () => {
    for (const t of [0, -1, Number.NaN]) expect(await snapshotProcessTableAsync(t)).toBeNull();
    expect(spawned.async).not.toHaveBeenCalled();
  });

  test("a positive timeout does spawn ps (the guard is not vacuous)", () => {
    spawned.sync.mockReturnValue("  7  1  7 node\n");
    expect(snapshotProcessTable(50)).toEqual([{ pid: 7, ppid: 1, pgid: 7, comm: "node" }]);
    expect(spawned.sync).toHaveBeenCalledTimes(1);
    expect(spawned.sync.mock.calls[0][1]).toEqual(["-Ao", "pid=,ppid=,pgid=,comm="]);
  });
});
