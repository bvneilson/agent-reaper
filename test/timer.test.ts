import { describe, expect, test } from "vitest";
import { graceOf, MAX_TIMER_MS, timeoutOf, timerMs } from "../src/timer.js";

describe("timerMs", () => {
  test("a delay of 0 or less, or NaN, asks for no timer", () => {
    for (const ms of [0, -1, -0.5, Number.NaN]) expect(timerMs(ms)).toBeNull();
  });

  test("a fractional delay is rounded up, not dropped", () => {
    expect(timerMs(0.2)).toBe(1);
    expect(timerMs(50.5)).toBe(51);
  });

  test("an oversized delay, Infinity included, is clamped to the largest timer value", () => {
    expect(timerMs(2 ** 40)).toBe(MAX_TIMER_MS);
    expect(timerMs(Number.POSITIVE_INFINITY)).toBe(MAX_TIMER_MS);
  });
});

describe("timeoutOf (timeoutMs)", () => {
  test("unset, 0, negative, NaN and Infinity all mean no timeout", () => {
    for (const ms of [undefined, 0, -5, Number.NaN, Number.POSITIVE_INFINITY]) expect(timeoutOf(ms)).toBeNull();
  });

  test("a positive finite value is a timer delay, clamped to the largest timer value", () => {
    expect(timeoutOf(1500)).toBe(1500);
    expect(timeoutOf(2 ** 40)).toBe(MAX_TIMER_MS);
  });
});

describe("graceOf (graceMs)", () => {
  test("unset is 5000, and 0 or less is a grace of 0", () => {
    expect(graceOf(undefined)).toBe(5000);
    for (const ms of [0, -1, Number.NaN]) expect(graceOf(ms)).toBe(0);
  });

  test("a fractional grace is rounded up, and Infinity waits the longest a timer can", () => {
    expect(graceOf(10.2)).toBe(11);
    expect(graceOf(Number.POSITIVE_INFINITY)).toBe(MAX_TIMER_MS);
  });
});
