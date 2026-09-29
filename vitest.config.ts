import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["./test/setup.ts"],
    // Several tests spawn the built CLI as a subprocess and set their own
    // spawnSync timeouts (10s-60s). The default 5s per-test vitest timeout is
    // below those budgets, so under parallel load vitest preempts a still-
    // running subprocess before its own timeout fires, producing load-
    // dependent flakes. Raise the vitest timeout above the largest spawn
    // budget so a genuine hang surfaces at the subprocess timeout instead.
    testTimeout: 60_000,
  },
});
