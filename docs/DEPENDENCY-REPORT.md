# Dependency Vulnerability Report — 2026-10-19 (updated: vitest 3 upgrade)

**Branch:** `fix/dependency-audit` · **Base:** `main` @ d357bd9
**Trigger:** CI run [#39176377066](https://github.com/eliem08/port-ops-mvp/actions/runs/39176377066)
failed `npm audit --audit-level=high` with 18 findings (5 moderate, 10 high, 3 critical).

> **Note on verification:** `npm audit` cannot run in this build environment
> (proxy returns 403 for the audit endpoint). The before-state is the CI-reported
> count. The after-state is verified by (1) upgrading to patched versions per the
> npm registry, (2) OSV API queries for the new versions, (3) full local validation
> (lint, typecheck, 263 tests, build, DB smoke test), and (4) CI re-run on the PR.
> Final audit status must be confirmed from the CI run, not from local assumptions.

## Before / After

| Package | Before | After | Type | Rationale |
|---------|--------|-------|------|-----------|
| `next` | 15.5.4 | **15.5.28** | prod | Patch-line upgrade; fixes high/critical Next.js advisories. React 19 compatible. No breaking changes. OSV: clean. |
| `eslint-config-next` | 15.5.4 | **15.5.28** | dev | Must match `next` version. |
| `postcss` | 8.5.30 | **8.5.31** | dev | Patch upgrade. OSV: clean. Next.js nested copy stays at 8.4.31 per Next's own pin. |
| `sharp` | 0.34.5 (transitive via next) | **0.35.5** (direct) | prod | Within next's allowed range (`^0.34.3 \|\| ^0.35.5`). OSV: clean. |
| `vitest` | ^2.0.0 (2.1.9 installed) | **^3.2.7** | dev | Major upgrade; see below. OSV: 1 moderate advisory (GHSA-82fw-gwwq-j7x9), below audit threshold. |
| `vite` (via vitest) | 5.4.21 | **7.3.7** | dev | Pulled by vitest 3. OSV: clean. |
| `esbuild` (via vite) | 0.21.5 | **0.28.2** | dev | Pulled by vitest 3. OSV: clean. Fixes GHSA-67mh-4wv8-2f99. |
| `tinypool` (via vitest) | 1.1.1 | **2.2.0** (via npm overrides) | dev | Fixes CRITICAL RCEs GHSA-5gmw-xhrv-c9v3, GHSA-85c8-ppgw-ccpr. OSV: clean. See override rationale below. |

## vitest 2 → 3 upgrade (completed)

Upgraded vitest@2.1.9 → 3.2.7. This was previously attempted and reverted due to
4 test timeouts in `src/lib/planning.test.ts` (heuristic-solver tests exceed vitest's
5s default timeout under v3's worker model).

**Resolution:** Added `testTimeout: 30000` to `vitest.config.ts`. The tests legitimately
need the time (each solver carries a 2s budget by design); the timeout is a config
issue, not a test weakness. No test assertions or solver budgets were changed.

**tinypool override rationale:** vitest 3.2.7 still pins `tinypool: ^1.1.1`, which
carries CRITICAL RCE advisories. tinypool 2.x is API-compatible for vitest's usage
(verified: identical `Tinypool` class and `workerId` exports; v2 adds `withNullPrototype`
as part of the security fix). The `overrides` entry in package.json forces `^2.1.2`
(resolved: 2.2.0). This is a security patch application, not an incompatible version
force. Revisit when vitest pins tinypool 2.x natively. All 263 tests pass with the
override, confirming runtime compatibility.

## Remaining advisories (documented, not silenced)

### vitest@3.2.7 — GHSA-82fw-gwwq-j7x9 (moderate)
- **Advisory:** Path traversal / arbitrary file read via @vitest/mocker redirect mock.
- **Severity:** GitHub-reviewed MODERATE (CVSS 3.1, AC:H). Below the `--audit-level=high` threshold; does not fail CI.
- **Reachable:** Dev-only. Requires attacker control of test mock configuration. Test files are from the repo itself; CI runners are ephemeral.
- **Fix available:** vitest 4.1.11 (major upgrade, out of scope for this fix).
- **Mitigation:** Do not run tests with untrusted mock configurations. Re-evaluate on vitest 4.
- **Owner/action:** Revisit with future vitest major upgrade.

## Verification performed

| Command | Result |
|---------|--------|
| `npm ci` | ✅ 403 packages |
| `npm run lint` | ✅ 0 errors |
| `npm run typecheck` | ✅ clean |
| `npm run test` | ✅ 263/263 (19 files) |
| `npm run build` | ✅ succeeds |
| `npm run db:migrate` + `db:seed` (clean DB) | ✅ 5 users, 20 appts, 10 events, 3 reviews, 5 plans, 5 sims, 69 audits |
| `npm audit` | ⚠️ Cannot run locally (proxy 403) — **must be confirmed from CI** |

## Secret hygiene (rechecked)
- `.env` remains untracked and ignored (verified via `git ls-files`).
- `.gitignore` covers `.env*`, `*.db*`, `.next/`, `node_modules/`.
- No secrets introduced in these changes (only `package.json` / `package-lock.json` / docs).
- Gitleaks scan passes in CI (unchanged).
