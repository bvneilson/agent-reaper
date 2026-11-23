import { describe, expect, test } from "vitest";
import type { ProcRow } from "../src/index.js";
import { planChildKill } from "../src/spawn.js";

// Pure: which plan a supervised child is killed by. No process is signaled here.
// The fake pids sit above any real pid range, so they can never name a real process.

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
    expect(plan.refused).toBe("the root's pid was reused after it exited");
    expect(plan).toMatchObject({ rootPid: CHILD, groups: [], pids: [] });
  });

  test("exited: planned from the members its group still has, and what they started", () => {
    // G stayed in the child's group and outlived it; S is G's child in a session of its own.
    const table = [...BASE, row(5_000_300, 1, CHILD), row(5_000_400, 5_000_300, 5_000_400)];
    expect(planChildKill(CHILD, table, false)).toEqual({ rootPid: CHILD, groups: [5_000_400], pids: [] });
  });

  test("exited with nothing left in its group: the group-only plan, which finds nothing to signal", () => {
    expect(planChildKill(CHILD, [...BASE, row(5_000_500, 1, 5_000_500)], false)).toEqual({
      rootPid: CHILD,
      groups: [],
      pids: [],
    });
  });
});
