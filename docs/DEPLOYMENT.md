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
npm run dev                     # http://127.0.0.1:8080/admin/
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
1. **Database roles (R-002).** Create `rmn_owner`, which owns the schema and runs migrations only, and `rmn_app`, the runtime role:
   ```sql
   GRANT USAGE ON SCHEMA public TO rmn_app;
   GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA public TO rmn_app;
   GRANT UPDATE ON users, sessions, devices, device_enrollment_codes, device_assignments, device_commands,
         drivers, accounting_periods, journal_requests, revenue_rule_versions, allocation_lines, memberships, organizations TO rmn_app;
   GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO rmn_app;
   -- no UPDATE/DELETE on journal_*, audit_log, allocation_batches; no TRUNCATE anywhere; rmn_app never owns tables
   ```
2. Use TLS to the database (`sslmode=verify-full`); config refuses non-TLS URLs for remote hosts in production.
3. Load secrets (`APP_ENCRYPTION_KEY`, DB password) from a secret manager, not files.
4. Run `npm run db:migrate` as `rmn_owner` in a release job, then deploy API containers as `rmn_app`.
5. Put a TLS load balancer in front, set `NODE_ENV=production` (enables HSTS and trust proxy), `HOST=0.0.0.0`.
6. Enable PITR backups and test a restore quarterly. Verify the audit hash chain nightly.
7. Monitor `/readyz` and alert on 5xx rate, heartbeat gaps, and `trial-balance.balanced = false`.
8. **Do not** seed synthetic data (`db:seed` refuses in production). Create the platform org and first super admin through a controlled bootstrap with two people present. Draft and dual-approve the real revenue rules with signed contract references.
9. Run workers: `jobs:validate-events` (every minute), `jobs:allocate-windows` (hourly, alert on non-zero exit) and `jobs:process-media` (continuously; isolated container with ffmpeg, no network, timeouts; R-023). Replace local media storage with an object store + CDN that verifies signed URLs (R-021).
10. `LIVE_PAYMENTS_ENABLED` stays `false` (enforced) until D-010 and D-026 are resolved and a real integration verification has passed.
