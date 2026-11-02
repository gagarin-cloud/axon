import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Integration tests share one scratch database; keep files sequential.
    fileParallelism: false,
    testTimeout: 20_000,
    coverage: { include: ["src/**"], reporter: ["text", "html"] },
  },
});
