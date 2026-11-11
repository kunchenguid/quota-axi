import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["./test/setup.ts"],
    // Many tests spawn the built CLI; the 5s default flakes under parallel load.
    testTimeout: 30_000,
  },
});
