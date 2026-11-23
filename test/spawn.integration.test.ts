import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { killTree, openPromptStdin, spawnSupervised, type SupervisedOptions } from "../src/index.js";

// Real processes, so this file runs only after the unit files pass (see the test script).
//
// Safety rules for the machine these run on:
// - Every pid a test starts is recorded: the supervised child's own, and every number a script
//   prints under `pids` on stdout.
// - afterEach SIGKILLs a survivor by that recorded pid only, and only while it is still a node
//   process. Nothing here signals a group, a pattern, or a pid it did not start, except through
//   the library under test acting on the trees these tests build.
// - Every helper process also exits on its own after 60 s.
//
// "Gone" waits until kill(pid, 0) fails with ESRCH or ps shows a zombie. A zombie has exited and
// only waits for its parent (often init, after a reparent) to reap it.

const NODE = process.execPath;
const SLEEP = "setTimeout(() => {}, 60000)";
const SPAWN = `const { spawn } = require("child_process")`;
const DEADLINE_MS = 10_000;
const GRACE_MS = 500;
const SLOW = { timeout: 30_000 };

const recorded = new Set<number>();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function ps(field: "stat" | "comm", pid: number): string | null {
  try {
    const out = execFileSync("ps", ["-o", `${field}=`, "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.trim();
  } catch {
    return null; // ps exits non-zero when the pid does not exist
  }
}

/** True while `pid` exists and is not a zombie. */
function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") return false;
  }
  const stat = ps("stat", pid);
  if (stat === null) {
    // ps could not read it. Only a pid that kill(0) now says is gone counts as gone.
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return (err as NodeJS.ErrnoException).code !== "ESRCH";
    }
  }
  return !stat.startsWith("Z");
}

/** Polls until `pid` is gone (or a zombie). False if it is still running at the deadline. */
async function gone(pid: number): Promise<boolean> {
  const end = Date.now() + DEADLINE_MS;
  while (running(pid)) {
    if (Date.now() > end) return false;
    await sleep(25);
  }
  return true;
}

afterEach(() => {
  const node = basename(NODE).slice(0, 15); // Linux truncates comm to 15 characters
  for (const pid of recorded) {
    if (pid <= 1 || pid === process.pid || pid === process.ppid) continue;
    if (!running(pid) || basename(ps("comm", pid) ?? "") !== node) continue;
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // exited in between
    }
  }
  recorded.clear();
});

/**
 * Reads the JSON lines a child prints, records every pid under `pids`, and returns `waitFor`,
 * which resolves with everything seen (pids flattened in) once all `keys` have appeared.
 */
function watch(child: ChildProcess) {
  if (child.pid) recorded.add(child.pid);
  const seen: Record<string, unknown> = {};
  let stderr = "";
  let ended = false;
  let wake = () => {};
  let buffered = "";
  child.stdout!.setEncoding("utf8");
  child.stdout!.on("data", (chunk: string) => {
    buffered += chunk;
    for (let nl = buffered.indexOf("\n"); nl >= 0; nl = buffered.indexOf("\n")) {
      const msg = JSON.parse(buffered.slice(0, nl)) as Record<string, unknown>;
      buffered = buffered.slice(nl + 1);
      const pids = (msg.pids ?? {}) as Record<string, unknown>;
      for (const pid of Object.values(pids)) if (typeof pid === "number") recorded.add(pid);
      Object.assign(seen, msg, pids);
    }
    wake();
  });
  child.stdout!.on("end", () => {
    ended = true;
    wake();
  });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const waitFor = async (...keys: string[]): Promise<Record<string, any>> => {
    const end = Date.now() + DEADLINE_MS;
    while (!keys.every((k) => k in seen)) {
      if (ended || Date.now() > end) {
        throw new Error(`never saw ${keys.join(", ")} (saw ${JSON.stringify(seen)}; stderr: ${stderr})`);
      }
      await Promise.race([new Promise<void>((resolve) => (wake = resolve)), sleep(100)]);
    }
    return seen;
  };
  return { waitFor };
}

/** spawnSupervised(`node -e script`), watched. */
function supervise(script: string, opts: SupervisedOptions = {}) {
  const sup = spawnSupervised(NODE, ["-e", script], { graceMs: GRACE_MS, ...opts });
  return { sup, ...watch(sup.child) };
}

describe("spawnSupervised", () => {
  test("(a) a timeout kills the tree, a grandchild in its own session included", SLOW, async () => {
    const { sup, waitFor } = supervise(
      `${SPAWN};
      const g = spawn(process.execPath, ["-e", ${JSON.stringify(SLEEP)}], { detached: true, stdio: "ignore" });
      console.log(JSON.stringify({ pids: { grandchild: g.pid } }));
      ${SLEEP};`,
      { timeoutMs: 500 },
    );
    const { grandchild } = await waitFor("grandchild");
    const result = await sup.done;
    expect(result).toEqual({ code: null, signal: "SIGTERM", timedOut: true, reaped: 2 });
    expect(await gone(grandchild)).toBe(true);
    expect(await gone(sup.child.pid!)).toBe(true);
  });

  test("a grandchild that ignores SIGTERM is SIGKILLed after the grace", SLOW, async () => {
    const stubborn = `process.on("SIGTERM", () => console.log(JSON.stringify({ term: true })));
      console.log(JSON.stringify({ pids: { stubborn: process.pid } }));
      ${SLEEP};`;
    const { sup, waitFor } = supervise(
      `${SPAWN};
      const stdio = ["ignore", "inherit", "ignore"];
      spawn(process.execPath, ["-e", ${JSON.stringify(stubborn)}], { detached: true, stdio });
      ${SLEEP};`,
      { graceMs: 1000 },
    );
    const { stubborn: pid } = await waitFor("stubborn");
    await sup.kill();
    await waitFor("term"); // it took the SIGTERM and lived through it
    expect(await gone(pid)).toBe(true);
    expect((await sup.done).reaped).toBe(2);
  });

  test("(b) reaps orphans on normal exit: a background grandchild in the child's group", SLOW, async () => {
    const { sup, waitFor } = supervise(
      `${SPAWN};
      const g = spawn(process.execPath, ["-e", ${JSON.stringify(SLEEP)}], { stdio: "ignore" });
      g.unref();
      console.log(JSON.stringify({ pids: { grandchild: g.pid } }));`,
    );
    const { grandchild } = await waitFor("grandchild");
    const result = await sup.done;
    expect(result).toEqual({ code: 0, signal: null, timedOut: false, reaped: 1 });
    expect(await gone(grandchild)).toBe(true);
  });

  test("(c) snapshotTimeoutMs 0 skips the snapshot: the group dies, a detached one survives", SLOW, async () => {
    const { sup, waitFor } = supervise(
      `${SPAWN};
      const same = spawn(process.execPath, ["-e", ${JSON.stringify(SLEEP)}], { stdio: "ignore" });
      const apart = spawn(process.execPath, ["-e", ${JSON.stringify(SLEEP)}], { detached: true, stdio: "ignore" });
      console.log(JSON.stringify({ pids: { same: same.pid, apart: apart.pid } }));
      ${SLEEP};`,
      { snapshotTimeoutMs: 0 },
    );
    const { same, apart } = await waitFor("same", "apart");
    const killed = sup.kill();
    expect(sup.kill()).toBe(killed); // one sequence, however many callers
    await killed;
    expect(await sup.done).toEqual({ code: null, signal: "SIGTERM", timedOut: false, reaped: 1 });
    expect(await gone(same)).toBe(true);
    expect(await gone(sup.child.pid!)).toBe(true);
    // Without a snapshot only the child's group was signaled, so the grandchild in its own
    // session is still running. That is the proof the fallback ran. afterEach kills it.
    expect(running(apart)).toBe(true);
    expect(sup.kill()).toBe(killed);
  });

  test("(d) a 4 MB prompt arrives on stdin byte for byte", SLOW, async () => {
    const line = "a prompt line, with multibyte text: é ü 中文 🙂 and a tab\t.\n";
    const prompt = line.repeat(Math.ceil((4 * 1024 * 1024) / Buffer.byteLength(line)));
    const { sup, waitFor } = supervise(
      `const h = require("crypto").createHash("sha256");
      let bytes = 0;
      process.stdin.on("data", (c) => { h.update(c); bytes += c.length; });
      process.stdin.on("end", () => console.log(JSON.stringify({ bytes, sha256: h.digest("hex") })));`,
      { prompt },
    );
    const got = await waitFor("bytes", "sha256");
    expect({ bytes: got.bytes, sha256: got.sha256 }).toEqual({
      bytes: Buffer.byteLength(prompt),
      sha256: createHash("sha256").update(prompt).digest("hex"),
    });
    expect((await sup.done).code).toBe(0);
  });

  test("(e) after a normal exit, the surviving group leads to a grandchild's own session", SLOW, async () => {
    // G stays in the child's group and starts S in a session of its own. Once the child exits,
    // only G's group membership ties S to it.
    const great = `${SPAWN};
      const s = spawn(process.execPath, ["-e", ${JSON.stringify(SLEEP)}], { detached: true, stdio: "ignore" });
      console.log(JSON.stringify({ s: s.pid }));
      ${SLEEP};`;
    const { sup, waitFor } = supervise(
      `${SPAWN};
      const g = spawn(process.execPath, ["-e", ${JSON.stringify(great)}], { stdio: ["ignore", "pipe", "ignore"] });
      let out = "";
      g.stdout.setEncoding("utf8");
      g.stdout.on("data", (c) => {
        out += c;
        if (!out.includes("\\n")) return;
        console.log(JSON.stringify({ pids: { g: g.pid, s: JSON.parse(out).s } }));
        g.stdout.destroy();
        g.unref();
      });`,
    );
    const { g, s } = await waitFor("g", "s");
    const result = await sup.done;
    expect(result).toEqual({ code: 0, signal: null, timedOut: false, reaped: 2 });
    expect(await gone(g)).toBe(true);
    expect(await gone(s)).toBe(true);
  });

  test("a normal exit that leaves nothing behind does not wait out the grace", SLOW, async () => {
    const started = Date.now();
    const { sup } = supervise("", { graceMs: 20_000 });
    expect(await sup.done).toEqual({ code: 0, signal: null, timedOut: false, reaped: 0 });
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  test("the child gets opts.env (or this process's env) without the stripEnv names", SLOW, async () => {
    const print = `console.log(JSON.stringify({ env: {
      kept: process.env.REAPER_KEPT ?? null,
      stripped: process.env.REAPER_STRIPPED ?? null,
      inherited: process.env.REAPER_INHERITED ?? null,
    } }))`;
    process.env.REAPER_INHERITED = "from-parent";
    process.env.REAPER_STRIPPED = "fake-secret";
    try {
      const given = supervise(print, {
        env: { REAPER_KEPT: "yes", REAPER_STRIPPED: "fake-secret" },
        stripEnv: ["REAPER_STRIPPED"],
      });
      expect((await given.waitFor("env")).env).toEqual({ kept: "yes", stripped: null, inherited: null });
      const inherited = supervise(print, { stripEnv: ["REAPER_STRIPPED"] });
      expect((await inherited.waitFor("env")).env).toEqual({ kept: null, stripped: null, inherited: "from-parent" });
      await Promise.all([given.sup.done, inherited.sup.done]);
      expect(process.env.REAPER_STRIPPED).toBe("fake-secret");
    } finally {
      delete process.env.REAPER_INHERITED;
      delete process.env.REAPER_STRIPPED;
    }
  });

  test("kill() with an unknown signal rejects and leaves the child supervised", SLOW, async () => {
    const { sup } = supervise(SLEEP);
    await expect(sup.kill("SIGNOPE" as NodeJS.Signals)).rejects.toThrow(TypeError);
    await sup.kill();
    expect(await sup.done).toMatchObject({ signal: "SIGTERM", timedOut: false });
  });

  test("a command that cannot be spawned rejects done, and kill() still resolves", async () => {
    const sup = spawnSupervised("agent-reaper-no-such-command", []);
    expect(sup.child.pid).toBeUndefined();
    await expect(sup.done).rejects.toMatchObject({ code: "ENOENT" });
    await expect(sup.kill()).resolves.toBeUndefined();
  });
});

describe("openPromptStdin", () => {
  test("returns a read-only fd holding the prompt, and leaves nothing on disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "reaper-prompt-test-"));
    try {
      const fd = openPromptStdin("hello\nworld é", dir);
      try {
        expect(readdirSync(dir)).toEqual([]);
        expect(readFileSync(fd, "utf8")).toBe("hello\nworld é");
        expect(() => writeSync(fd, "x")).toThrow();
      } finally {
        closeSync(fd);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("killTree", () => {
  // A pid no system hands out, so even a real signal could reach nothing.
  const NO_SUCH_PID = 2 ** 30;
  const errno = (code: string) => Object.assign(new Error(code), { code });

  test("our own pid and our parent's are refused, and nothing is signaled", async () => {
    const spy = vi.spyOn(process, "kill").mockImplementation(() => true);
    try {
      for (const snapshotTimeoutMs of [undefined, 0]) {
        expect(await killTree(process.pid, { snapshotTimeoutMs, graceMs: 0 })).toBe("denied");
        expect(await killTree(process.ppid, { snapshotTimeoutMs, graceMs: 0 })).toBe("denied");
      }
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  test("reports gone, denied and done from what the OS answered", async () => {
    const calls: Array<[number, unknown]> = [];
    const answer = (codes: Partial<Record<string, string>>) =>
      vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
        calls.push([pid, signal]);
        const code = codes[String(signal)];
        if (code) throw errno(code);
        return true;
      });
    const run = async (codes: Partial<Record<string, string>>) => {
      calls.length = 0;
      const spy = answer(codes);
      try {
        return await killTree(NO_SUCH_PID, { snapshotTimeoutMs: 0, graceMs: 0 });
      } finally {
        spy.mockRestore();
      }
    };
    expect(await run({ SIGTERM: "ESRCH" })).toBe("gone");
    expect(calls).toEqual([[-NO_SUCH_PID, "SIGTERM"]]);
    expect(await run({ SIGTERM: "EPERM" })).toBe("denied");
    expect(calls).toEqual([[-NO_SUCH_PID, "SIGTERM"]]);
    expect(await run({})).toBe("done");
    expect(calls).toEqual([
      [-NO_SUCH_PID, "SIGTERM"],
      [-NO_SUCH_PID, 0],
      [-NO_SUCH_PID, "SIGKILL"],
    ]);
    expect(await run({ SIGKILL: "EPERM" })).toBe("denied");
  });

  test("kills a real tree it did not spawn, a grandchild in its own session included", SLOW, async () => {
    const child = spawn(
      NODE,
      [
        "-e",
        `${SPAWN};
        const g = spawn(process.execPath, ["-e", ${JSON.stringify(SLEEP)}], { detached: true, stdio: "ignore" });
        console.log(JSON.stringify({ pids: { grandchild: g.pid } }));
        ${SLEEP};`,
      ],
      { detached: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    const { waitFor } = watch(child);
    const { grandchild } = await waitFor("grandchild");
    expect(await killTree(child.pid!, { graceMs: GRACE_MS })).toBe("done");
    expect(await gone(grandchild)).toBe(true);
    expect(await gone(child.pid!)).toBe(true);
  });
});
