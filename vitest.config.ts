import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
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
