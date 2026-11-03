# Deployment and Configuration

## Local development
```bash
# 1. Database (Docker) — or use any local PostgreSQL 16 with btree_gist + citext available
docker compose up -d postgres

# 2. Install and configure
npm ci
cp .env.example .env            # then set DATABASE_URL, TEST_DATABASE_URL, APP_ENCRYPTION_KEY (openssl rand -base64 32)
set -a; . ./.env; set +a

# 3. Migrate and seed SYNTHETIC demo data
npm run db:migrate
SEED_PASSWORD='choose-a-demo-password' npm run db:seed

# 4. Run
npm run dev                     # http://127.0.0.1:8080/portal/
```
Demo finance users must enroll TOTP (`POST /v1/auth/mfa/enroll`, then `/activate`) before any finance endpoint responds.

## Tests
```bash
npm run typecheck
npm test                 # finance-core property tests + API integration tests
npm run test:finance     # pure calculation tests only (no database needed)
```
API tests **drop and recreate the `public` schema** of `TEST_DATABASE_URL` (default `postgres://rmn:rmn@localhost:5432/rmn_test`). Never point it at a database you care about.

## Production checklist (not yet executed; nothing has been deployed)
1. **Database roles (R-002, R-003).** Migration `0016_row_level_security.sql` creates `rmn_app` (NOLOGIN, not a superuser, no BYPASSRLS), grants it DML and nothing else, revokes DELETE on `journal_entries`, `journal_lines` and `audit_log`, and installs the row-level-security policies. The API and every job switch each connection to it with `SET ROLE rmn_app` (`DB_RUNTIME_ROLE`, default `rmn_app`). It never owns tables, so it cannot disable triggers or bypass RLS.
   - Production: migrations run as an owner role (e.g. `rmn_owner`, a release job). The API logs in as a role that is a *member* of `rmn_app` and is not a superuser, or logs in as `rmn_app` directly (give it LOGIN and set `DB_RUNTIME_ROLE=''`).
   - If the migration cannot create the role (no CREATEROLE), an administrator runs once: `CREATE ROLE rmn_app NOLOGIN NOSUPERUSER NOBYPASSRLS; GRANT rmn_app TO <api login role>;` and re-runs the migration.
   - Tenant scope: each signed-in business user's requests carry `rmn.scope = tenant:<their org ids>`; platform staff get `platform`; tablets, riders, integration keys, sign-up and jobs run in the system scope. See `docs/ARCHITECTURE.md` (ADR in D-055).
2. Use TLS to the database (`sslmode=verify-full`); config refuses non-TLS URLs for remote hosts in production.
3. Load secrets (`APP_ENCRYPTION_KEY`, DB password) from a secret manager, not files.
4. Run `npm run db:migrate` as `rmn_owner` in a release job, then deploy API containers as `rmn_app`.
5. Put a TLS load balancer in front, set `NODE_ENV=production` (enables HSTS and trust proxy), `HOST=0.0.0.0`.
6. Enable PITR backups and test a restore quarterly. Verify the audit hash chain nightly.
7. Monitor `/readyz` and alert on 5xx rate, heartbeat gaps, and `trial-balance.balanced = false`.
8. **Do not** seed synthetic data (`db:seed` refuses in production). Create the platform org and first super admin through a controlled bootstrap with two people present. Draft and dual-approve the real revenue rules with signed contract references.
9. Run workers: `jobs:validate-events` (every minute), `jobs:allocate-windows` (hourly, alert on non-zero exit), `jobs:process-webhooks` (every minute), `jobs:allocate-commissions` (daily, alert on non-zero exit), `jobs:send-email` (every minute; needs the D-044 provider), `jobs:verify-spend-counters` (nightly; non-zero exit = counters drifted and were rebuilt — investigate). Scrape `/metrics` with `METRICS_TOKEN` and alert on `rmn_ledger_unbalanced_currencies > 0`, `rmn_webhooks_failed`, `rmn_reconciliation_exceptions_open` and a drop in `rmn_devices_online` and the **media worker** (`src/jobs/media-worker.ts`, continuous) in the isolated container from `infra/media-worker` (see below). Replace local media storage with an object store + CDN that verifies signed URLs (R-021).
10. `LIVE_PAYMENTS_ENABLED` stays `false` (enforced) until D-010 and D-026 are resolved and a real integration verification has passed.

## Isolated media worker (R-023)
`infra/media-worker/Dockerfile` with the `media-worker` service in `docker-compose.yml` (profile `worker`) runs ffmpeg on untrusted uploads with:
- a database-only internal network, so there is no route to the internet
- a read-only root filesystem; only the media volume and a 2 GB `/tmp` tmpfs are writable
- uid 1000 (not root), all Linux capabilities dropped, and `no-new-privileges`
- limits of 128 processes, 4 GB memory and 2 CPUs

In code, every ffmpeg/ffprobe call also runs under `prlimit` (address space, CPU seconds, output size, open files, no core dumps). Each call may only open local files (`-protocol_whitelist file`) and never reads stdin.

Verify it end to end with `bash infra/media-worker/verify.sh`. It processes a real upload inside the container and checks each restriction from the inside; CI runs it in `media-worker-isolation`. To build behind a TLS-inspecting proxy, pass `--secret id=ca,src=<ca.pem>`. The CA is never stored in the image.

## Rate limiting
Signed tablet requests (`/v1/devices/*` carrying `X-Device-Id`) are limited per device: 300 per minute each. Many tablets on one cellular carrier often share an IP address (CGNAT), and a per-IP limit would throttle them all together. Everything else is limited per client IP. In production, behind the load balancer, `trustProxy` is on so the real client IP is used.

## Load testing (R-015)
Run `TABLETS=1000 DURATION_S=90 npm run load:tablets -w @rmn/api`. It starts the real server against its own database (`rmn_load`) and drives signed tablet traffic, then times the validation job. See `docs/LOAD_TEST.md` for the latest results. CI runs a 300-tablet smoke version and fails on any error response.
