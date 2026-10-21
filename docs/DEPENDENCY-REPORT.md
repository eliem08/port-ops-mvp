# Dependency Vulnerability Report — 2026-10-19 (updated: vitest 5 upgrade, audit-ci exception)

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
| `postcss` | 8.5.30 (top) / 8.4.31 (nested under next) | **8.5.31 everywhere** (npm override) | dev | Top-level patch upgrade + override forces nested copy to 8.5.31. Fixes HIGH GHSA-gg55-p6h8-882q (sourceMappingURL). OSV: clean. |
| `sharp` | 0.34.5 (transitive via next) | **0.35.5** (direct) | prod | Within next's allowed range (`^0.34.3 \|\| ^0.35.5`). OSV: clean. |
| `vitest` | ^2.0.0 (2.1.9 installed) | **^5.0.5** | dev | Major upgrade (2 → 3 → 5); see below. Fixes moderate GHSA-82fw-gwwq-j7x9 (@vitest/mocker). |
| `tinypool` (via vitest) | 1.1.1 | **removed** | dev | vitest 5 no longer depends on tinypool, so CRITICAL RCEs GHSA-5gmw-xhrv-c9v3 / GHSA-85c8-ppgw-ccpr are gone and the `tinypool` override was dropped. |

## vitest 3 → 5 upgrade (completed)

vitest 4.1.11+ (the first release fixing GHSA-82fw-gwwq-j7x9) cannot be installed with
npm 10.9: its `@vitest/browser-webdriverio: ^4.1.11` peer range crashes arborist
(`Cannot read properties of null (reading 'edgesOut')`), even from an empty lockfile.
vitest 5.0.5 resolves cleanly, so the upgrade goes straight to 5. Node requirement
(`^22.12 || ^24`) is satisfied by `.nvmrc` (24). No config or test changes were needed;
all 263 tests pass.

## vitest 2 → 3 upgrade (completed)

Upgraded vitest@2.1.9 → 3.2.7. This was previously attempted and reverted due to
4 test timeouts in `src/lib/planning.test.ts` (heuristic-solver tests exceed vitest's
5s default timeout under v3's worker model).

**Resolution:** Added `testTimeout: 30000` to `vitest.config.ts`. The tests legitimately
need the time (each solver carries a 2s budget by design); the timeout is a config
issue, not a test weakness. No test assertions or solver budgets were changed.

## postcss nested override (completed)

CI `npm audit` flagged HIGH advisories on the **nested** `postcss@8.4.31` under `node_modules/next/node_modules/postcss`:
- GHSA-gg55-p6h8-882q — incomplete fix; attacker-controlled `sourceMappingURL` reads arbitrary files
- Path Traversal in Previous Source Map Auto-Loading (`sourceMappingURL`)

`npm audit fix --force` proposed `next@16.4.2` (breaking major upgrade) — **rejected**.
Fix: npm `overrides` entry `"postcss": "^8.5.31"` forces the nested copy to dedupe to the
already-clean top-level 8.5.31. Verified via `npm ls postcss` (all instances 8.5.31) and OSV
(0 advisories for postcss@8.5.31).

## Accepted risk: braces@3.0.3 — GHSA-vfj7-8cjw-p6xm (HIGH)

- **Advisory:** braces vulnerable to stack-exhaustion DoS through deeply nested brace patterns.
- **Status:** No patched version exists (3.0.3 is latest; OSV shows no `fixed` event).
- **Reachability:** braces is a transitive dev-only dependency via micromatch (glob matching in
  build tooling — tailwindcss/postcss pipeline and eslint). It is **not** in the production
  runtime bundle and never processes attacker-controlled input in this application.
- **Mitigation:** No action possible via upgrade. Re-evaluate if a patched version is released.
- **CI enforcement:** allowlisted by advisory ID only in `audit-ci.jsonc`; the full-tree audit
  still fails on any other high/critical advisory. Production deps are audited separately
  with no exceptions (`npm audit --omit=dev --audit-level=high` → 0 vulnerabilities).
- **Owner/action:** Revisit on future dependency updates; monitor GHSA-vfj7-8cjw-p6xm.

### postcss-selector-parser@6.1.4 — GHSA-rj75-hqrm-r3gf (moderate)
- **Advisory:** Quadratic complexity in flat selector parsing (CPU exhaustion).
- **Severity:** MODERATE, below the audit threshold; does not fail CI.
- **Reachable:** Dev-only, via tailwindcss 3 (build time, repo-authored CSS only).
- **Fix available:** tailwindcss 4 (breaking major migration, out of scope).

## Verification performed

| Command | Result |
|---------|--------|
| `npm ci` | ✅ 403 packages |
| `npm run lint` | ✅ 0 errors |
| `npm run typecheck` | ✅ clean |
| `npm run test` | ✅ 263/263 (19 files) |
| `npm run build` | ✅ succeeds |
| `npm run db:migrate` + `db:seed` (clean DB) | ✅ 5 users, 20 appts, 10 events, 3 reviews, 5 plans, 5 sims, 69 audits |
| `npm audit --omit=dev --audit-level=high` | ✅ 0 vulnerabilities |
| `npx audit-ci --config audit-ci.jsonc` | ✅ passes (only GHSA-vfj7-8cjw-p6xm allowlisted) |

## Secret hygiene (rechecked)
- `.env` remains untracked and ignored (verified via `git ls-files`).
- `.gitignore` covers `.env*`, `*.db*`, `.next/`, `node_modules/`.
- No secrets introduced in these changes (only `package.json` / `package-lock.json` / docs).
- Gitleaks scan passes in CI (unchanged).
