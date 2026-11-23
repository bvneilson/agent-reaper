import { describe, expect, test } from "vitest";
import {
  groupOnlyPlan,
  killTreeSurvivors,
  parseProcTable,
  planTreeKill,
  processGroupAlive,
  signalTree,
  snapshotProcessTable,
  snapshotProcessTableAsync,
  type KillFn,
  type ProcRow,
  type TreeKillPlan,
} from "../src/index.js";

const SELF = 500;
const row = (pid: number, ppid: number, pgid: number, comm = "proc"): ProcRow => ({
  pid,
  ppid,
  pgid,
  comm,
});
/** init, this process (own group), and a stranger in a group of its own. */
const BASE = [row(1, 0, 1), row(SELF, 1, SELF), row(3000, 1, 3000)];

const errno = (code: string) => Object.assign(new Error(code), { code });

describe("planTreeKill: which groups and pids a tree kill signals", () => {
  const cases: Array<{
    name: string;
    root: number;
    table: ProcRow[];
    groups?: number[];
    pids?: number[];
    refused?: RegExp;
  }> = [
    {
      name: "a shell in its own group, with a build under it",
      root: 1000,
      table: [
        ...BASE,
        row(1000, SELF, 1000), // the root, spawned detached
        row(1001, 1000, 1000), // a helper in the root's group
        row(2000, 1000, 2000), // a shell in a group of its own
        row(2001, 2000, 2000),
        row(2002, 2001, 2000),
      ],
      groups: [2000],
      pids: [],
    },
    {
      name: "nested groups: a dev server and a test runner under the shell, a browser under the runner",
      root: 1000,
      table: [
        ...BASE,
        row(1000, SELF, 1000),
        row(2000, 1000, 2000),
        row(2100, 2000, 2100),
        row(2101, 2100, 2100),
        row(2200, 2000, 2200),
        row(2300, 2200, 2300),
        row(2301, 2300, 2300),
      ],
      groups: [2000, 2100, 2200, 2300],
      pids: [],
    },
    {
      name: "a group shared with a process outside the tree is signaled one tree pid at a time",
      root: 1000,
      table: [
        ...BASE,
        row(1000, SELF, 1000),
        row(2000, 1000, 2000),
        row(2001, 2000, 3000), // in the stranger's group
        row(2002, 2001, 3000),
      ],
      groups: [2000],
      pids: [2001, 2002],
    },
    {
      name: "a member of the root's group whose parent already exited is still in the tree",
      root: 1000,
      table: [...BASE, row(1000, SELF, 1000), row(1001, 1, 1000), row(1600, 1001, 1600)],
      groups: [1600],
      pids: [],
    },
    {
      name: "a root in our own group is refused (a recycled pid now one of our children)",
      root: 1000,
      table: [...BASE, row(1000, SELF, SELF), row(2000, 1000, 2000)],
      refused: /this process's group/,
    },
    {
      name: "a root that leads our own group is refused",
      root: 400,
      table: [row(1, 0, 1), row(400, 1, 400), row(SELF, 400, 400)],
      refused: /this process's group/,
    },
    {
      name: "ourselves as the root is refused",
      root: SELF,
      table: BASE,
      refused: /this process/,
    },
    {
      name: "a root we run under is refused",
      root: 400,
      table: [row(1, 0, 1), row(400, 1, 400), row(SELF, 400, SELF)],
      refused: /inside the tree/,
    },
    {
      name: "pid 1 is refused",
      root: 1,
      table: BASE,
      refused: /never signaled/,
    },
    {
      name: "a descendant in our group or in group 1 is signaled by pid, never by group",
      root: 1000,
      table: [...BASE, row(1000, SELF, 1000), row(2500, 1000, SELF), row(2600, 1000, 1)],
      groups: [],
      pids: [2500, 2600],
    },
    {
      name: "a ppid cycle in a racy table still terminates",
      root: 1000,
      table: [...BASE, row(1000, 2001, 1000), row(2000, 1000, 2000), row(2001, 2000, 2000)],
      groups: [2000],
      pids: [],
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      const plan = planTreeKill(c.root, c.table, SELF);
      expect(plan).not.toBeNull();
      if (c.refused) {
        expect(plan!.refused).toMatch(c.refused);
        expect(plan!.groups).toEqual([]);
        expect(plan!.pids).toEqual([]);
        return;
      }
      expect(plan!.refused).toBeUndefined();
      expect(plan!.rootPid).toBe(c.root);
      expect(plan!.groups).toEqual(c.groups!);
      expect(plan!.pids).toEqual(c.pids!);
    });
  }

  test("null when the table lacks our own row: the snapshot is not trusted", () => {
    expect(planTreeKill(1000, [row(1, 0, 1), row(1000, 1, 1000)], SELF)).toBeNull();
  });

  test("null when the root is not in the table", () => {
    expect(planTreeKill(1000, [...BASE, row(2000, 1, 2000)], SELF)).toBeNull();
  });

  test("a stranger and ourselves are never in a plan", () => {
    const plan = planTreeKill(1000, cases[0].table, SELF)!;
    const all = [plan.rootPid, ...plan.groups, ...plan.pids];
    for (const never of [1, SELF, 3000]) expect(all).not.toContain(never);
  });

  test("planTreeKill excludes selfPid and its ancestors", () => {
    // We run as 500, under a shell 400, under a supervisor 300. The root 1000 is a sibling.
    // The ancestor 400 leads a group that also holds a tree member (2001), so that
    // group may not be signaled whole, and 400 itself must not be signaled by pid.
    const table = [
      row(1, 0, 1),
      row(300, 1, 300),
      row(400, 300, 400),
      row(SELF, 400, SELF),
      row(1000, 300, 1000),
      row(2000, 1000, 2000),
      row(2001, 2000, 400), // in our ancestor's group
      row(2002, 2001, 400),
    ];
    const plan = planTreeKill(1000, table, SELF)!;
    expect(plan.refused).toBeUndefined();
    const all = [plan.rootPid, ...plan.groups, ...plan.pids];
    for (const never of [1, 300, 400, SELF]) expect(all).not.toContain(never);
    expect(plan.groups).toEqual([2000]);
    expect(plan.pids).toEqual([2001, 2002]);
  });

  test("a root whose group holds one of our ancestors is refused", () => {
    const table = [
      row(1, 0, 1),
      row(300, 1, 1000), // our ancestor, in the root's group
      row(SELF, 300, SELF),
      row(1000, 1, 1000),
    ];
    const plan = planTreeKill(1000, table, SELF)!;
    expect(plan.refused).toMatch(/inside the tree/); // we are below that ancestor
    expect(plan.groups).toEqual([]);
    expect(plan.pids).toEqual([]);
  });
});

describe("groupOnlyPlan", () => {
  test("signals the root's group alone", () => {
    expect(groupOnlyPlan(1234)).toEqual({ rootPid: 1234, groups: [], pids: [] });
  });
  test("refuses pid 1 and below", () => {
    for (const pid of [1, 0, -5, Number.NaN]) {
      expect(groupOnlyPlan(pid).refused).toMatch(/never signaled/);
    }
  });
});

describe("parseProcTable", () => {
  test("parses rows with the rest of the line as comm", () => {
    expect(parseProcTable("    1     0     1 /sbin/launchd\n  101     1   101 node\n")).toEqual([
      row(1, 0, 1, "/sbin/launchd"),
      row(101, 1, 101, "node"),
    ]);
  });

  test("a comm with spaces parses as the full rest of the line", () => {
    expect(parseProcTable("  42   1  42 /Applications/Some App.app/Contents/MacOS/Some App\n")).toEqual([
      row(42, 1, 42, "/Applications/Some App.app/Contents/MacOS/Some App"),
    ]);
  });

  test("parseProcTable ignores malformed rows", () => {
    const raw = [
      "  PID  PPID  PGID COMM", // header
      "  101     1", // short row
      "  102     1   102", // no comm
      "  abc   def   ghi node", // non-numeric
      "  1x    2   3 node",
      "",
      "   ",
      "  200   101   101 sh",
    ].join("\n");
    expect(parseProcTable(raw)).toEqual([row(200, 101, 101, "sh")]);
    expect(parseProcTable("")).toEqual([]);
  });
});

describe("the process table snapshot", () => {
  test("the sync and async snapshots both hold this process, with its parent", async () => {
    for (const table of [snapshotProcessTable(), await snapshotProcessTableAsync()]) {
      expect(table).not.toBeNull();
      const me = table!.find((r) => r.pid === process.pid);
      expect(me?.ppid).toBe(process.ppid);
      expect(typeof me?.comm).toBe("string");
    }
  });
});

// A fake OS: `live` holds pids, each in a group. Records every signal.
function fakeOs(table: ProcRow[], termKills: Set<number> = new Set()) {
  const live = new Set(table.map((r) => r.pid));
  const groupOf = new Map(table.map((r) => [r.pid, r.pgid]));
  const calls: Array<[number, NodeJS.Signals | number]> = [];
  const kill: KillFn = (target, signal) => {
    if (signal !== 0) calls.push([target, signal]);
    const hit =
      target < 0
        ? [...live].filter((p) => groupOf.get(p) === -target)
        : live.has(target)
          ? [target]
          : [];
    if (hit.length === 0) throw errno("ESRCH");
    if (signal === "SIGKILL") for (const p of hit) live.delete(p);
    if (signal === "SIGTERM") for (const p of hit) if (termKills.has(p)) live.delete(p);
  };
  return { live, calls, kill };
}

const TREE = [
  ...BASE,
  row(1000, SELF, 1000),
  row(1001, 1000, 1000),
  row(2000, 1000, 2000),
  row(2001, 2000, 2000),
  row(2002, 2001, 2000),
];

describe("signalTree", () => {
  const plan = () => planTreeKill(1000, TREE, SELF)!;

  test("signals the root group first, then the other groups, then pids", () => {
    const os = fakeOs(TREE);
    const r = signalTree(plan(), "SIGTERM", os.kill);
    expect(os.calls).toEqual([
      [-1000, "SIGTERM"],
      [-2000, "SIGTERM"],
    ]);
    expect(r).toEqual({ signaled: [-1000, -2000], denied: [], gone: [] });
  });

  test("SIGTERM, then SIGKILL on the survivors of the same plan", () => {
    const os = fakeOs(TREE, new Set([1000, 1001])); // the shell ignores TERM
    const p = plan();
    signalTree(p, "SIGTERM", os.kill);
    const r = killTreeSurvivors(p, os.kill);
    expect(os.calls.filter(([, s]) => s === "SIGKILL")).toEqual([[-2000, "SIGKILL"]]);
    expect(r.signaled).toEqual([-2000]);
    expect(r.gone).toEqual([-1000]); // already dead, not signaled again
    for (const pid of [1000, 1001, 2000, 2001, 2002]) expect(os.live.has(pid)).toBe(false);
    expect(os.live.has(3000)).toBe(true);
    expect(os.live.has(SELF)).toBe(true);
  });

  test("ESRCH lands in gone, and a gone root does not stop the rest", () => {
    const table = TREE.filter((r) => r.pid !== 1000 && r.pid !== 1001);
    const os = fakeOs(table);
    const r = signalTree(plan(), "SIGTERM", os.kill);
    expect(r.gone).toEqual([-1000]);
    expect(r.signaled).toEqual([-2000]);
  });

  test("EPERM on one non-root pid: it lands in denied and the rest are still signaled", () => {
    const table = [
      ...BASE,
      row(1000, SELF, 1000),
      row(2000, 1000, 2000),
      row(2001, 2000, 3000),
      row(2002, 2001, 3000),
      row(2003, 2001, 3000),
    ];
    const p = planTreeKill(1000, table, SELF)!;
    expect(p.pids).toEqual([2001, 2002, 2003]);
    const os = fakeOs(table);
    const kill: KillFn = (t, s) => {
      if (t === 2002) throw errno("EPERM");
      os.kill(t, s);
    };
    const r = signalTree(p, "SIGTERM", kill);
    expect(r.denied).toEqual([2002]);
    expect(r.signaled).toEqual([-1000, -2000, 2001, 2003]);
  });

  test("EPERM on the root group signals nothing else", () => {
    const os = fakeOs(TREE);
    const kill: KillFn = (t, s) => {
      if (t === -1000) throw errno("EPERM");
      os.kill(t, s);
    };
    const r = signalTree(plan(), "SIGTERM", kill);
    expect(os.calls).toEqual([]);
    expect(r).toEqual({ signaled: [], denied: [-1000], gone: [] });
    expect(killTreeSurvivors(plan(), kill)).toEqual({ signaled: [], denied: [-1000], gone: [] });
  });

  test("a refused plan signals nothing", () => {
    const table = [...BASE, row(1000, SELF, SELF), row(2000, 1000, 2000)];
    const refused = planTreeKill(1000, table, SELF)!;
    expect(refused.refused).toBeDefined();
    const os = fakeOs(table);
    expect(signalTree(refused, "SIGTERM", os.kill)).toEqual({ signaled: [], denied: [], gone: [] });
    expect(killTreeSurvivors(refused, os.kill)).toEqual({ signaled: [], denied: [], gone: [] });
    expect(os.calls).toEqual([]);
  });

  test("a hand-built plan can never reach pid or group 1 or less, or a bad root", () => {
    const os = fakeOs(TREE);
    const bad: TreeKillPlan = { rootPid: 1000, groups: [1, 0, -4], pids: [1, 0, 2.5] };
    signalTree(bad, "SIGTERM", os.kill);
    expect(os.calls).toEqual([[-1000, "SIGTERM"]]);
    os.calls.length = 0;
    signalTree({ rootPid: 1, groups: [], pids: [] }, "SIGTERM", os.kill);
    signalTree({ rootPid: 0, groups: [], pids: [] }, "SIGTERM", os.kill);
    expect(os.calls).toEqual([]);
  });

  test("pid reuse: a pid absent from the snapshot is never signaled", () => {
    // 4000 sat in the tree's neighborhood after the snapshot (a recycled pid). It is
    // not in the table, so it is not in the plan and no signal names it.
    const p = planTreeKill(1000, TREE, SELF)!;
    expect(p.pids).not.toContain(4000);
    const os = fakeOs([...TREE, row(4000, 1, 4000)]);
    signalTree(p, "SIGTERM", os.kill);
    killTreeSurvivors(p, os.kill);
    for (const [target] of os.calls) expect(Math.abs(target)).not.toBe(4000);
    expect(os.live.has(4000)).toBe(true);
  });

  test("an unexpected kill error is reported as denied and never thrown", () => {
    const kill: KillFn = () => {
      throw errno("EINVAL");
    };
    const r = signalTree(plan(), "SIGTERM", kill);
    expect(r.signaled).toEqual([]);
    expect(r.denied).toEqual([-1000]); // a root that cannot be signaled stops the pass
  });
});

describe("processGroupAlive", () => {
  test("ok means alive, EPERM means alive, ESRCH means gone", () => {
    const answer = (code?: string): KillFn => () => {
      if (code) throw errno(code);
    };
    expect(processGroupAlive(1234, answer())).toBe(true);
    expect(processGroupAlive(1234, answer("EPERM"))).toBe(true);
    expect(processGroupAlive(1234, answer("ESRCH"))).toBe(false);
  });

  test("probes the negative pid with signal 0, and never probes 0, 1 or undefined", () => {
    const calls: Array<[number, unknown]> = [];
    const kill: KillFn = (t, s) => {
      calls.push([t, s]);
    };
    processGroupAlive(1234, kill);
    expect(calls).toEqual([[-1234, 0]]);
    for (const bad of [0, 1, -3, undefined]) expect(processGroupAlive(bad, kill)).toBe(false);
    expect(calls).toHaveLength(1);
  });
});
