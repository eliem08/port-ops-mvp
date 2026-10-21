# Security — Port Operations Intelligence

What is protected, how, where to find it in the code, and what remains the
operator's or an external assessor's responsibility.

## 1. Controls

| Control | Where | Notes |
|---|---|---|
| **Authentication** | `src/lib/auth.ts`, `src/lib/accounts.ts`, `src/app/api/auth/*` | Email + password (scrypt N=2¹⁵, r=8, per-hash salt, upgradable parameters). Generic "invalid email or password" with timing equalization (no account enumeration). Lockout after `LOCKOUT_THRESHOLD` failures for `LOCKOUT_MINUTES`. Password policy: ≥12 chars, deny-list, repetitiveness, no email name. |
| **MFA** | `src/lib/totp.ts`, `/api/auth/mfa`, `/api/account/mfa` | RFC 6238 TOTP (tested against the RFC vectors), ±1 step drift, constant-time compare. Mandatory for roles in `MFA_REQUIRED_ROLES` (default administrators). Wrong codes count toward lockout. The second step is bound to a 5-minute signed challenge that cannot be replaced by a session token. |
| **Single sign-on** | `src/lib/oidc.ts`, `/api/auth/oidc/*` | OIDC authorization code + PKCE (S256), state and nonce bound to a signed, httpOnly, 10-minute cookie. The ID token is verified against the issuer JWKS (issuer, audience, expiry, nonce). IdP group → role mapping; unmapped users are denied by default. SSO never takes over a local account with the same email. |
| **Sessions** | `sessions` table, `getSession()` | Server-side rows; the cookie holds an HS256 JWT carrying only the session id. Each request re-checks revocation, expiry and the user's disabled flag. Revoked by logout, admin sign-out, disable, password reset and MFA reset. Cookie: `httpOnly`, `SameSite=Lax`, `Secure` in production; TTL `SESSION_TTL_HOURS` (8). |
| **Account setup gate** | `loadSession().restricted` | Accounts that must change their password or enroll MFA can reach only `/account` and the account APIs until done. Enforced in API routes, server actions and the layout. |
| **Authorization** | `requireApiRole`, `requireRole` (actions), root layout | Role ranks: viewer < operator = planner < supervisor < administrator. Every consequential route checks server-side; UI visibility is cosmetic. `/admin/*` is administrator-only and `/data/*` is supervisor+. |
| **Admin guard rails** | `updateUser()` | No self-disable or self-demotion; at least one active administrator always remains. |
| **CSRF** | `src/middleware.ts` (`isCrossSiteMutation`) | State-changing `/api` requests with a foreign `Origin` (or `Sec-Fetch-Site: cross-site`) get a 403, on top of `SameSite=Lax`. Server actions also carry Next.js's built-in origin check. |
| **Secrets** | `src/lib/auth-secret.ts`, `src/lib/crypto-box.ts` | In production the server refuses to start without a strong `AUTH_SECRET` (missing, known placeholder or under 32 chars). MFA seeds are sealed with AES-256-GCM using `DATA_ENCRYPTION_KEY` (HKDF), with a random IV per value; tampering is detected. |
| **Input validation** | `src/contracts/index.ts` | Strict Zod schemas on every route (unknown fields rejected), UTC datetimes, UUID ids, bounded strings. JSON bodies capped at 1 MB; CSV imports at 5 MB / 10,000 rows. |
| **Injection** | everywhere | Parameterized SQL only. CSV exports neutralize spreadsheet formulas (`= + - @`). React escapes output; the only raw HTML is the locally generated QR-code SVG. |
| **Redirects** | `src/lib/safe-redirect.ts` | Post-login `next` targets are restricted to same-origin paths. |
| **Headers** | `next.config.ts` | CSP (no `unsafe-eval` in production, `frame-ancestors 'none'`, `object-src 'none'`), HSTS in production, `X-Frame-Options: DENY`, `nosniff`, strict referrer, permissions policy; `X-Powered-By` removed. |
| **Rate limits** | `src/lib/rate-limit.ts` | Login and MFA: 10/min per IP. Gate scans: 60/min per user. Per-process memory; account lockout provides the durable brute-force protection. |
| **Audit trail** | `audit_events` | Append-only (no UPDATE/DELETE code paths). Records sign-ins, failures, lockouts, MFA changes, password changes, session revocations, user and policy changes, imports, exports, backups and every operational action. Scalar details only (no secrets, no request bodies). Viewer, CSV export (itself audited), and at-least-once SIEM shipping. |
| **Human in the loop** | `src/lib/settings.ts` | Policy can force every gate scan to supervisor review, or raise the confidence bar. It can only downgrade automatic acceptance, never upgrade it. OCR below 70 never authorizes on its own (vendored GateWatch invariant, regression-tested). |
| **Fail-closed verification** | vendored GateWatch + `api/gate/scans` | The appointment is loaded server-side by id (client claims are ignored). NaN or out-of-range confidence never auto-accepts. An appointment that cannot legally check in degrades to review. |
| **Errors** | `handleRouteError`, `src/lib/logger.ts` | Sanitized `{error:{code,message}}` envelope; details go only to server logs (JSON). |
| **Container** | `Dockerfile`, `docker-compose.yml` | Non-root (uid 1001), read-only root filesystem, all capabilities dropped, `no-new-privileges`. |
| **Supply chain** | `.github/workflows/ci.yml` | `npm audit` gate (production dependencies: zero high/critical; full tree: only documented, ID-pinned exceptions), Gitleaks secret scan, lint, typecheck, tests, build and container smoke test on every PR. |

## 2. Operator responsibilities

- Terminate TLS in front of the app (the bundled Caddy profile does it automatically).
- Keep `AUTH_SECRET` and `DATA_ENCRYPTION_KEY` in a secret manager. Rotating
  `AUTH_SECRET` signs everyone out; rotating `DATA_ENCRYPTION_KEY` requires
  users to re-enroll MFA.
- Keep `/api/metrics` internal.
- Copy backups off-host and test restores.
- Protect the host and volume: whoever can read `/data` can read the database.
  Use encrypted disks (cloud volume encryption or LUKS) for encryption at rest.
- Forward the audit trail to your SIEM and alert on lockouts and failed-login spikes.

## 3. Residual risks and next steps

| Item | Status |
|---|---|
| External penetration test | **To commission** before internet exposure. |
| Rate limits are per process | Fine for the single-node deployment; a shared store would be needed if the app is ever scaled horizontally. |
| Whole-database encryption at rest | Delegated to the volume or disk layer; application-level encryption covers MFA seeds only. |
| SQLite single node | See `docs/pilot/SQLITE-ASSESSMENT.md` for the PostgreSQL path if multi-node HA is required. |
| `style-src 'unsafe-inline'` / `script-src 'unsafe-inline'` | Required by the Next.js App Router bootstrap; a nonce-based CSP is a possible hardening step. |

## 4. Reporting a vulnerability
Email the maintainer listed in the repository with details and reproduction
steps. Please don't open public issues for security reports.
