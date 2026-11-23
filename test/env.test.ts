import { describe, expect, test } from "vitest";
import { withoutEnv } from "../src/index.js";

// Every value below is a fake.
const FAKE = { API_TOKEN: "fake-token", DEPLOY_KEY: "fake-key" } as const;

describe("withoutEnv", () => {
  test("removes the named vars and passes every other key through unchanged", () => {
    const base = { PATH: "/usr/bin", HOME: "/home/x", SSH_AUTH_SOCK: "/tmp/ssh.sock", ...FAKE };
    expect(withoutEnv(base, ["API_TOKEN", "DEPLOY_KEY"])).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/x",
      SSH_AUTH_SOCK: "/tmp/ssh.sock",
    });
  });

  test("a name the input lacks stays absent", () => {
    const env = withoutEnv({ PATH: "/usr/bin" }, ["API_TOKEN"]);
    expect(env).toEqual({ PATH: "/usr/bin" });
    expect("API_TOKEN" in env).toBe(false);
  });

  test("only exact names are removed: longer names, suffixes and other cases are kept", () => {
    const base = { API_TOKEN: "x", API_TOKEN_OLD: "kept", MY_API_TOKEN: "kept", api_token: "kept" };
    expect(withoutEnv(base, ["API_TOKEN"])).toEqual({
      API_TOKEN_OLD: "kept",
      MY_API_TOKEN: "kept",
      api_token: "kept",
    });
  });

  test("the input is copied, never changed, even with nothing to remove", () => {
    const base = { PATH: "/usr/bin", ...FAKE };
    const before = { ...base };
    const stripped = withoutEnv(base, ["API_TOKEN"]);
    expect(stripped).not.toBe(base);
    expect(base).toEqual(before);
    const untouched = withoutEnv(base, []);
    expect(untouched).not.toBe(base);
    expect(untouched).toEqual(before);
  });

  test("process.env comes back as a plain copy, and process.env itself keeps the name", () => {
    process.env.AGENT_REAPER_TEST_VAR = "fake";
    try {
      const env = withoutEnv(process.env, ["AGENT_REAPER_TEST_VAR"]);
      expect(env).not.toBe(process.env);
      expect("AGENT_REAPER_TEST_VAR" in env).toBe(false);
      expect(env.PATH).toBe(process.env.PATH);
      expect(process.env.AGENT_REAPER_TEST_VAR).toBe("fake");
    } finally {
      delete process.env.AGENT_REAPER_TEST_VAR;
    }
  });
});
