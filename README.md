# agent-reaper

Supervise headless agent processes, and kill the whole process tree when they time out, exit, or are told to stop.

- Spawns a command as the leader of its own process group.
- On timeout, on exit, or on `kill()`, it snapshots the process table and signals every descendant it can trace, not just the child.
- Sends SIGTERM, waits a grace period, then SIGKILLs whatever in the same plan is still alive.

Zero dependencies. MIT licensed. ESM only. Node 20 or newer, POSIX only.

## Why it exists

It was built to supervise headless Claude Code agents. Two incidents shaped it.

First, a headless agent was killed on a timeout, and the MCP server processes it had started kept running. Over time thousands of orphaned processes piled up until `fork()` failed and the machine froze.

Months later, a 16 GB Mac hit a load average of 202. The agent had started shells that lived in process groups of their own, so killing the agent's group missed them.

The fix is the same in both cases: take a snapshot of the process table, work out the whole tree from it, and kill that tree. Killing only a group is not enough.

## Install

Releases are on GitHub. There is no npm package yet.

```sh
npm install https://github.com/bvneilson/agent-reaper/releases/download/v0.1.1/agent-reaper-0.1.1.tgz
```

## Usage

```ts
import { killTree, spawnSupervised } from "agent-reaper";

const run = spawnSupervised("my-agent", ["--headless"], {
  timeoutMs: 10 * 60_000,
  graceMs: 5000,
  prompt: "Summarize the open issues.",
  stripEnv: ["SECRET_TOKEN"],
});
run.child.stdout?.resume(); // read or discard the output
run.child.stderr?.resume();

// The agent runs in a session of its own, so Ctrl-C and SIGTERM reach this
// process but not the agent. Reap it before exiting. The flag keeps a second
// signal from starting a second exit.
let stopping = false;
const stop = (code: number) => {
  if (stopping) return;
  stopping = true;
  run.kill().then(() => run.done).catch(() => {}).then(() => process.exit(code));
};
process.on("SIGINT", () => stop(130));
process.on("SIGTERM", () => stop(143));

const result = await run.done; // { code, signal, timedOut, reaped }
console.log(result.timedOut ? "timed out" : `exit ${result.code}`);

// Any process you know the pid of (spawned detached) can be killed too:
// await killTree(somePid);
```

## API

| Export | What it does |
| --- | --- |
| `spawnSupervised(command, args, opts?)` | Spawns `command` detached, as the leader of a new process group and session. Returns `{ child, done, kill }`. |
| `killTree(rootPid, opts?)` | Kills the tree of `rootPid` from one snapshot. Resolves to `'done'`, `'denied'` or `'gone'`. Never rejects. Options are in [`KillTreeOptions`](#killtreeoptions). A root of 1 or less, or one that is not an integer, is `'denied'`. |
| `withoutEnv(env, names)` | A copy of `env` without `names`. Matches exactly, never changes `env`. |
| `openPromptStdin(prompt, dir?)` | A read-only file descriptor holding `prompt`, for use as a child's stdin. No file is left behind. The data lives in an unlinked file until the child closes its stdin. |
| `planTreeKill(rootPid, table, selfPid, opts?)` | Pure. Plans which groups and pids a tree kill may signal. Returns a plan, a refused plan, or `null`. `opts.rootLedGroup` (default false) is for a root spawned as a group leader that may have exited. With it, an absent root is planned from the members its group still has. |
| `groupOnlyPlan(pid, selfPid?, parentPid?)` | The fallback plan: the root's group and nothing else. Refuses pid 1 or less, `selfPid` (default `process.pid`), `parentPid` (default `process.ppid`), and always the real `process.pid` and `process.ppid`. It cannot check anything else, see Limits. |
| `signalTree(plan, signal, kill?)` | Sends one signal to every target of a plan. Signals nothing for a refused plan. |
| `killTreeSurvivors(plan, first, kill?)` | SIGKILLs the targets of the same plan that are still alive. `first` is the result of the first `signalTree`. |
| `snapshotProcessTable(timeoutMs?)`, `snapshotProcessTableAsync(timeoutMs?)` | Reads `ps -Ao pid=,ppid=,pgid=,comm=`. Returns `null` on failure, and without running `ps` when `timeoutMs` is 0 or less. |
| `parseProcTable(raw)` | Pure. Parses that `ps` output into rows. |
| `processGroupAlive(pgid, kill?)` | True if the process group still exists. |
| `DEFAULT_GRACE_MS`, `DEFAULT_SNAPSHOT_TIMEOUT_MS` | 5000 and 2000. |

Types: `SupervisedOptions`, `Supervised`, `SupervisedResult`, `KillTreeOptions`, `KillTreeOutcome`, `ProcRow`, `TreeKillPlan`, `TreeKillRefusal`, `TreeSignalResult`, `KillFn`.

### `KillTreeOptions`

| Option | Default | Meaning |
| --- | --- | --- |
| `graceMs` | 5000 | Ms between SIGTERM and the SIGKILL of survivors. 0 or less SIGKILLs right away. |
| `snapshotTimeoutMs` | 2000 | Bound on the `ps` read. 0 or less skips the snapshot, and only the root's own group is signaled. |

### `SupervisedOptions`

| Option | Default | Meaning |
| --- | --- | --- |
| `cwd` | current directory | The child's working directory. |
| `env` | `process.env` | The child's environment, before `stripEnv` applies. |
| `stripEnv` | none | Names removed from the child's environment. A runtime that loads `.env` from its working directory can restore a removed name. Set it to `""` in `env` instead. |
| `prompt` | none | Text handed to the child as stdin, through a file. Without it, stdin is the null device. |
| `timeoutMs` | no timeout | Kill the tree this many ms after the spawn. Unset, 0 or less, NaN and `Infinity` mean no timeout. A finite value above 2147483647 (about 24.8 days) is clamped to it. |
| `graceMs` | 5000 | Ms between the first signal and the SIGKILL of survivors. 0 or less SIGKILLs right away. |
| `snapshotTimeoutMs` | 2000 | Bound on each `ps` read. 0 or less skips the snapshot, and only the child's own group is signaled. |

### `SupervisedResult`

- `code` and `signal`: how the child ended.
- `timedOut`: true when `timeoutMs` elapsed and started the kill.
- `reaped`: how many kill targets took the first signal. A target is a whole group or a single process. It is 0 when nothing was left to signal or the plan was refused.

### `Supervised`

- `child`: the `ChildProcess`. stdout and stderr are pipes.
- `done`: settles once the child has exited and its tree has been reaped. It rejects only when the command cannot be spawned. It does not wait for stdout and stderr to close.
- `kill(signal?)`: starts the reap now, with `signal` (default SIGTERM) as the first signal. The reap runs once per child, so later calls return the same promise and ignore their `signal`.

### `killTree` outcomes

- `'done'`: at least one target took SIGTERM, the survivors got SIGKILL after the grace, and no target was denied.
- `'denied'`: the root is 1 or less or not an integer, the plan was refused, or some target could not be signaled (EPERM). The other targets are still signaled, unless the root's own group was the one denied.
- `'gone'`: nothing in the plan was alive to take the signal, or a usable snapshot showed nothing left of the root or its group. Nothing was sent.

## Guarantees

Each of these has a test behind it. The unit tests inject the kill function and a process table. The integration tests spawn real processes and signal only those. A usable snapshot means `ps` ran, finished in time and listed this process. Without one, see Limits.

- A timeout kills the child and a grandchild that moved to its own session.
- A descendant that ignores SIGTERM is SIGKILLed after the grace.
- A normal exit still reaps a background process left in the child's group, and a shell that process started in a session of its own.
- With a usable snapshot, a normal exit that leaves nothing behind signals nothing and does not wait out the grace.
- A plan built from a snapshot never contains this process, its ancestors, its group, or a pid or group id of 1 or less. A refused plan signals nothing.
- `snapshotTimeoutMs` of 0 skips `ps` and signals only the child's own group.
- EPERM on one target is reported in `denied`, and the other targets are still signaled, unless the denied target is the root's own group, which means the tree is not ours.
- A `timeoutMs` of `Infinity` never kills the child.
- `killTree` and `done` never throw out of the kill path. A command that cannot be spawned rejects `done`, and `kill()` still resolves.
- A process that awaits `done` does not exit before the grace ends and the survivors are SIGKILLed.
- A supervisor that runs the SIGINT and SIGTERM handler from Usage reaps the agent, then exits with 130 or 143. A second signal during the reap changes nothing.
- A prompt arrives on stdin byte for byte, up to 4 MB in the test, and no file is left behind.
- Process arguments are never read or returned. The table comes from `ps -Ao pid=,ppid=,pgid=,comm=`.

## Limits

- POSIX only, and `ps` must be on the path. On Windows it does not work.
- If this process dies or is interrupted, its supervised trees are not reaped. The child runs in a session of its own, so a terminal's Ctrl-C reaches this process but not the agent. A SIGTERM, a SIGKILL or a crash behaves the same way, and the agent keeps running. Handle SIGINT and SIGTERM and call `kill()` before exiting, as in Usage. Nothing can catch a SIGKILL.
- Without a usable snapshot (`ps` missing, failing or slow, or `snapshotTimeoutMs` 0 or less), only the root's own group is signaled. Descendants in other groups or sessions survive. This is common in minimal containers, which often ship without `ps`. In that state `groupOnlyPlan`, and so `killTree`, can refuse only this process and its parent. It cannot refuse our own group when we do not lead it, or a grandparent or deeper ancestor. Pass `killTree` only the pids of trees you started detached.
- Without a usable snapshot, the reap after a normal exit signals the child's old group id once, although its pid may already be free.
- A descendant that leaves the child's group and outlives its parent before any kill cannot be traced back to the child. Once the parent is gone, it is reparented to init, and the table cannot tell it from a stranger's process.
- A process started after the snapshot, outside the groups the plan signals whole (in a new session during the grace, for example), is not reached.
- A pid or group id in the plan can be recycled during the grace window and still receive the SIGKILL. The child's own group id is the likeliest. This applies to every `spawnSupervised` reap, because Node collects the child right after the first signal.
- Where `ps` hides this process's ancestors (Linux hidepid, some sandboxes), plans are refused. `spawnSupervised` then kills only the running child's own group, not descendants in other groups or sessions. `killTree` signals nothing.
- If a reap signals nothing while the child keeps running (EPERM on a setuid command, for example), supervision of that child ends.
- While a kill is in flight, the grace timer keeps the process alive for up to `graceMs`.
- A child that writes to stdout or stderr that nobody reads can block on the write. Read the pipes or call `.resume()` on them.

## License

MIT. See `LICENSE`.
