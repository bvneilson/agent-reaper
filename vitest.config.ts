import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Remove once the first real tests land.
    passWithNoTests: true,
  },
});
