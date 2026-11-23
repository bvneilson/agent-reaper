# Changelog

## 0.1.1

Documentation and hardening. No change to the default behavior of a kill.

- README: the Guarantees now say which hold only with a usable `ps` snapshot. New Limits for the no-snapshot state, for a supervisor that dies, for processes started after the snapshot, and for recycled group ids.
- README: a SIGINT and SIGTERM handler in Usage, `KillTreeOptions`, the `stripEnv` `.env` caveat, and ESM only.
- `timeoutMs: Infinity` (and NaN) now means no timeout. It was clamped to about 24.86 days.
- `groupOnlyPlan` always refuses the real `process.pid` and `process.ppid`, so `pids.map(groupOnlyPlan)` from plain JavaScript can no longer plan this process. `planTreeKill` accepts a null `opts`.
- `ps` is SIGKILLed, not SIGTERMed, when it outlives the snapshot timeout.
- `spawnSupervised` accepts `readonly string[]` for `args`.
- Doc fixes: `killTree` with an invalid root, the recycled-pid comment, a wrapped line in the `snapshotTimeoutMs` doc.
- New tests: a `ps` that fails, hangs or prints garbage, EPERM on a non-root target, invalid roots, timer normalization, and the supervisor's own death.

## 0.1.0

First release.

- `spawnSupervised`: runs a command as a process group leader and kills its whole tree on timeout, on exit, or on `kill()`.
- `killTree`: kills the tree of any pid from one snapshot, with SIGTERM, a grace period, then SIGKILL.
- Planner and signaling pieces: `planTreeKill`, `groupOnlyPlan`, `signalTree`, `killTreeSurvivors`, `snapshotProcessTable`, `snapshotProcessTableAsync`, `parseProcTable`, `processGroupAlive`, `DEFAULT_GRACE_MS`, `DEFAULT_SNAPSHOT_TIMEOUT_MS`.
- Helpers: `withoutEnv` and `openPromptStdin`.
- GitHub-only until an npm login exists. Install from the release tarball.
