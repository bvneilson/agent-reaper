import { execFile, execFileSync } from "node:child_process";
import { timerMs } from "./timer.js";

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
//      pid that was not in the snapshot cannot be hit by name. (A pid that IS
//      in the plan and is recycled during the grace window can still take the
//      SIGKILL.) A plan from a snapshot never signals a pid or group id of 1
//      or less, our own pid, our own group, or any ancestor of ours. A root
//      that is us, leads or sits in our group, or has us or one of our
//      ancestors beneath it is refused as a whole, and nothing is signaled.
//      So is any plan from a snapshot that does not show our ancestors all
//      the way up, since an ancestor the snapshot cannot see cannot be kept
//      out of the plan.
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
   * Set when signaling would hit us or is otherwise unsafe: why, in words. A
   * refused plan has empty `groups` and `pids`, and {@link signalTree} signals
   * nothing for it. Callers must not fall back to a group kill for a refused
   * plan.
   */
  refused?: string;
  /** Why the plan was refused, as a code to branch on. Set whenever `refused` is. */
  refusal?: TreeKillRefusal;
}

/**
 * Why a plan was refused.
 * - `invalid-root`: the root pid is 1 or less, or not an integer.
 * - `self`: the root is this process.
 * - `parent`: the root is this process's parent ({@link groupOnlyPlan}).
 * - `leads-our-group` / `in-our-group`: the root leads, or sits in, this
 *   process's group.
 * - `self-in-tree`: this process (and so the ancestors above it) is inside the tree.
 * - `unknown-ancestry`: the snapshot does not show this process's ancestors
 *   back to pid 1. Reported only when no other reason applies.
 * - `pid-reused`: the root exited, and its pid now names another process.
 */
export type TreeKillRefusal =
  | "invalid-root"
  | "self"
  | "parent"
  | "leads-our-group"
  | "in-our-group"
  | "self-in-tree"
  | "unknown-ancestry"
  | "pid-reused";

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
const PS_ROW = /^\s*(\d+)\s+(\d+)\s+(\d+)(?:\s+(.*?))?\s*$/;

/**
 * Pure. Parses the output of `ps -Ao pid=,ppid=,pgid=,comm=`. A row is three
 * integers followed by the rest of the line as `comm` (which may contain
 * spaces, and may be empty: pid, ppid and pgid carry the safety, and dropping
 * a row would let a group look wholly inside the tree). Anything else, such as
 * a header, a short row, or an empty line, is skipped.
 */
export function parseProcTable(raw: string): ProcRow[] {
  const rows: ProcRow[] = [];
  for (const line of raw.split("\n")) {
    const m = PS_ROW.exec(line);
    if (m) {
      rows.push({ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), comm: m[4] ?? "" });
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
  const ms = timerMs(timeoutMs);
  if (ms === null) return null;
  try {
    const out = execFileSync("ps", PS_ARGS, {
      encoding: "utf-8",
      timeout: ms,
      killSignal: "SIGKILL",
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
 * `timeoutMs <= 0`. A fractional timeout is rounded up and an oversized one is
 * clamped to the largest timer value.
 */
export function snapshotProcessTableAsync(
  timeoutMs: number = DEFAULT_SNAPSHOT_TIMEOUT_MS,
): Promise<ProcRow[] | null> {
  const ms = timerMs(timeoutMs);
  if (ms === null) return Promise.resolve(null);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    try {
      execFile(
        "ps",
        PS_ARGS,
        { encoding: "utf-8", timeout: ms, killSignal: "SIGKILL", maxBuffer: PS_MAX_BUFFER },
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

const UNKNOWN_ANCESTRY = "the snapshot does not show this process's ancestors back to pid 1";

/**
 * Pure. Plans which groups and pids killing `rootPid`'s tree may signal, from
 * one snapshot.
 *
 * Returns:
 * - `null` when the snapshot cannot support a plan: it lacks our own row
 *   (`selfPid`), or lacks the root's row (unless `rootLedGroup`, below, finds
 *   survivors). The caller should fall back to {@link groupOnlyPlan}.
 * - a plan with `refused` set, and empty `pids` and `groups`, when signaling
 *   would hit us: the root is us or has a pid of 1 or less, leads or sits in
 *   our process group, or has us or one of our ancestors beneath it (or in its
 *   group). Also when the snapshot does not show our ancestors back to pid 1
 *   (or to a parent pid of 0): a row missing on the way up, or a ppid cycle,
 *   leaves every ancestor above that point unknown, and an unknown ancestor
 *   could be planned as part of the tree. That refusal (`unknown-ancestry`) is
 *   checked last, so it is reported only when every other check passed.
 *   {@link signalTree} signals nothing for a refused plan.
 * - otherwise a plan. Every ancestor of ours is then known, and the plan never
 *   contains `selfPid`, our ancestors, our group, or any pid or group id of 1
 *   or less. A group is signaled whole only when every member the snapshot
 *   shows is in the tree and the group is neither ours nor an ancestor's.
 *
 * `opts.rootLedGroup` is for a root spawned as a process group leader (detached)
 * that may already have exited. When it is true and the root's row is absent,
 * the plan is built from the surviving members of the root's group (rows with
 * `pgid === rootPid`) and everything below them, under every usual exclusion.
 * POSIX does not reuse a pid while a process group with that id still exists,
 * so those members really are the root's group, and this reaches shells that a
 * surviving background process moved to groups of their own. If no member of
 * that group survives, the result is null. Without the flag an absent root
 * returns null, because a bare pid with no row cannot be told from a recycled
 * one. A caller that knows the root exited must refuse the plan itself when
 * the table still holds a row with `pid === rootPid` (the pid was reused).
 */
export function planTreeKill(
  rootPid: number,
  table: readonly ProcRow[],
  selfPid: number,
  opts: { rootLedGroup?: boolean } = {},
): TreeKillPlan | null {
  const rootLedGroup = (opts ?? {}).rootLedGroup === true; // plain JavaScript may pass null
  const refuse = (refusal: TreeKillRefusal, refused: string): TreeKillPlan =>
    refusedPlan(rootPid, refusal, refused);
  if (!Number.isInteger(rootPid) || rootPid <= 1) {
    return refuse("invalid-root", `pid ${rootPid} is never signaled`);
  }
  const rows = new Map(table.map((r) => [r.pid, r]));
  const self = rows.get(selfPid);
  const root = rows.get(rootPid);
  if (!self) return null;
  if (!root && !(rootLedGroup && table.some((r) => r.pgid === rootPid))) return null;
  if (rootPid === selfPid) return refuse("self", "the root is this process");
  if (rootPid === self.pgid) return refuse("leads-our-group", "the root leads this process's group");
  if (root && root.pgid === self.pgid) return refuse("in-our-group", "the root is in this process's group");

  // Our ancestors, from the snapshot, up to pid 1 (or a parent pid of 0, the
  // top of what this process can see). A missing row or a racy ppid cycle on
  // the way up leaves the rest of our ancestry unknown, and the plan is
  // refused (fail closed) once the other checks below have passed.
  const ancestors = new Set<number>();
  let ancestryKnown = true;
  for (let p = self.ppid; p > 0; ) {
    if (ancestors.has(p)) {
      ancestryKnown = false;
      break;
    }
    ancestors.add(p);
    if (p === 1) break;
    const up = rows.get(p);
    if (!up) {
      ancestryKnown = false;
      break;
    }
    p = up.ppid;
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
  // Any ancestor of ours in the tree has us in it too (both walks follow ppid),
  // so this one check covers ancestors as well. Ancestors are still excluded by
  // pid and by group below, as defense in depth.
  if (tree.has(selfPid)) return refuse("self-in-tree", "this process is inside the tree");
  // Last, so that this reason always means it is the only problem.
  if (!ancestryKnown) return refuse("unknown-ancestry", UNKNOWN_ANCESTRY);

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
      pgid > 1 &&
      pgid !== self.pgid &&
      pgid !== selfPid &&
      !ancestors.has(pgid) &&
      (members.get(pgid) ?? []).every((m) => tree.has(m));
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
 * usable snapshot exists. A pid of 1 or less (or a non-integer), `selfPid`,
 * `parentPid` and the real `process.pid` and `process.ppid` are refused.
 * `selfPid` defaults to this process, and `parentPid` to its parent when
 * `selfPid` is left at its default. Without a table nothing else can be
 * checked: not our own group when we do not lead it, and not a grandparent or
 * a deeper ancestor. So callers must spawn the root detached (as its own group
 * leader) and pass only that pid.
 */
export function groupOnlyPlan(
  pid: number,
  selfPid: number = process.pid,
  parentPid: number | undefined = selfPid === process.pid ? process.ppid : undefined,
): TreeKillPlan {
  if (!Number.isInteger(pid) || pid <= 1) return refusedPlan(pid, "invalid-root", `pid ${pid} is never signaled`);
  // The real process.pid and process.ppid are always refused, whatever selfPid
  // and parentPid say: no caller means to signal them, and plain JavaScript
  // like `pids.map(groupOnlyPlan)` passes (index, array) in their place.
  if (pid === selfPid || pid === process.pid) return refusedPlan(pid, "self", "the root is this process");
  if (pid === parentPid || pid === process.ppid) {
    return refusedPlan(pid, "parent", "the root is the parent of this process");
  }
  return { rootPid: pid, groups: [], pids: [] };
}

/** A plan that signals nothing, with the typed reason and its text kept in step. */
export function refusedPlan(rootPid: number, refusal: TreeKillRefusal, refused: string): TreeKillPlan {
  return { rootPid, groups: [], pids: [], refused, refusal };
}

const defaultKill: KillFn = (pid, signal) => {
  process.kill(pid, signal as NodeJS.Signals);
};

/** Each target as the kill(2) argument: groups negative, pids positive, root group first. */
function targetsOf(plan: TreeKillPlan): number[] {
  if (plan.refused || plan.refusal) return [];
  if (!Number.isInteger(plan.rootPid) || plan.rootPid <= 1) return [];
  const ok = (n: number) => Number.isInteger(n) && n > 1;
  return [
    -plan.rootPid,
    ...plan.groups.filter(ok).map((g) => -g),
    ...plan.pids.filter(ok),
  ];
}

/** The errno code of whatever a kill threw. An injected kill may throw anything, even nothing. */
function errCode(err: unknown): unknown {
  return (err as { code?: unknown } | null | undefined)?.code;
}

type Answer = "sent" | "gone" | "denied";

function send(target: number, signal: NodeJS.Signals, kill: KillFn): Answer {
  try {
    kill(target, signal);
    return "sent";
  } catch (err) {
    if (errCode(err) === "ESRCH") return "gone";
    return "denied";
  }
}

function alive(target: number, kill: KillFn): boolean {
  try {
    kill(target, 0);
    return true;
  } catch (err) {
    // EPERM means it exists and is not ours to signal.
    return errCode(err) === "EPERM";
  }
}

function deliver(
  plan: TreeKillPlan,
  signal: NodeJS.Signals,
  kill: KillFn,
  onlyAlive: boolean,
  stopOnRootDenied: boolean,
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
  // On the first pass, EPERM on the root group means the root is not ours, so
  // nothing under it is either: stop. A root that is already gone does not stop
  // the rest, since its descendants must still be reached.
  const rootAnswer = one(rootTarget);
  record(rootTarget, rootAnswer);
  if (rootAnswer === "denied" && stopOnRootDenied) return result;
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
  return deliver(plan, signal, kill, false, true);
}

/**
 * After the grace period: SIGKILLs every target of the SAME plan that is still
 * alive. Targets found dead are reported in `gone`. Never takes a second
 * snapshot, and a refused plan signals nothing.
 *
 * The "root group EPERM means it is not ours" gate belongs to the FIRST pass
 * only, so `first` (that pass's {@link signalTree} result) is required. If the
 * first pass was denied on the root group, nothing is sent here. Otherwise the
 * root group was ours when the first signal went out, and an EPERM now (a
 * member we may not signal keeps it alive) is reported in `denied` without
 * stopping the other survivors. A `first` that is missing or malformed (only
 * possible from plain JavaScript) sends nothing. `kill` defaults to
 * `process.kill`, as in {@link signalTree}.
 */
export function killTreeSurvivors(
  plan: TreeKillPlan,
  first: TreeSignalResult,
  kill: KillFn = defaultKill,
): TreeSignalResult {
  if (!Array.isArray(first?.denied) || first.denied.includes(-plan.rootPid)) {
    return { signaled: [], denied: [], gone: [] };
  }
  return deliver(plan, "SIGKILL", kill, true, false);
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
