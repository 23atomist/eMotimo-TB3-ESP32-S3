import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 10000,
    // Test files bind real localhost TCP ports (mock TB3 HTTP+WS). Run files
    // serially so two files can never race for the same port (EADDRINUSE);
    // each file cleans up its servers, and Node sets SO_REUSEADDR so serial
    // reuse is immediate.
    fileParallelism: false,
  },
});
