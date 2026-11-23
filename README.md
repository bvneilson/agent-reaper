# agent-reaper

Supervise headless agent processes, and kill the whole process tree when they time out, exit, or are told to stop.

- Spawns a command as the leader of its own process group.
- On timeout, on exit, or on `kill()`, it snapshots the process table and signals every descendant it can trace, not just the child.
- Sends SIGTERM, waits a grace period, then SIGKILLs whatever in the same plan is still alive.

Zero dependencies. MIT licensed. Node 20 or newer, POSIX only.

## Why it exists

It was built to supervise headless Claude Code agents. Two incidents shaped it.

First, a headless agent was killed on a timeout, and the MCP server processes it had started kept running. Over time thousands of orphaned processes piled up until `fork()` failed and the machine froze.

Months later, a 16 GB Mac hit a load average of 202. The agent had started shells that lived in process groups of their own, so killing the agent's group missed them.

The fix is the same in both cases: take a snapshot of the process table, work out the whole tree from it, and kill that tree. Killing only a group is not enough.

## Install

Releases are on GitHub. There is no npm package yet.

```sh
npm install https://github.com/bvneilson/agent-reaper/releases/download/v0.1.0/agent-reaper-0.1.0.tgz
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

const result = await run.done; // { code, signal, timedOut, reaped }
console.log(result.timedOut ? "timed out" : `exit ${result.code}`);

// Any process you know the pid of (spawned detached) can be killed too:
// await killTree(somePid);
```

## API

| Export | What it does |
| --- | --- |
| `spawnSupervised(command, args, opts?)` | Spawns `command` detached, as the leader of a new process group and session. Returns `{ child, done, kill }`. |
| `killTree(rootPid, opts?)` | Kills the tree of `rootPid` from one snapshot. Resolves to `'done'`, `'denied'` or `'gone'`. Never rejects. |
| `withoutEnv(env, names)` | A copy of `env` without `names`. Matches exactly, never changes `env`. |
| `openPromptStdin(prompt, dir?)` | A read-only file descriptor holding `prompt`, for use as a child's stdin. Nothing stays on disk. |
| `planTreeKill(rootPid, table, selfPid, opts?)` | Pure. Plans which groups and pids a tree kill may signal. Returns a plan, a refused plan, or `null`. |
| `groupOnlyPlan(pid, selfPid?, parentPid?)` | The fallback plan: the root's group and nothing else. Refuses pid 1 or less, us, and our parent. |
| `signalTree(plan, signal, kill?)` | Sends one signal to every target of a plan. Signals nothing for a refused plan. |
| `killTreeSurvivors(plan, first, kill?)` | SIGKILLs the targets of the same plan that are still alive. `first` is the result of the first `signalTree`. |
| `snapshotProcessTable(timeoutMs?)`, `snapshotProcessTableAsync(timeoutMs?)` | Reads `ps -Ao pid=,ppid=,pgid=,comm=`. Returns `null` on failure, and without running `ps` when `timeoutMs` is 0 or less. |
| `parseProcTable(raw)` | Pure. Parses that `ps` output into rows. |
| `processGroupAlive(pgid, kill?)` | True if the process group still exists. |
| `DEFAULT_GRACE_MS`, `DEFAULT_SNAPSHOT_TIMEOUT_MS` | 5000 and 2000. |

Types: `SupervisedOptions`, `Supervised`, `SupervisedResult`, `KillTreeOptions`, `KillTreeOutcome`, `ProcRow`, `TreeKillPlan`, `TreeKillRefusal`, `TreeSignalResult`, `KillFn`.

### `SupervisedOptions`

| Option | Default | Meaning |
| --- | --- | --- |
| `cwd` | current directory | The child's working directory. |
| `env` | `process.env` | The child's environment, before `stripEnv` applies. |
| `stripEnv` | none | Names removed from the child's environment. |
| `prompt` | none | Text handed to the child as stdin, through a file. Without it, stdin is the null device. |
| `timeoutMs` | no timeout | Kill the tree this many ms after the spawn. 0 or less means no timeout. |
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
- `'denied'`: the plan was refused, or some target could not be signaled (EPERM). The other targets are still signaled, unless the root's own group was the one denied.
- `'gone'`: nothing in the plan was alive to take the signal, or the snapshot showed nothing left of the root or its group. Nothing was sent.

## Guarantees

Each of these has a test behind it. The unit tests inject the kill function and a process table. The integration tests spawn real processes and signal only those.

- A timeout kills the child and a grandchild that moved to its own session.
- A descendant that ignores SIGTERM is SIGKILLed after the grace.
- A normal exit still reaps a background process left in the child's group, and a shell that process started in a session of its own.
- A normal exit that leaves nothing behind signals nothing and does not wait out the grace.
- A plan never contains this process, its ancestors, its group, or a pid or group id of 1 or less. A refused plan signals nothing.
- `snapshotTimeoutMs` of 0 skips `ps` and signals only the child's own group.
- EPERM on one target is reported in `denied`, and the other targets are still signaled.
- `killTree` and `done` never throw out of the kill path. A command that cannot be spawned rejects `done`, and `kill()` still resolves.
- A process that awaits `done` does not exit before the grace ends and the survivors are SIGKILLed.
- A prompt arrives on stdin byte for byte, up to 4 MB in the test, and nothing is left on disk.
- Process arguments are never read or returned. The table comes from `ps -Ao pid=,ppid=,pgid=,comm=`.

## Limits

- POSIX only, and `ps` must be on the path. On Windows it does not work.
- A descendant that leaves the child's group and outlives its parent before any kill cannot be traced back to the child. Once the parent is gone, it is reparented to init, and the table cannot tell it from a stranger's process.
- A pid in the tree can be recycled during the grace window and still receive the SIGKILL. This applies to every `spawnSupervised` reap, because Node collects the child right after the first signal.
- `groupOnlyPlan` cannot refuse our own group when we do not lead it.
- Where `ps` hides this process's ancestors (Linux hidepid, some sandboxes), plans are refused. `spawnSupervised` then kills only the running child's own group, not descendants in other groups or sessions. `killTree` signals nothing.
- If a reap signals nothing while the child keeps running (EPERM on a setuid command, for example), supervision of that child ends.
- While a kill is in flight, the grace timer keeps the process alive for up to `graceMs`.
- A child that writes to stdout or stderr that nobody reads can block on the write. Read the pipes or call `.resume()` on them.

## License

MIT. See `LICENSE`.
