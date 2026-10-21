# Operations guide

Deployment, configuration, identity, monitoring, backups and upgrades for a
production installation.

## 1. Deploy

### Requirements
- One Linux host with Docker (or any container platform), 2 vCPU / 2 GB RAM is
  ample for a single terminal.
- A persistent volume for `/data` (database + backups).
- A DNS name and TLS. Use the bundled Caddy profile, or your own load balancer
  / reverse proxy terminating HTTPS in front of port 3000.

### First start
```bash
cp .env.example .env
```
Set these values in `.env` (or, better, in your secret store):

| Variable | Value |
|---|---|
| `AUTH_SECRET` | 32+ random characters. The server refuses to start without it. |
| `DATA_ENCRYPTION_KEY` | 32+ random characters, kept separately from `AUTH_SECRET`. Encrypts MFA seeds at rest. |
| `APP_BASE_URL` | Public URL, e.g. `https://ops.example.com` |
| `BOOTSTRAP_ADMIN_EMAIL` / `BOOTSTRAP_ADMIN_PASSWORD` | First administrator. Only used while no administrator exists; remove both after first sign-in. |

Generate a secret with: `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`

```bash
docker compose up -d                 # plain HTTP on :3000 (behind your own proxy)
APP_DOMAIN=ops.example.com docker compose --profile tls up -d   # Caddy + automatic HTTPS
docker compose logs -f app
```
Then sign in as the bootstrap administrator. You will be asked to change the
password and enroll an authenticator app. Create the other accounts under
**Users**.

### Without Docker
`npm ci && npm run build`, then run `node .next/standalone/server.js` with
`.next/static` copied into `.next/standalone/.next/static`, under a process
manager (systemd), with the same environment variables.

## 2. Identity

### Local accounts
- Administrators create accounts with a temporary password. The user must
  change it at first sign-in.
- Passwords: at least 12 characters, not common or repetitive, hashed with
  scrypt.
- Lockout: `LOCKOUT_THRESHOLD` failures (default 5) lock the account for
  `LOCKOUT_MINUTES` (default 15). Administrators can unlock early.
- MFA: roles listed in `MFA_REQUIRED_ROLES` (default `administrator`) must
  enroll a TOTP authenticator before they can use the application. Other users
  can opt in from **Account**.
- Sessions: `SESSION_TTL_HOURS` (default 8), stored server-side. Logout,
  disabling, password or MFA reset, and **Sign out** in the admin take effect
  immediately.

### Single sign-on (OpenID Connect)
1. Register a confidential web client with your IdP. Set the redirect URI to
   `${APP_BASE_URL}/api/auth/oidc/callback` and the scopes to `openid email profile`.
2. Make the IdP emit group/role values in the ID token, and map them:
   ```
   OIDC_ISSUER=https://login.microsoftonline.com/<tenant>/v2.0
   OIDC_CLIENT_ID=...
   OIDC_CLIENT_SECRET=...
   OIDC_PROVIDER_NAME=Company SSO
   OIDC_ROLE_CLAIM=roles                      # Keycloak: realm_access.roles · Okta/Entra: groups or roles
   OIDC_ROLE_MAP={"PortOps.Admins":"administrator","PortOps.Supervisors":"supervisor","PortOps.Planners":"planner","PortOps.Operators":"operations_operator","PortOps.Viewers":"operations_viewer"}
   ```
3. A user without a mapped group is refused, unless you set `OIDC_DEFAULT_ROLE`.
   Roles re-sync at every SSO sign-in, and MFA is enforced by the IdP. Local
   accounts keep working alongside SSO (for example as break-glass administrators).

## 3. Operating policy
**Settings → Gate verification** controls how much is automatic:
- *Allow automatic acceptance*: turn it off for supervised pilots. Every scan
  then waits for a supervisor.
- *Minimum OCR confidence*: from 70 (the GateWatch floor) up to 100.
Changes are recorded in the audit trail with before/after values.

## 4. Monitoring
| Endpoint | Purpose |
|---|---|
| `GET /api/health` | Liveness: the process is up (no DB access). |
| `GET /api/ready` | Readiness: DB reachable and schema current → 200, otherwise 503. The Docker `HEALTHCHECK` uses it. |
| `GET /api/metrics` | Prometheus. Requires `Authorization: Bearer $METRICS_TOKEN`; disabled when unset. Block it at the public edge (the Caddyfile does). |

Example Prometheus job:
```yaml
- job_name: port-ops
  metrics_path: /api/metrics
  authorization: { credentials: <METRICS_TOKEN> }
  static_configs: [{ targets: ["app:3000"] }]
```
Suggested alerts: `portops_reviews_pending` above your staffing threshold for
more than 30 minutes; `portops_failed_logins_24h` spikes; `portops_users{state="locked"} > 0`;
`/api/ready` failing; `portops_database_bytes` growth.

Logs are JSON lines on stdout/stderr (`LOG_LEVEL`=debug|info|warn|error).

### Audit to SIEM
Set `AUDIT_WEBHOOK_URL` (and optionally `AUDIT_WEBHOOK_TOKEN`). Every audit
event is POSTed as `{"events":[{id, seq, timestamp, actor, action, entity,
entityId, detail, source}]}` in batches of up to 200. Delivery is
at-least-once: the cursor advances only after a 2xx, so outages and restarts
resume where they stopped. Deduplicate on `id`.

## 5. Backups and restore
- **Scheduled:** `BACKUP_INTERVAL_HOURS=24` (the compose default) writes
  `/data/backups/portops-<UTC>.db` and keeps the newest `BACKUP_KEEP` (14).
- **On demand:** `POST /api/admin/backups` (administrator). From a source
  checkout, use `npm run db:backup`.
- Backups are online (`VACUUM INTO`, no downtime) and pass SQLite's
  `integrity_check` before they count. **Copy `/data/backups` off the host**
  (object storage, backup agent): a backup on the same disk is not a disaster
  recovery plan.

Restore (stop the app first):
```bash
docker compose stop app
docker compose run --rm --entrypoint sh app -c 'cp /data/backups/portops-20261101T020000Z.db /data/portops.db && rm -f /data/portops.db-wal /data/portops.db-shm'
docker compose start app
```
From a source checkout, `npm run db:restore -- backups/portops-….db` verifies
the file first and keeps the replaced database as `portops.db.pre-restore-<UTC>`.
Test a restore before go-live, and again regularly.

## 6. Upgrades
1. Take a backup.
2. Pull the new version and run `docker compose build && docker compose up -d`.
3. Migrations run automatically at start-up (each in a transaction).
   `/api/ready` returns 503 until the schema is current. Set
   `AUTO_MIGRATE=false` if you prefer to run `npm run db:migrate` yourself.

## 7. Data import
**Import** (supervisor or administrator) accepts appointments CSV files:
`truck_plate*, scheduled_at* (ISO UTC), container_no, driver_name, status
(requested|confirmed), external_ref`. Always run *Validate* first. Commits are
all-or-nothing, and re-sending a file with the same `external_ref` values
never duplicates rows. A template is available from the Import page.

## 8. Security checklist before go-live
- [ ] HTTPS only; HSTS is sent automatically in production.
- [ ] `AUTH_SECRET` and `DATA_ENCRYPTION_KEY` are random, distinct, and stored in a secret manager.
- [ ] `BOOTSTRAP_ADMIN_*` removed after first sign-in.
- [ ] `/api/metrics` is not reachable from the internet.
- [ ] Backups copied off-host; a restore has been tested.
- [ ] SSO configured, or MFA required for every role (`MFA_REQUIRED_ROLES`).
- [ ] Audit forwarding to your SIEM is configured.
- [ ] External penetration test completed.
