import { describe, expect, test, vi } from "vitest";
import type { ProcRow } from "../src/index.js";
import { killTree, planChildKill } from "../src/spawn.js";
import { snapshotProcessTableAsync } from "../src/tree.js";

// Which plan a supervised child, or a killTree root, is killed by. No process is signaled
// here: killTree runs on an injected table with process.kill mocked. The fake pids sit above
// any real pid range, so they could never name a real process anyway.

vi.mock("../src/tree.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/tree.js")>();
  return { ...real, snapshotProcessTableAsync: vi.fn(real.snapshotProcessTableAsync) };
});

const SELF = process.pid;
const CHILD = 5_000_100;
const row = (pid: number, ppid: number, pgid: number): ProcRow => ({ pid, ppid, pgid, comm: "node" });
/** init and this process, with its ancestry complete. */
const BASE = [row(1, 0, 1), row(SELF, 1, SELF)];

describe("planChildKill", () => {
  test("no snapshot: the child's own group, and nothing else", () => {
    expect(planChildKill(CHILD, null, true)).toEqual({ rootPid: CHILD, groups: [], pids: [] });
    expect(planChildKill(CHILD, null, false)).toEqual({ rootPid: CHILD, groups: [], pids: [] });
  });

  test("running: planned from the child's row, a grandchild in its own session included", () => {
    const table = [...BASE, row(CHILD, SELF, CHILD), row(5_000_200, CHILD, 5_000_200)];
    expect(planChildKill(CHILD, table, true)).toEqual({ rootPid: CHILD, groups: [5_000_200], pids: [] });
  });

  test("exited, but a row still has the child's pid: the pid was reused, so nothing is planned", () => {
    // Shaped like a live child with a grandchild, so only the exit makes it a stranger's tree.
    const table = [...BASE, row(CHILD, 1, CHILD), row(5_000_200, CHILD, 5_000_200)];
    const plan = planChildKill(CHILD, table, false);
    expect(plan?.refused).toBe("the root's pid was reused after it exited");
    expect(plan).toMatchObject({ rootPid: CHILD, groups: [], pids: [], refusal: "pid-reused" });
  });

  test("exited: planned from the members its group still has, and what they started", () => {
    // G stayed in the child's group and outlived it; S is G's child in a session of its own.
    const table = [...BASE, row(5_000_300, 1, CHILD), row(5_000_400, 5_000_300, 5_000_400)];
    expect(planChildKill(CHILD, table, false)).toEqual({ rootPid: CHILD, groups: [5_000_400], pids: [] });
  });

  test("exited, and the snapshot shows nothing left of its group: nothing to signal", () => {
    // Its pid is free by now, so even its group id may name a stranger's new group.
    expect(planChildKill(CHILD, [...BASE, row(5_000_500, 1, 5_000_500)], false)).toBeNull();
  });

  test("exited, with a snapshot that lacks our own row: treated as no snapshot, the group-only plan", () => {
    expect(planChildKill(CHILD, [row(1, 0, 1), row(5_000_500, 1, 5_000_500)], false)).toEqual({
      rootPid: CHILD,
      groups: [],
      pids: [],
    });
  });
});

describe("planChildKill when ps hides one of our ancestors", () => {
  // Our parent's row is missing, as under a ps that hides other users' processes.
  const HIDDEN = [row(1, 0, 1), row(SELF, 5_000_900, SELF)];

  test("the child still runs: the group-only plan, since its own group is provably ours", () => {
    const table = [...HIDDEN, row(CHILD, SELF, CHILD), row(5_000_200, CHILD, 5_000_200)];
    expect(planChildKill(CHILD, table, true)).toEqual({ rootPid: CHILD, groups: [], pids: [] });
  });

  test("the child has exited: still refused, nothing is signaled", () => {
    const table = [...HIDDEN, row(5_000_300, 1, CHILD)];
    expect(planChildKill(CHILD, table, false)).toMatchObject({ groups: [], pids: [], refusal: "unknown-ancestry" });
  });

  test("any other refusal still signals nothing, even while the child runs", () => {
    const table = [...HIDDEN, row(CHILD, SELF, SELF)]; // the child's row sits in our own group
    expect(planChildKill(CHILD, table, true)).toMatchObject({ groups: [], pids: [], refusal: "in-our-group" });
  });
});

describe("killTree with a snapshot that lacks the root's row", () => {
  const calls: Array<[number, unknown]> = [];
  /** killTree(root) planned from `table`, with every kill recorded and none sent. */
  const run = async (root: number, table: ProcRow[] | null) => {
    calls.length = 0;
    vi.mocked(snapshotProcessTableAsync).mockResolvedValueOnce(table);
    const spy = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      calls.push([pid, signal]);
      return true;
    });
    try {
      return await killTree(root, { graceMs: 0 });
    } finally {
      spy.mockRestore();
    }
  };

  test("our own group, whose leader exited: denied, and nothing is signaled", async () => {
    // We and our parent sit in group LEADER, and the process that led it is gone.
    const LEADER = 5_000_450;
    const table = [row(1, 0, 1), row(5_000_400, 1, LEADER), row(SELF, 5_000_400, LEADER)];
    const outcome = await run(LEADER, table);
    expect(calls).toEqual([]);
    expect(outcome).toBe("denied");
  });

  test("an ancestor's group, whose leader exited: denied, and nothing is signaled", async () => {
    // Our grandparent 5_000_300 sits in group 5_000_350, and the process that led it is gone.
    const table = [
      row(1, 0, 1),
      row(5_000_300, 1, 5_000_350),
      row(5_000_400, 5_000_300, 5_000_400),
      row(SELF, 5_000_400, SELF),
    ];
    const outcome = await run(5_000_350, table);
    expect(calls).toEqual([]);
    expect(outcome).toBe("denied");
  });

  test("nothing left of the root or its group: gone, and nothing is signaled", async () => {
    const outcome = await run(5_000_100, [...BASE, row(5_000_500, 1, 5_000_500)]);
    expect(calls).toEqual([]);
    expect(outcome).toBe("gone");
  });

  test("a stranger's exited root with survivors: its tree is signaled, with every exclusion intact", async () => {
    const ROOT = 5_000_600;
    const table = [
      ...BASE,
      row(5_000_610, 1, ROOT), // left in the exited root's group
      row(5_000_620, 5_000_610, 5_000_620), // its child, in a group of its own
      row(5_000_630, 5_000_610, SELF), // its child, in our group: by pid, never our group whole
    ];
    expect(await run(ROOT, table)).toBe("done");
    expect(calls.filter(([, signal]) => signal === "SIGTERM")).toEqual([
      [-ROOT, "SIGTERM"],
      [-5_000_620, "SIGTERM"],
      [5_000_630, "SIGTERM"],
    ]);
    for (const [target] of calls) expect([SELF, -SELF]).not.toContain(target);
  });

  test("a failed snapshot, or one without this process's own row, still means the group-only kill", async () => {
    for (const table of [null, [row(1, 0, 1), row(5_000_710, 1, 5_000_700)]]) {
      expect(await run(5_000_700, table)).toBe("done");
      expect(calls.filter(([, signal]) => signal === "SIGTERM")).toEqual([[-5_000_700, "SIGTERM"]]);
    }
  });
});

describe("killTree with a root that can never be signaled", () => {
  const calls: Array<[number, unknown]> = [];
  const run = async (root: number, table: ProcRow[] | null) => {
    calls.length = 0;
    vi.mocked(snapshotProcessTableAsync).mockResolvedValueOnce(table);
    const spy = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      calls.push([pid, signal]);
      return true;
    });
    try {
      return await killTree(root, { graceMs: 0 });
    } finally {
      spy.mockRestore();
    }
  };

  test("0, a negative pid, 1 and a non-integer are denied, not gone, with or without a snapshot", async () => {
    for (const root of [0, -5, 1, 1.5, Number.NaN]) {
      for (const table of [BASE, null]) {
        expect(await run(root, table)).toBe("denied");
        expect(calls).toEqual([]);
      }
    }
  });
});

describe("killTree when some targets answer EPERM", () => {
  const ROOT = 5_001_000;
  // The root's group, a child in a group of its own, and a grandchild in another one.
  const table = [
    ...BASE,
    row(ROOT, SELF, ROOT),
    row(5_001_100, ROOT, 5_001_100),
    row(5_001_200, ROOT, 5_001_200),
  ];
  const run = async (denied: (pid: number) => boolean) => {
    const calls: Array<[number, unknown]> = [];
    vi.mocked(snapshotProcessTableAsync).mockResolvedValueOnce(table);
    const spy = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      calls.push([pid, signal]);
      if (denied(pid)) throw Object.assign(new Error("EPERM"), { code: "EPERM" });
      return true;
    });
    try {
      return { outcome: await killTree(ROOT, { graceMs: 0 }), calls };
    } finally {
      spy.mockRestore();
    }
  };

  test("a non-root target: denied is reported, and the other targets are still signaled", async () => {
    const { outcome, calls } = await run((pid) => pid === -5_001_100);
    expect(outcome).toBe("denied");
    const term = calls.filter(([, s]) => s === "SIGTERM").map(([pid]) => pid);
    expect(term).toEqual([-ROOT, -5_001_100, -5_001_200]);
    expect(calls.filter(([, s]) => s === "SIGKILL").map(([pid]) => pid)).toContain(-5_001_200);
  });

  test("the root's own group: denied, and nothing else is signaled", async () => {
    const { outcome, calls } = await run((pid) => pid === -ROOT);
    expect(outcome).toBe("denied");
    expect(calls).toEqual([[-ROOT, "SIGTERM"]]);
  });
});
