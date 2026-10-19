import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Heuristic-solver tests legitimately run multiple solvers sequentially
    // (each with its own time budget); 30s accommodates them under vitest 3's
    // worker model without weakening any test or solver budget.
    testTimeout: 30000,
  },
  resolve: {
    alias: [
      // node:sqlite is a Node 22.5+ builtin that Vite 5's resolver does not
      // recognize — alias it to a createRequire-based shim for tests only.
      // Production code keeps the direct builtin import.
      { find: /^node:sqlite$/, replacement: path.resolve(__dirname, "./src/test-utils/sqlite-shim.ts") },
      { find: "@", replacement: path.resolve(__dirname, "./src") },
    ],
  },
});
