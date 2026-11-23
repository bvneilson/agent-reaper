/**
 * A copy of `env` without the variables in `names`. Names match exactly, case
 * included, and every other variable passes through unchanged. `env` itself
 * is never changed, and a new object comes back even when nothing is removed,
 * so `process.env` can be passed safely.
 *
 * A removed name is absent, not empty. Some runtimes (Bun, for one) fill a
 * name the environment lacks from a `.env` file in their working directory.
 * If a child might run one of those, set the name to `""` in `env` instead.
 */
export function withoutEnv(env: NodeJS.ProcessEnv, names: readonly string[]): NodeJS.ProcessEnv {
  const copy: NodeJS.ProcessEnv = { ...env };
  for (const name of names) delete copy[name];
  return copy;
}
