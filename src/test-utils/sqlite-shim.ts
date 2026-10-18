// Test-only shim for node:sqlite.
// Vite 5's resolver does not recognize the node:sqlite builtin (Node 22.5+)
// and fails to load it in the test pipeline. This shim is aliased in place
// of "node:sqlite" by vitest.config.ts ONLY — production code keeps the
// direct builtin import. It loads the real builtin via createRequire,
// which bypasses Vite's module resolution entirely.
import { createRequire } from "node:module";

const req = createRequire(import.meta.url);
const mod = req("node:sqlite") as typeof import("node:sqlite");

export const DatabaseSync = mod.DatabaseSync;
export default mod;
