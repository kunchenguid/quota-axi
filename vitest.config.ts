import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["./test/setup.ts"],
    // CLI fixtures spawn their own processes; parallel files exhaust shared hosts.
    fileParallelism: false,
  },
});
