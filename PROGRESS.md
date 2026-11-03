# Progress Log

Status legend: ✅ done and tested · 🟡 partial · ⬜ not started. "Tested" means covered by the automated suite (`npm test`) against a real PostgreSQL 16 database. **Nothing here is production-ready.** No live integration with any payment provider, EMM, or app store has been performed.

## 2026-11-03 — Session 1

Starting point: an empty repository (no commits, no files).

### Phase 0 — Architecture ✅
- Product requirements: `docs/PRD.md`
- Gap analysis against every spec section: `docs/GAP_ANALYSIS.md`
- Architecture and ADRs: `docs/ARCHITECTURE.md`
- ERD (implemented and planned): `docs/ERD.md`
- Ledger specification with journal examples: `docs/LEDGER.md`
- API contracts (implemented and planned): `docs/API.md`
- Permissions matrix: `docs/PERMISSIONS.md`
- Threat model: `docs/THREAT_MODEL.md`
- Milestone backlog with acceptance criteria: `docs/BACKLOG.md`
- Deployment guide: `docs/DEPLOYMENT.md`
- Decisions register / risk register: `DECISIONS.md`, `RISKS.md`

### Phase 1 — Foundation 🟡
| Item | Status | Evidence |
|---|---|---|
| Monorepo, TypeScript strict, npm workspaces | ✅ | `package.json`, `tsconfig.base.json` |
| Forward-only checksummed SQL migrations | ✅ | `apps/api/src/db/migrate.ts`; re-run is a no-op |
| Organizations (tenants), users, roles, permissions, memberships | ✅ | migration 0001; `tenancy.test.ts` |
| Login, opaque sessions, logout, lockout | ✅ | `auth.test.ts` |
| TOTP MFA (encrypted secret, replay-protected), MFA required for finance/platform permissions | ✅ | `auth.test.ts` |
| Server-side RBAC + tenant isolation (app checks + composite FKs) | ✅ | `tenancy.test.ts` |
| Hash-chained immutable audit log | ✅ | `tenancy.test.ts` |
| Fleets, vehicles, drivers registry | ✅ | `tenancy.test.ts`, `devices.test.ts` |
| Device enrollment (one-time codes), Ed25519 signed requests, nonce replay and clock-skew protection | ✅ | `devices.test.ts` |
| Heartbeat (app version, storage, connectivity, last sync), remote commands (suspend/resume/refresh/purge) with ack | ✅ | `devices.test.ts` |
| Device ↔ vehicle assignment, one at a time (DB exclusion constraint) | ✅ | `devices.test.ts` |
| Admin console shell (sign-in, MFA, orgs, trial balance, rules, audit) | 🟡 | `apps/api/public/index.html`; read-only views; not browser-tested |
| CI (typecheck, tests with Postgres service, dependency audit) | ✅ | `.github/workflows/ci.yml` (not yet run on GitHub) |
| Observability | 🟡 | Structured logs with request IDs and secret redaction, `/healthz`, `/readyz`. No metrics/tracing yet. |
| Support impersonation | 🟡 | Schema and enforcement (privileged permissions are blocked while impersonating); start/stop endpoints not built. |
| Account unlock, password reset, invitation emails | ⬜ | |

### Pulled forward from Phase 3/4 (see D-023)
| Item | Status | Evidence |
|---|---|---|
| `@rmn/finance-core`: exact money, waterfall, split rules, party split, hybrid creator pool, driver pool, proportional reversal | ✅ | 28 tests including 1,000-run property tests |
| Double-entry ledger: chart of accounts, immutable entries, deferred balance check, periods, idempotency, reversals | ✅ | `ledger.test.ts` |
| Manual entries and reversals with dual approval (separation of duties) | ✅ | `ledger.test.ts` |
| Versioned revenue rules, two-approver governance, overlap prevention, frozen history | ✅ | `revenue.test.ts` |
| Allocation batches posted to the ledger (5/60/35, 5/0/95, 15/10/75, 15/0/85), funding check, idempotency, concurrency | ✅ | `revenue.test.ts` |
| Trial balance, payables from ledger | ✅ | `revenue.test.ts` |
| Refund/chargeback reversal **posting** of allocations | 🟡 | Math implemented and property-tested (`proportionalReversal`); API and ledger posting not built |
| Payouts, Stripe Billing subscription, Stripe Connect, webhooks inbox | ⬜ | Blocked on D-026 / D-010 |
| P&L, balance sheet, cash flow, CSV/PDF statements | ⬜ | |

### Test totals
- `@rmn/finance-core`: 28 passed
- `@rmn/api`: 38 passed (real PostgreSQL)

## 2026-11-03 — Session 2: playback event pipeline (M2.6) ✅

Goal: earnings must come from verified tablet data, not from numbers a caller submits.

| Item | Status | Evidence |
|---|---|---|
| Signed event batch ingestion, (device, eventId) dedupe, per-event rejection, clock-drift correction | ✅ | `pipeline.test.ts` |
| Append-only raw event store (immutable) | ✅ | `pipeline.test.ts` |
| Device status history (status at event time) | ✅ | `pipeline.test.ts` |
| `VALIDATION_POLICY_V1`: qualified views, muted handling, verified watch time, anti-idle active time | ✅ | `policy.test.ts` (8 tests) |
| Validator: campaign/creative/video approval, campaign window, assignment, overlaps, impossible durations, duplicate clicks, per-tablet hourly rate cap, daily active cap, offline and late holds | ✅ | `pipeline.test.ts` |
| Human review of held events (once, named reviewer, note; late events cannot be approved into allocated windows) | ✅ | `pipeline.test.ts` |
| Allocation of a campaign window from VALID events only: creator-content vs. standalone batches, non-overlapping windows, settle delay, blocked by pending or held events | ✅ | `pipeline.test.ts` |
| Campaign delivery metrics (impressions, qualified views, completions, skips, CTR, invalid/held counts) | ✅ | `pipeline.test.ts` |
| Validator job script | ✅ | `npm run jobs:validate-events -w @rmn/api` |
| Minimal campaigns/creatives/videos tables (records created via SQL; management API is M2.4/M2.7) | 🟡 | migration 0005 |

Known gap: the manual `POST /v1/finance/allocations` endpoint still accepts caller-supplied metrics (kept for commissions and back-office adjustments). Before go-live, restrict AD allocations to the event-derived path, or put the manual path behind dual approval.

Test totals: finance-core 28, API 56 (all passing against PostgreSQL 16).

### Next steps (in order)
1. M3.4: refunds/chargebacks → allocation reversal posting (math exists), clawback receivable.
2. M2.4/M2.7: campaign and creative management API + advertiser portal (replaces SQL-created campaigns); tablet playlist API with signed media URLs.
3. M2.1–M2.3: media upload/transcode, fail-closed moderation, rights and takedown.
4. Phase 1 remainder: invitations/password reset, unlock, impersonation endpoints, metrics.
5. Phase 3: Stripe **test-mode** Billing, webhook inbox, invoices, reconciliation, reports.
6. M2.5 Android player: needs a real device and the hardware/EMM decision (D-017).
