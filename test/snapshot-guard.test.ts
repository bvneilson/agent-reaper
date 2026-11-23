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

describe("the timeout is normalized before it reaches node", () => {
  beforeEach(() => {
    spawned.sync.mockReset();
    spawned.async.mockReset();
  });

  test("a fractional timeout is rounded up to an integer, not dropped", () => {
    spawned.sync.mockReturnValue("  7  1  7 node\n");
    expect(snapshotProcessTable(50.5)).not.toBeNull();
    expect(spawned.sync.mock.calls[0][2].timeout).toBe(51);
  });

  test("an oversized timeout is clamped to the largest timer value, sync and async", async () => {
    vi.useFakeTimers();
    try {
      spawned.sync.mockReturnValue("  7  1  7 node\n");
      snapshotProcessTable(2 ** 40);
      expect(spawned.sync.mock.calls[0][2].timeout).toBe(2 ** 31 - 1);
      let pending = true;
      void snapshotProcessTableAsync(2 ** 40).then(() => {
        pending = false;
      });
      await vi.advanceTimersByTimeAsync(20);
      expect(spawned.async.mock.calls[0][2].timeout).toBe(2 ** 31 - 1);
      expect(pending).toBe(true); // the timer did not fire after 20 ms
      vi.clearAllTimers(); // nothing is left pending in the worker
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a ps that fails, hangs or prints garbage gives null, never a throw", () => {
  beforeEach(() => {
    spawned.sync.mockReset();
    spawned.async.mockReset();
  });

  test("sync: ps throwing (missing, non-zero exit, timeout) gives null", () => {
    spawned.sync.mockImplementation(() => {
      throw Object.assign(new Error("spawnSync ps ENOENT"), { code: "ENOENT" });
    });
    expect(snapshotProcessTable(50)).toBeNull();
  });

  test("sync: output with no parsable row (garbage, a header only, nothing) gives null", () => {
    for (const out of ["", "\n\n", "PID PPID PGID COMM\n", "not a table\nat all\n"]) {
      spawned.sync.mockReturnValue(out);
      expect(snapshotProcessTable(50)).toBeNull();
    }
  });

  test("async: an error from ps, with or without output, gives null", async () => {
    spawned.async.mockImplementation((_cmd, _args, _opts, cb) => cb(new Error("ps failed"), "  7  1  7 node\n"));
    expect(await snapshotProcessTableAsync(50)).toBeNull();
  });

  test("async: output with no parsable row gives null", async () => {
    for (const out of ["", "PID PPID PGID COMM\n", "not a table\n"]) {
      spawned.async.mockImplementation((_cmd, _args, _opts, cb) => cb(null, out));
      expect(await snapshotProcessTableAsync(50)).toBeNull();
    }
  });

  test("async: execFile throwing synchronously gives null", async () => {
    spawned.async.mockImplementation(() => {
      throw new Error("spawn failed");
    });
    expect(await snapshotProcessTableAsync(50)).toBeNull();
  });

  test("async: a ps that never answers is given up on at the timeout", async () => {
    vi.useFakeTimers();
    try {
      spawned.async.mockImplementation(() => undefined); // the callback is never called
      let result: unknown = "pending";
      void snapshotProcessTableAsync(30).then((rows) => {
        result = rows;
      });
      await vi.advanceTimersByTimeAsync(29);
      expect(result).toBe("pending");
      await vi.advanceTimersByTimeAsync(2);
      expect(result).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  test("both reads make node SIGKILL a ps that outlives the timeout, not just SIGTERM it", async () => {
    spawned.sync.mockReturnValue("  7  1  7 node\n");
    spawned.async.mockImplementation((_cmd, _args, _opts, cb) => cb(null, "  7  1  7 node\n"));
    snapshotProcessTable(50);
    await snapshotProcessTableAsync(50);
    expect(spawned.sync.mock.calls[0][2].killSignal).toBe("SIGKILL");
    expect(spawned.async.mock.calls[0][2].killSignal).toBe("SIGKILL");
  });
});
