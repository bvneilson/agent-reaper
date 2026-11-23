# Changelog

## 0.1.0

First release.

- `spawnSupervised`: runs a command as a process group leader and kills its whole tree on timeout, on exit, or on `kill()`.
- `killTree`: kills the tree of any pid from one snapshot, with SIGTERM, a grace period, then SIGKILL.
- Planner and signaling pieces: `planTreeKill`, `groupOnlyPlan`, `signalTree`, `killTreeSurvivors`, `snapshotProcessTable`, `parseProcTable`, `processGroupAlive`.
- Helpers: `withoutEnv` and `openPromptStdin`.
- GitHub-only until an npm login exists. Install from the release tarball.
