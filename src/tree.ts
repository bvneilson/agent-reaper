import { execFile, execFileSync } from "node:child_process";

// Process-tree planning and signaling.
//
// Signaling only a child's process group misses descendants that moved to a
// group or session of their own (a shell started by an agent, a dev server
// started with setsid, a browser). Killing the whole tree takes four rules.
//
//   1. Snapshot the process table ONCE, before anything is signaled. When the
//      root dies, its descendants are reparented to init and no later snapshot
//      can tell them from anyone else's processes. Every signal, SIGTERM and
//      the SIGKILL that follows the grace period, is sent from the same plan.
//   2. The planner is pure. It walks the snapshot down from the root and from
//      every member of the root's group, then splits what it finds into groups
//      and single pids. The root's own group is signaled whole, because the
//      caller spawns the root as a group leader and everything in that group
//      belongs to it. Any other group is signaled whole only when every member
//      the snapshot shows is inside the tree. A group shared with anything
//      outside the tree gets its tree members signaled one pid at a time.
//   3. A pid is never signaled unless the snapshot shows it in the tree, so a
//      pid that was recycled after the snapshot cannot be hit by name. Never
//      signaled in any case: a pid or group id of 1 or less, our own pid, our
//      own group, or any ancestor of ours. A root that is us, leads or sits in
//      our group, or has us or one of our ancestors beneath it is refused as a
//      whole, and nothing is signaled.
//   4. When no usable snapshot exists (ps missing, slow, or garbage), the
//      caller falls back to a group-only plan. Nothing here throws.
//
// Only `pid, ppid, pgid, comm` are read from ps. Process arguments are never
// requested, because argv can carry secrets.

/** One row of the process table. */
export interface ProcRow {
  pid: number;
  ppid: number;
  pgid: number;
  /** The command name as ps prints it. Can contain spaces. */
  comm: string;
}

/** What a tree kill signals. */
export interface TreeKillPlan {
  /**
   * The root pid. Its own group (`-rootPid`) is signaled first and whole.
   * Callers spawn the root detached, so it leads that group.
   */
  rootPid: number;
  /** Other process groups wholly inside the tree. Signaled as `-pgid`. */
  groups: number[];
  /** Tree members signaled one by one (their group also holds outsiders). */
  pids: number[];
  /**
   * Set when signaling would hit us or is otherwise unsafe. A refused plan has
   * empty `groups` and `pids`, and {@link signalTree} signals nothing for it.
   * Callers must not fall back to a group kill for a refused plan.
   */
  refused?: string;
}

/** The signature of `process.kill`, injectable for tests. */
export type KillFn = (pid: number, signal: NodeJS.Signals | number) => void;

/**
 * What a signaling pass did, as kill(2) targets: a group is its negative
 * pgid, a single process is its pid. The root's group is `-rootPid`.
 */
export interface TreeSignalResult {
  /** Targets the OS accepted the signal for. */
  signaled: number[];
  /** Targets we may not signal (EPERM) or that failed for another reason. */
  denied: number[];
  /** Targets that no longer exist (ESRCH), or were found dead before a SIGKILL. */
  gone: number[];
}

/** Default bound for one `ps` read. */
export const DEFAULT_SNAPSHOT_TIMEOUT_MS = 2000;

const PS_ARGS = ["-Ao", "pid=,ppid=,pgid=,comm="];
const PS_MAX_BUFFER = 16 * 1024 * 1024;
const PS_ROW = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S.*?)\s*$/;

/**
 * Pure. Parses the output of `ps -Ao pid=,ppid=,pgid=,comm=`. A row is three
 * integers followed by the rest of the line as `comm` (which may contain
 * spaces). Anything else, such as a header, a short row, or an empty line, is
 * skipped.
 */
export function parseProcTable(raw: string): ProcRow[] {
  const rows: ProcRow[] = [];
  for (const line of raw.split("\n")) {
    const m = PS_ROW.exec(line);
    if (m) {
      rows.push({ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), comm: m[4] });
    }
  }
  return rows;
}

/**
 * Reads the process table synchronously. Returns null on any failure, an empty
 * table, or when `timeoutMs <= 0` (Node treats a timeout of 0 as unlimited, so
 * a non-positive value means "skip the snapshot" and `ps` is never spawned).
 */
export function snapshotProcessTable(
  timeoutMs: number = DEFAULT_SNAPSHOT_TIMEOUT_MS,
): ProcRow[] | null {
  if (!(timeoutMs > 0)) return null;
  try {
    const out = execFileSync("ps", PS_ARGS, {
      encoding: "utf-8",
      timeout: timeoutMs,
      maxBuffer: PS_MAX_BUFFER,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const rows = parseProcTable(out);
    return rows.length > 0 ? rows : null;
  } catch {
    return null;
  }
}

/**
 * Async twin of {@link snapshotProcessTable}. Settles within `timeoutMs` even
 * if `ps` hangs, and never rejects. Returns null without spawning `ps` when
 * `timeoutMs <= 0`.
 */
export function snapshotProcessTableAsync(
  timeoutMs: number = DEFAULT_SNAPSHOT_TIMEOUT_MS,
): Promise<ProcRow[] | null> {
  if (!(timeoutMs > 0)) return Promise.resolve(null);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    try {
      execFile(
        "ps",
        PS_ARGS,
        { encoding: "utf-8", timeout: timeoutMs, maxBuffer: PS_MAX_BUFFER },
        (err, stdout) => {
          clearTimeout(timer);
          const rows = err ? [] : parseProcTable(stdout);
          resolve(rows.length > 0 ? rows : null);
        },
      );
    } catch {
      clearTimeout(timer);
      resolve(null);
    }
  });
}

/**
 * Pure. Plans which groups and pids killing `rootPid`'s tree may signal, from
 * one snapshot.
 *
 * Returns:
 * - `null` when the snapshot cannot support a plan: it lacks the root's row or
 *   our own row (`selfPid`). The caller should fall back to
 *   {@link groupOnlyPlan}.
 * - a plan with `refused` set, and empty `pids` and `groups`, when signaling
 *   would hit us: the root is us or has a pid of 1 or less, leads or sits in
 *   our process group, or has us or one of our ancestors beneath it (or in its
 *   group). {@link signalTree} signals nothing for such a plan.
 * - otherwise a plan. It never contains `selfPid`, our ancestors, our group,
 *   or any pid or group id of 1 or less.
 */
export function planTreeKill(
  rootPid: number,
  table: readonly ProcRow[],
  selfPid: number,
): TreeKillPlan | null {
  const refuse = (why: string): TreeKillPlan => ({ rootPid, groups: [], pids: [], refused: why });
  if (!Number.isInteger(rootPid) || rootPid <= 1) {
    return refuse(`pid ${rootPid} is never signaled`);
  }
  const rows = new Map(table.map((r) => [r.pid, r]));
  const self = rows.get(selfPid);
  const root = rows.get(rootPid);
  if (!self || !root) return null;
  if (rootPid === selfPid) return refuse("the root is this process");
  if (rootPid === self.pgid) return refuse("the root leads this process's group");
  if (root.pgid === self.pgid) return refuse("the root is in this process's group");

  // Our ancestors, from the snapshot. A visited set stops a racy ppid cycle.
  const ancestors = new Set<number>();
  for (let p = self.ppid; p > 0 && !ancestors.has(p); p = rows.get(p)?.ppid ?? 0) {
    ancestors.add(p);
  }

  const add = (map: Map<number, number[]>, key: number, pid: number) => {
    const list = map.get(key);
    if (list) list.push(pid);
    else map.set(key, [pid]);
  };
  const children = new Map<number, number[]>();
  const members = new Map<number, number[]>();
  for (const r of table) {
    add(children, r.ppid, r.pid);
    add(members, r.pgid, r.pid);
  }

  // The root, every member of its group, and everything below them.
  const tree = new Set<number>();
  const queue = [rootPid, ...(members.get(rootPid) ?? [])];
  while (queue.length > 0) {
    const pid = queue.shift()!;
    if (tree.has(pid)) continue;
    tree.add(pid);
    for (const child of children.get(pid) ?? []) if (!tree.has(child)) queue.push(child);
  }
  if (tree.has(selfPid)) return refuse("this process is inside the tree");
  for (const a of ancestors) {
    if (tree.has(a)) return refuse("an ancestor of this process is inside the tree");
  }

  const byGroup = new Map<number, number[]>();
  for (const pid of tree) {
    const pgid = rows.get(pid)?.pgid;
    if (pgid === undefined || pgid === rootPid) continue; // not in the table, or in the root's group
    add(byGroup, pgid, pid);
  }
  const groups: number[] = [];
  const pids: number[] = [];
  for (const [pgid, inTree] of byGroup) {
    const whole =
      pgid > 1 && pgid !== self.pgid && (members.get(pgid) ?? []).every((m) => tree.has(m));
    if (whole) groups.push(pgid);
    else {
      pids.push(...inTree.filter((pid) => pid > 1 && pid !== selfPid && !ancestors.has(pid)));
    }
  }
  const ascending = (a: number, b: number) => a - b;
  return { rootPid, groups: groups.sort(ascending), pids: pids.sort(ascending) };
}

/**
 * The fallback plan: signal the root's group and nothing else. Use it when no
 * usable snapshot exists. A pid of 1 or less (or a non-integer) is refused.
 * Without a table this cannot check whether the group is ours, so callers must
 * spawn the root detached (as its own group leader).
 */
export function groupOnlyPlan(pid: number): TreeKillPlan {
  if (!Number.isInteger(pid) || pid <= 1) {
    return { rootPid: pid, groups: [], pids: [], refused: `pid ${pid} is never signaled` };
  }
  return { rootPid: pid, groups: [], pids: [] };
}

const defaultKill: KillFn = (pid, signal) => {
  process.kill(pid, signal as NodeJS.Signals);
};

/** Each target as the kill(2) argument: groups negative, pids positive, root group first. */
function targetsOf(plan: TreeKillPlan): number[] {
  if (plan.refused) return [];
  if (!Number.isInteger(plan.rootPid) || plan.rootPid <= 1) return [];
  const ok = (n: number) => Number.isInteger(n) && n > 1;
  return [
    -plan.rootPid,
    ...plan.groups.filter(ok).map((g) => -g),
    ...plan.pids.filter(ok),
  ];
}

type Answer = "sent" | "gone" | "denied";

function send(target: number, signal: NodeJS.Signals, kill: KillFn): Answer {
  try {
    kill(target, signal);
    return "sent";
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return "gone";
    return "denied";
  }
}

function alive(target: number, kill: KillFn): boolean {
  try {
    kill(target, 0);
    return true;
  } catch (err) {
    // EPERM means it exists and is not ours to signal.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function deliver(
  plan: TreeKillPlan,
  signal: NodeJS.Signals,
  kill: KillFn,
  onlyAlive: boolean,
): TreeSignalResult {
  const result: TreeSignalResult = { signaled: [], denied: [], gone: [] };
  const [rootTarget, ...rest] = targetsOf(plan);
  if (rootTarget === undefined) return result;
  const one = (target: number): Answer => {
    if (onlyAlive && !alive(target, kill)) return "gone";
    return send(target, signal, kill);
  };
  const record = (target: number, answer: Answer) => {
    if (answer === "sent") result.signaled.push(target);
    else if (answer === "gone") result.gone.push(target);
    else result.denied.push(target);
  };
  // EPERM on the root group means the root is not ours, so nothing under it is
  // either. Stop. A root that is already gone does not stop the rest: its
  // descendants must still be reached.
  const rootAnswer = one(rootTarget);
  record(rootTarget, rootAnswer);
  if (rootAnswer === "denied") return result;
  for (const target of rest) record(target, one(target));
  return result;
}

/**
 * Sends one signal to every target of the plan, the root's group first.
 * Nothing is signaled for a refused plan. EPERM on the root group stops
 * everything else. EPERM on any other target is reported in `denied` and the
 * rest are still signaled. ESRCH goes in `gone`. Never throws.
 */
export function signalTree(
  plan: TreeKillPlan,
  signal: NodeJS.Signals,
  kill: KillFn = defaultKill,
): TreeSignalResult {
  return deliver(plan, signal, kill, false);
}

/**
 * After the grace period: SIGKILLs every target of the SAME plan that is still
 * alive. Targets found dead are reported in `gone`. Same refusal and EPERM
 * rules as {@link signalTree}. Never takes a second snapshot.
 */
export function killTreeSurvivors(
  plan: TreeKillPlan,
  kill: KillFn = defaultKill,
): TreeSignalResult {
  return deliver(plan, "SIGKILL", kill, true);
}

/**
 * True if the process group `pgid` still exists. Probes with signal 0.
 * ESRCH means gone. EPERM means alive but not ours. A pgid of 1 or less is
 * never probed, because `-0` addresses the caller's own group.
 */
export function processGroupAlive(pgid: number | undefined, kill: KillFn = defaultKill): boolean {
  if (!pgid || !Number.isInteger(pgid) || pgid <= 1) return false;
  return alive(-pgid, kill);
}
