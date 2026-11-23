import { type ChildProcess, spawn } from "node:child_process";
import { closeSync } from "node:fs";
import { constants } from "node:os";
import { withoutEnv } from "./env.js";
import { openPromptStdin } from "./prompt.js";
import {
  DEFAULT_SNAPSHOT_TIMEOUT_MS,
  groupOnlyPlan,
  killTreeSurvivors,
  planTreeKill,
  type ProcRow,
  signalTree,
  snapshotProcessTableAsync,
  type TreeKillPlan,
  type TreeSignalResult,
} from "./tree.js";

// Supervised spawning: run a command as the leader of a process group of its
// own, and kill its whole process tree when it times out, when it exits, or on
// request. Each of those triggers runs the same sequence, once per child:
//
//   1. Snapshot the process table.
//   2. Plan the tree from it.
//   3. Send the first signal (SIGTERM) to every target of the plan.
//   4. Wait the grace period.
//   5. SIGKILL whatever in the SAME plan is still alive.
//
// While the child runs, the plan starts from the child's own row. If that plan
// is refused only because ps hides one of our ancestors, the child's own group
// is signaled instead: the child has not been collected, so its pid, and the
// group it leads, are still provably ours. After it exits, its pid is free and
// may already belong to someone else, so the plan starts from the members its
// process group still has instead (POSIX never reuses a pid while a group with
// that id exists). If the table shows none, nothing is signaled. If the table
// still shows a process with the child's pid, the pid was reused, and nothing
// is signaled either. With no usable snapshot, only the child's own group is
// signaled.
//
// A normal exit reaps too: a background process left in the child's group, and
// everything under it, is killed. A descendant that left the child's group and
// outlived its parent before any kill cannot be traced back to the child, and
// is not reached.

/** Default wait, in ms, between the first signal and the SIGKILL of survivors. */
export const DEFAULT_GRACE_MS = 5000;

const MAX_TIMER_MS = 2 ** 31 - 1;

/** Options for {@link spawnSupervised}. */
export interface SupervisedOptions {
  /** The child's working directory. */
  cwd?: string;
  /** The child's environment before `stripEnv` applies. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Names removed from the child's environment (see {@link withoutEnv}). */
  stripEnv?: readonly string[];
  /**
   * Text handed to the child as its stdin, through a file (see
   * {@link openPromptStdin}). Without it, stdin is the null device.
   */
  prompt?: string;
  /** Kill the tree this many ms after the spawn. Unset, 0 or less: no timeout. */
  timeoutMs?: number;
  /**
   * Ms between the first signal and the SIGKILL of survivors. Default 5000.
   * 0 or less: survivors are SIGKILLed right away.
   */
  graceMs?: number;
  /**
   * Bound, in ms, on the one `ps` read each kill plans from. Default 2000. 0 or
   * less skips the snapshot, and only the child's own process group is
   * signaled (a descendant in a group or session of its own is not reached).
   */
  snapshotTimeoutMs?: number;
}

/** How a supervised child ended, and what its reap did. */
export interface SupervisedResult {
  /** The exit code, or null when a signal ended the child. */
  code: number | null;
  /** The signal that ended the child, or null. */
  signal: NodeJS.Signals | null;
  /** True when `timeoutMs` elapsed and started the kill. */
  timedOut: boolean;
  /**
   * How many kill(2) targets took the first signal of the reap. A target is a
   * whole process group or a single process. 0 when nothing was left to
   * signal (a normal exit with no leftovers, in which case nothing at all is
   * sent) or when the plan was refused.
   */
  reaped: number;
}

/** A child under supervision. */
export interface Supervised {
  /**
   * The child. stdout and stderr are pipes: read them, or call `.resume()` on
   * each to discard the output. A child that writes more than an unread pipe
   * holds blocks on the write. stdin is the prompt file or the null device.
   */
  child: ChildProcess;
  /**
   * Settles once the child has exited AND its tree has been reaped. It never
   * rejects because of the reap. It rejects only when the command could not
   * be spawned at all, with the spawn error (ENOENT, EACCES, ...). It does not
   * wait for stdout and stderr to close, since a descendant the reap could not
   * reach may hold them open: listen for the child's `"close"` for that.
   */
  done: Promise<SupervisedResult>;
  /**
   * Kills the tree now: `signal` (default SIGTERM) to every target, then
   * SIGKILL to the survivors after the grace. Resolves when the reap is done.
   * The reap runs once per child, whatever starts it, so every call returns
   * the same promise, and a call made after a reap has started ignores its
   * `signal`. Rejects with a TypeError for a signal name this platform lacks.
   */
  kill(signal?: NodeJS.Signals): Promise<void>;
}

/** Options for {@link killTree}. */
export interface KillTreeOptions {
  /** Ms between SIGTERM and the SIGKILL of survivors. Default 5000. */
  graceMs?: number;
  /** Bound, in ms, on the `ps` read. Default 2000. 0 or less skips it. */
  snapshotTimeoutMs?: number;
}

/** What {@link killTree} did. */
export type KillTreeOutcome = "done" | "denied" | "gone";

/**
 * Spawns `command` with `args` as the leader of a new process group and
 * session (`detached: true`), and reaps its whole process tree when it times
 * out (`timeoutMs`), when it exits, or when `kill()` is called. See
 * {@link SupervisedOptions} for the environment, stdin and timing options.
 *
 * The timeout timer is unref'd: while the child runs, the child itself keeps
 * the event loop alive. Once a kill has started, its grace timer holds the
 * event loop open (for at most `graceMs`), so a process that awaits `done`
 * does not exit before the survivors get their SIGKILL.
 *
 * Throws whatever `child_process.spawn` throws synchronously (invalid
 * arguments). A command that cannot be started rejects `done` instead.
 */
export function spawnSupervised(command: string, args: string[], opts: SupervisedOptions = {}): Supervised {
  const graceMs = graceOf(opts.graceMs);
  const snapshotTimeoutMs = opts.snapshotTimeoutMs ?? DEFAULT_SNAPSHOT_TIMEOUT_MS;
  const env = withoutEnv(opts.env ?? process.env, opts.stripEnv ?? []);
  const child = spawnWithStdin(opts.prompt, (stdin) =>
    spawn(command, args, { cwd: opts.cwd, env, detached: true, stdio: [stdin, "pipe", "pipe"] }),
  );

  let timedOut = false;
  let timer: NodeJS.Timeout | undefined;
  let reaping: Promise<number> | undefined;
  const reap = (signal: NodeJS.Signals): Promise<number> => {
    clearTimeout(timer);
    reaping ??= reapChild(child, signal, graceMs, snapshotTimeoutMs).catch(() => 0);
    return reaping;
  };

  const done = new Promise<SupervisedResult>((resolve, reject) => {
    if (child.pid === undefined) {
      // The spawn failed. Node reports it as an "error" event, never "exit".
      child.once("error", reject);
      return;
    }
    child.once("exit", (code, signal) => {
      void reap("SIGTERM").then((reaped) => resolve({ code, signal, timedOut, reaped }));
    });
  });
  // A caller that never looks at `done` must not crash on an unhandled
  // rejection for a failed spawn. A caller that awaits it still sees the error.
  done.catch(() => {});

  // The timer and the exit can land in the same turn of the event loop. Both
  // go through reap(), so whichever runs first starts the one reap, and the
  // other joins it. timedOut is true only when the timer ran first.
  const timeoutMs = timerMs(opts.timeoutMs);
  if (child.pid !== undefined && timeoutMs !== null) {
    timer = setTimeout(() => {
      timedOut = true;
      void reap("SIGTERM");
    }, timeoutMs);
    timer.unref();
  }

  let killed: Promise<void> | undefined;
  const kill = (signal: NodeJS.Signals = "SIGTERM"): Promise<void> => {
    if (!killed) {
      if (!reaping && !Object.hasOwn(constants.signals, signal)) {
        return Promise.reject(new TypeError(`unknown signal: ${String(signal)}`));
      }
      killed = reap(signal).then(() => undefined);
    }
    return killed;
  };

  return { child, done, kill };
}

/**
 * Kills the process tree of `rootPid`, which this process need not have
 * spawned: one snapshot, SIGTERM to every target, `graceMs` (default 5000),
 * then SIGKILL to the survivors of the same plan. The root should lead its own
 * process group (spawned detached), since its group is signaled whole.
 *
 * A root that is this process, leads or sits in its group, has it beneath it,
 * or is 1 or less is refused, and nothing is signaled. So is any root when
 * the snapshot does not show this process's ancestors back to pid 1. If the
 * snapshot no longer shows the root itself, the plan starts from the members
 * its process group still has (POSIX never reuses a pid while a group with
 * that id exists), under the same checks. So a group whose leader exited is
 * still refused when it holds this process or one of its ancestors. Only
 * without a usable snapshot (`snapshotTimeoutMs` 0 or less, `ps` failing or
 * timing out, or a table without this process's own row) is the root's group
 * signaled on its own, and then only this process and its parent can be
 * checked.
 *
 * Resolves to:
 * - `"done"`: at least one target took SIGTERM, the survivors got SIGKILL
 *   after the grace, and no target was denied.
 * - `"denied"`: the plan was refused, or some target could not be signaled
 *   (EPERM: it is not ours). The other targets were still signaled, unless the
 *   root's own group was the one denied, which means the tree is not ours.
 * - `"gone"`: nothing in the plan was alive to take the signal, or the
 *   snapshot showed nothing left of the root or its group (and nothing was
 *   sent).
 *
 * Never rejects.
 */
export async function killTree(rootPid: number, opts: KillTreeOptions = {}): Promise<KillTreeOutcome> {
  const table = await snapshotProcessTableAsync(opts.snapshotTimeoutMs ?? DEFAULT_SNAPSHOT_TIMEOUT_MS);
  // A table without our own row is not trusted, and counts as no snapshot.
  const trusted = table?.some((r) => r.pid === process.pid) ? table : null;
  // A trusted snapshot is never thrown away for the group-only plan, which can
  // check only our pid and our parent's. With the root's row absent, the
  // rootLedGroup plan runs every check on what is left of the root's group, so
  // a leaderless group that holds us or an ancestor is refused. Null means
  // nothing of the root or its group is left, and nothing is sent.
  const plan = trusted
    ? planTreeKill(rootPid, trusted, process.pid, { rootLedGroup: true })
    : groupOnlyPlan(rootPid);
  if (!plan) return "gone";
  if (plan.refused) return "denied";
  const { first, last } = await killPlan(plan, "SIGTERM", graceOf(opts.graceMs));
  if (first.denied.length > 0 || (last?.denied.length ?? 0) > 0) return "denied";
  return first.signaled.length > 0 ? "done" : "gone";
}

/** Spawns with `prompt` as a stdin file (or the null device), and closes this process's copy of it. */
function spawnWithStdin(
  prompt: string | undefined,
  start: (stdin: number | "ignore") => ChildProcess,
): ChildProcess {
  if (prompt === undefined) return start("ignore");
  const fd = openPromptStdin(prompt);
  try {
    return start(fd);
  } finally {
    closeSync(fd); // the child holds its own copy
  }
}

/**
 * Steps 1 to 5 for a supervised child. Returns how many targets took the
 * first signal. Never throws (every call below catches its own errors).
 */
async function reapChild(
  child: ChildProcess,
  signal: NodeJS.Signals,
  graceMs: number,
  snapshotTimeoutMs: number,
): Promise<number> {
  const pid = child.pid;
  if (pid === undefined) return 0;
  const running = () => child.exitCode === null && child.signalCode === null;
  const wasRunning = running();
  let table = await snapshotProcessTableAsync(snapshotTimeoutMs);
  // If the child exited while ps ran, this table cannot tell the child's row
  // from a reused pid. Read it again, now that the child is known to be gone.
  if (wasRunning && !running()) table = await snapshotProcessTableAsync(snapshotTimeoutMs);
  // No await from here until the first signal is out. Node collects an exited
  // child (freeing its pid for reuse) only on the event loop, so a child seen
  // running now is still ours when killPlan sends that signal.
  const plan = planChildKill(pid, table, running());
  if (!plan) return 0;
  const { first } = await killPlan(plan, signal, graceMs);
  return first.signaled.length;
}

/**
 * Pure. Step 2 for a child this process spawned detached: which plan to kill
 * it by, from a snapshot taken while it was `running` or after it exited (or
 * from no snapshot at all). Null when there is nothing to signal. Exported for
 * tests. The package does not export it.
 */
export function planChildKill(pid: number, table: ProcRow[] | null, running: boolean): TreeKillPlan | null {
  if (!table) return groupOnlyPlan(pid);
  if (running) {
    const plan = planTreeKill(pid, table, process.pid);
    // A child not yet collected still owns its pid, and the group it leads is
    // one we created. So when the only problem is ancestors ps did not show
    // (a ps that hides other users' processes, say), that group is still safe
    // to signal. Every other refusal stands.
    if (!plan || plan.refusal === "unknown-ancestry") return groupOnlyPlan(pid);
    return plan;
  }
  if (table.some((r) => r.pid === pid)) {
    return {
      rootPid: pid,
      groups: [],
      pids: [],
      refused: "the root's pid was reused after it exited",
      refusal: "pid-reused",
    };
  }
  const plan = planTreeKill(pid, table, process.pid, { rootLedGroup: true });
  if (plan) return plan;
  // Null here means one of two things. The table lacks our own row: it is not
  // trusted, so this is the no-snapshot case and only the child's group is
  // signaled. Or nothing of the child's group is left: there is nothing to
  // signal, and its group id, free by now, must not be signaled at all.
  return table.some((r) => r.pid === process.pid) ? null : groupOnlyPlan(pid);
}

/**
 * Steps 3 to 5: the first signal, the grace, then SIGKILL to the survivors of
 * the same plan. The first signal goes out before this function first yields.
 * The grace timer is NOT unref'd: finishing the reap keeps the process alive.
 */
async function killPlan(
  plan: TreeKillPlan,
  signal: NodeJS.Signals,
  graceMs: number,
): Promise<{ first: TreeSignalResult; last: TreeSignalResult | null }> {
  const first = signalTree(plan, signal);
  // Nothing took the signal, so there is nothing to wait for. A SIGKILL pass
  // now could only find a group or pid that was reused since.
  if (first.signaled.length === 0) return { first, last: null };
  await new Promise((resolve) => setTimeout(resolve, graceMs));
  return { first, last: killTreeSurvivors(plan, first) };
}

/** A delay node's timers accept, or null when `ms` asks for none. */
function timerMs(ms: number | undefined): number | null {
  if (ms === undefined || !(ms > 0)) return null;
  return Math.min(Math.ceil(ms), MAX_TIMER_MS);
}

function graceOf(ms: number | undefined): number {
  return timerMs(ms ?? DEFAULT_GRACE_MS) ?? 0;
}
