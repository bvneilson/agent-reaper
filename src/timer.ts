// Internal timer arithmetic shared by tree.ts and spawn.ts. Not exported from index.

/** The largest delay a node timer accepts. A larger one fires after 1 ms. */
export const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * A whole-ms delay node's timers accept, or null when `ms` asks for none (0 or
 * less, or NaN). A fraction is rounded up. A larger delay, Infinity included,
 * is clamped to {@link MAX_TIMER_MS}.
 */
export function timerMs(ms: number): number | null {
  if (!(ms > 0)) return null;
  return Math.min(Math.ceil(ms), MAX_TIMER_MS);
}

/**
 * The delay for a `timeoutMs` option, or null for no timeout. Unset, 0 or less,
 * NaN and Infinity all mean no timeout (Infinity must not be clamped into a
 * kill about 24.86 days later). A finite value above {@link MAX_TIMER_MS} is
 * clamped to it.
 */
export function timeoutOf(ms: number | undefined): number | null {
  if (ms === undefined || !Number.isFinite(ms)) return null;
  return timerMs(ms);
}

/** Default wait, in ms, between the first signal and the SIGKILL of survivors. */
export const DEFAULT_GRACE_MS = 5000;

/** The delay for a `graceMs` option: the default when unset, 0 for 0 or less, never null. */
export function graceOf(ms: number | undefined): number {
  return timerMs(ms ?? DEFAULT_GRACE_MS) ?? 0;
}
