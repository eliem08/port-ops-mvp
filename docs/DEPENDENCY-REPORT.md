# Dependency Vulnerability Report — 2026-10-19

**Branch:** `fix/dependency-audit` · **Base:** `main` @ d357bd9
**Trigger:** CI run [#39176377066](https://github.com/eliem08/port-ops-mvp/actions/runs/39176377066)
failed `npm audit --audit-level=high` with 18 findings (5 moderate, 10 high, 3 critical).

> **Note on verification:** `npm audit` cannot run in this build environment
> (proxy returns 403 for the audit endpoint). The before-state is the CI-reported
> count. The after-state is verified by (1) upgrading to patched versions per the
> npm registry, (2) full local validation (lint, typecheck, 263 tests, build,
> DB smoke test), and (3) CI re-run on the PR. Final audit status must be
> confirmed from the CI run, not from local assumptions.

## Before / After

| Package | Before | After | Type | Rationale |
|---------|--------|-------|------|-----------|
| `next` | 15.5.4 | **15.5.28** | prod | Patch-line upgrade; fixes high/critical Next.js advisories. React 19 compatible. No breaking changes. |
| `eslint-config-next` | 15.5.4 | **15.5.28** | dev | Must match `next` version. |
| `postcss` | 8.5.30 | **8.5.31** | dev | Patch upgrade. Next.js nested copy stays at 8.4.31 per Next's own pin. |
| `sharp` | 0.34.5 (transitive via next) | **0.35.5** (direct) | prod | Within next's allowed range (`^0.34.3 \|\| ^0.35.5`). App does not use `next/image`; sharp is never invoked at runtime, but the flagged version is replaced. |
| `vitest` | ^2.0.0 (2.1.9 installed) | **^2.1.9** (unchanged) | dev | v3 upgrade attempted and **reverted** — see below. |

## Deliberately NOT upgraded

### vitest 2.1.9 → 3.x (reverted)
An upgrade to vitest@3.2.7 was attempted to pull a patched esbuild
(vite 7 + esbuild 0.28.2). It broke 4 tests in `src/lib/planning.test.ts`:
the heuristic-solver tests (greedy/annealing/tabu/genetic) exceed vitest's
5s default timeout when run sequentially under vitest 3's worker model
(each solver carries a 2s time budget by design).

**Decision:** Reverted to vitest 2.1.9 (all 263 tests pass). Per project policy,
a major upgrade that breaks working tests to fix a moderate dev-only advisory
is the wrong tradeoff. See remaining advisories below.

## Remaining advisories (documented, not silenced)

These are transitive dev-only dependencies. The vulnerable code is not
reachable in production. The audit threshold remains `--audit-level=high`;
no exceptions were added to CI.

### esbuild@0.21.5 (via vite@5.4.21 ← vitest@2.1.9)
- **Advisory:** GHSA-67mh-4wv8-2f99 — esbuild development server allows any
  website to send requests and read responses (moderate).
- **Reachable:** No. The vulnerable component is esbuild's *dev server*.
  In this project esbuild is used only by (a) vite for vitest test-file
  transformation and (b) tsx for running DB scripts. Neither starts the
  esbuild dev server; production serves via `next start`.
- **Impact:** A developer running `vitest` with a malicious website open in
  the same browser could theoretically be affected. CI runners are
  ephemeral and non-interactive.
- **Mitigation:** Do not run `npm run test` with untrusted browser tabs open.
  Revisit when vitest 3 stabilizes or if severity increases.
- **Owner/action:** Re-evaluate vitest 3 upgrade quarterly.

### tinypool@1.1.1 (via vitest@2.1.9)
- **Advisory:** Flagged in CI audit (exact ID from CI logs; environment
  cannot query the advisory DB directly).
- **Reachable:** No — dev-only worker pool for vitest. Not in production bundle.
- **Impact:** Minimal; test-runner internals only.
- **Mitigation:** Same as esbuild — resolved by a future vitest upgrade.
- **Owner/action:** Re-evaluate with vitest upgrade.

### vite@5.4.21 (via vitest@2.1.9)
- **Advisory:** Transitive; flagged in CI audit.
- **Reachable:** No — dev-only (vitest). Production builds use Next.js/Turbopack.
- **Impact:** None in production.
- **Mitigation:** Future vitest upgrade.

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
