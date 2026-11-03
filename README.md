# Rideshare Media Network

A passenger-facing tablet entertainment and advertising network for rideshare, taxi, shuttle and fleet vehicles. It combines creator channels, advertiser campaigns and offers with an **auditable double-entry ledger** that splits net revenue between drivers, creators and the platform.

> **Status: early foundation, not production-ready.** Live payments are hard-disabled. Demo data is synthetic. See [PROGRESS.md](PROGRESS.md) for what is built and tested, [DECISIONS.md](DECISIONS.md) for open business, legal and accounting decisions, and [RISKS.md](RISKS.md).

## Repository layout
```
packages/finance-core/   Pure, exact-integer financial engine (waterfall, splits, pools, reversals) + property tests
apps/api/                Fastify API: identity, RBAC/tenancy, fleets, devices, ledger, revenue rules, allocations
  migrations/            Forward-only SQL; ledger invariants enforced by the database
  public/index.html      Admin console shell
  test/                  Integration tests against real PostgreSQL
docs/                    EVENTS (playback validation policy), PRD, architecture/ADRs, ERD, ledger spec, API, permissions, threat model, backlog, deployment
```

## Quick start
```bash
docker compose up -d postgres
npm ci
cp .env.example .env && $EDITOR .env          # set APP_ENCRYPTION_KEY=$(openssl rand -base64 32), DB URLs
set -a; . ./.env; set +a
npm run db:migrate
SEED_PASSWORD='demo-password-123' npm run db:seed   # SYNTHETIC demo data only
npm run dev                                         # http://127.0.0.1:8080/admin/
```

## Tests
```bash
npm run typecheck
npm test            # 28 finance-core tests (incl. property tests) + 91 API tests (media tests need ffmpeg)
```
The API tests reset the schema of `TEST_DATABASE_URL` (default `postgres://rmn:rmn@localhost:5432/rmn_test`).

## Revenue rules (v1, applied to NET distributable revenue)
| Revenue | Driver | Creator | Platform |
|---|---:|---:|---:|
| Ads alongside creator content | 5% | 60% | 35% |
| Standalone commercials | 5% | 0% | 95% |
| Advertiser-funded commission, with creator | 15% | 10% | 75% |
| Advertiser-funded commission, no creator | 15% | 0% | 85% |

The driver subscription ($30/month) is billed and accounted for separately (account 4200) and never enters these pools. Earnings are not guaranteed. See [docs/LEDGER.md](docs/LEDGER.md) for journal examples, rounding and hold policies.
