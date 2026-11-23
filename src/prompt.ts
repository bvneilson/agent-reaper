import { mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A read-only file descriptor that holds `prompt`, from its first byte to EOF,
 * to hand a child as its stdin: `spawn(cmd, args, { stdio: [fd, "pipe", "pipe"] })`,
 * then `closeSync(fd)` (the child holds its own copy).
 *
 * Why a file and not `stdio: ["pipe", ...]` plus `child.stdin.end(prompt)`: a
 * pipe write only buffers in this process, and the bytes reach the child when
 * this process's event loop gets around to flushing them. A child that waits a
 * short time for its input can give up while this process is busy with other
 * work. A file is complete before the child starts, whatever this process is
 * doing, and there is no pipe-buffer or argv size limit.
 *
 * The file is written with mode 0600 inside a fresh 0700 directory under `dir`
 * (the OS temp directory by default), and both are removed before this
 * returns. No file is left behind: the data lives in an unlinked temp file
 * until the child closes its stdin, and the prompt never appears in argv,
 * where other users of the machine can read it.
 */
export function openPromptStdin(prompt: string, dir: string = tmpdir()): number {
  const holder = mkdtempSync(join(dir, "prompt-"));
  try {
    const file = join(holder, "prompt");
    writeFileSync(file, prompt, { mode: 0o600, flag: "wx" });
    return openSync(file, "r");
  } finally {
    rmSync(holder, { recursive: true, force: true });
  }
}
