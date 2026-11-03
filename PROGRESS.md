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

## 2026-11-03 — Session 3: refunds, chargebacks and credits (M3.4) ✅

| Item | Status | Evidence |
|---|---|---|
| Reversal requests against posted allocation batches (REFUND → 2600, CHARGEBACK → 1010 with processor, CREDIT → funding account) | ✅ | `reversals.test.ts` |
| Proportional spread over all batch lines via largest remainder; cumulative cap per line (code + DB trigger) | ✅ | `reversals.test.ts` |
| Already-paid recipient shares → 1200 clawback receivable (D-021) | ✅ | `reversals.test.ts` |
| Dual approval (requester ≠ approver), idempotent, fully reversed lines marked REVERSED | ✅ | `reversals.test.ts` |
| Generic journal reversal of allocation entries blocked | ✅ | `reversals.test.ts` |
| Batch detail shows per-line reversed amounts and reversal history | ✅ | `reversals.test.ts` |

Spec invariant 9 (refunds/chargebacks produce balanced reversals and valid liability updates) is now covered. Test totals: finance-core 28, API 62.

## 2026-11-03 — Session 4: campaign management, review, and tablet playlist (M2.4 / M2.5 API / M2.7) 🟡

| Item | Status | Evidence |
|---|---|---|
| Advertiser self-registration (rate-limited) creating an isolated advertiser tenant | ✅ | `campaigns.test.ts` |
| Campaign API: create/edit drafts, submit, pause, resume, end; status machine in the DB | ✅ | `campaigns.test.ts` |
| Billing and delivery terms frozen after submission; only shortening allowed (DB trigger) | ✅ | `campaigns.test.ts` |
| Creatives: video (duration + media), display (media), word/text banners (headline); approved creatives immutable | ✅ | `campaigns.test.ts` |
| Restricted product categories refused; https-only destinations; IANA time zones | ✅ | `campaigns.test.ts` |
| Moderator role and review queue; every pending creative must be decided; reviewers can't approve their own org | ✅ | `campaigns.test.ts` |
| Scheduling (dayparts in campaign time zone, overnight windows), market targeting, frequency caps, priority, skip delay | ✅ | `schedule.test.ts`, `campaigns.test.ts` |
| Signed tablet playlist: only approved, funded, in-market, in-schedule ads; approved content; signed expiring media URLs | ✅ | `campaigns.test.ts` |
| Validator enforces schedule, market and frequency cap (out-of-terms plays never billed) | ✅ | `campaigns.test.ts` |
| Advertiser metrics and ledger-backed balance (tenant-scoped) | ✅ | `campaigns.test.ts` |
| Console views: advertiser Campaigns, moderator Review queue | 🟡 | Browser-checked at 390 px (Campaigns view, permission refusal); review approve buttons not browser-tested |
| Media upload/transcode, per-campaign budgets, geofences, invoices | ⬜ | M2.1, M2.4 remainder, Phase 3 |

Test totals: finance-core 28, API 72 (all passing).

## 2026-11-03 — Session 5: media upload, moderation and rights (M2.1–M2.3) ✅

| Item | Status | Evidence |
|---|---|---|
| Resumable chunked uploads (Content-Range, resume offset), declared size + SHA-256 verified, file type from magic bytes | ✅ | `media.test.ts` |
| ffprobe/ffmpeg processing: limits, H.264/AAC 720p faststart rendition, thumbnail, ≤30 sampled frames, 16 kHz audio | ✅ | `media.test.ts` (real ffmpeg) |
| AI pre-screen via provider interface + deterministic text screen; failures/unavailability → HIGH priority; never auto-publishes | ✅ | `media.test.ts` (invariant 13) |
| Human moderation queue, policy-coded rejections, immutable findings and decisions, no self-org review | ✅ | `media.test.ts` |
| Appeals decided by a different reviewer; overturn restores | ✅ | `media.test.ts` |
| Rights attestation (RIGHTS_ATTESTATION_V1) mandatory and immutable; optional license records | ✅ | `media.test.ts` |
| Copyright notices: immediate removal, counter-notice, 10-business-day wait, restore/uphold/withdraw | ✅ | `media.test.ts` |
| Signed rendition delivery with byte ranges; originals never served | ✅ | `media.test.ts` |
| Creator self-registration, channels, video list with moderation outcome and notices | ✅ | `media.test.ts` |
| Ad creatives require processed uploads; duration from ffprobe, not the advertiser | ✅ | `campaigns.test.ts`, `media.test.ts` |
| Media processing job; CI installs ffmpeg | ✅ | `jobs:process-media`, `.github/workflows/ci.yml` |
| Vision/speech classifier vendor (D-035), object store + CDN (R-021), virus scanning, creator dashboard UI | ⬜ | |

Test totals: finance-core 28, API 84 (all passing).

## 2026-11-03 — Session 6: budgets, funds reservation and scheduled allocation ✅

| Item | Status | Evidence |
|---|---|---|
| Total and daily (campaign-local) budgets; editable while live, positive only | ✅ | `budgets.test.ts` |
| Exact spend tracking in 1/1000 cent (CPM and CPQV) | ✅ | `budgets.test.ts` |
| Unbilled spend reserved against prepaid balance across all of an advertiser's campaigns | ✅ | `budgets.test.ts` |
| Playlist stops serving and validator stops billing at the same limit (BUDGET_EXHAUSTED, DAILY_BUDGET_EXHAUSTED, ADVERTISER_FUNDS_EXHAUSTED) | ✅ | `budgets.test.ts` |
| Advertiser spend endpoint; balance shows committed and available funds | ✅ | `budgets.test.ts` |
| Scheduled allocation windows (job + endpoint), idempotent, skip-and-report when blocked, system identity | ✅ | `budgets.test.ts` |
| Per-campaign spend counters / cached delivery state for scale (R-024) | ⬜ | |

R-020 (overspend between allocations) is mitigated. Test totals: finance-core 28, API 91.

## 2026-11-03 — Session 7: payments in test mode (M3.1–M3.3, M3.5) ✅ (Stripe round-trip pending)

| Item | Status | Evidence |
|---|---|---|
| Payment provider interface; Stripe REST client (test keys only, form encoding, idempotency keys) | ✅ unit | `payments.test.ts` (mocked transport) |
| In-process Stripe simulator for dev/demo/tests | ✅ | `payments.test.ts` |
| Signed webhook inbox: signature + timestamp check, per-event dedupe, live-mode events refused, retry with backoff, give-up → exception | ✅ | `payments.test.ts` |
| Driver $30 subscription: disclosure acceptance, checkout, status from webhooks, out-of-order safe, tax to 2100, failed renewal, cancel at period end, invoices | ✅ | `payments.test.ts` |
| Advertiser prepayments: checkout, credit on confirmation only, receipt, idempotent | ✅ | `payments.test.ts` |
| Prepayment refunds: capped by unrefunded and uncommitted funds, second approver, processor refund, ledger on confirmation, credit note | ✅ | `payments.test.ts` |
| Disputes → exception | ✅ | `payments.test.ts` |
| Reconciliation: match charges and refunds, book fees and payouts, missing/unknown/mismatch/balance-drift exceptions, idempotent re-runs | ✅ | `payments.test.ts` |
| Period close blocked by open reconciliation exceptions | ✅ | `payments.test.ts` |
| Real Stripe test-account round-trip (R-025) | ⬜ | Needs your Stripe test keys: docs/PAYMENTS.md checklist |

Test totals: finance-core 28, API 104.

## 2026-11-03 — Session 8: sales attribution and commissions (M4.2) ✅

| Item | Status | Evidence |
|---|---|---|
| Commission offers (% of sale / fixed per sale, SKU scope, windows, hold), immutable once created | ✅ | `commissions.test.ts` |
| Integration API keys (scoped, hashed, shown once, revocable) | ✅ | `commissions.test.ts` |
| Unique single-use coupon/QR codes from signed tablets, rate-limited, tied to driver and creator content | ✅ | `commissions.test.ts` |
| Conversion API: dedupe by order id, coupon-beats-click, VALID clicks only, windows, foreign touchpoints refused, reasons stored | ✅ | `attribution.test.ts`, `commissions.test.ts` |
| Commission allocation after the refund hold (15/10/75, 15/0/85) funded by advertiser receivable; idempotent | ✅ | `commissions.test.ts` |
| Refunds: reduce/cancel before allocation; after allocation → CREDIT reversal request approved by finance | ✅ | `commissions.test.ts` |
| Playlist advertises coupons and the click-id parameter | ✅ | playlist code |
| Commission invoicing and collection | ⬜ | Final Stripe phase (D-042) |

Test totals: finance-core 28, API 118.

## 2026-11-03 — Session 9: earnings dashboards, statements and financial reports (M4.4, M3.6) ✅

| Item | Status | Evidence |
|---|---|---|
| Creator earnings: summary, by category, ledger balances, drill-down (gross → deductions → net → split → basis → share → reversed), indicative estimates, disclosure | ✅ | `reports.test.ts` |
| Video performance ranking (qualified views, watch hours, monetized revenue, clicks, conversions, status) | ✅ | `reports.test.ts` |
| Driver earnings: same plus tablets, subscription, eligibility, conversions | ✅ | `reports.test.ts` |
| Monthly statements (JSON, CSV, PDF with verified xref) for creators, drivers, and finance for any recipient | ✅ | `reports.test.ts` |
| GL with running balances, income statement, balance sheet (A = L + E check), cash flow, liabilities, receivables aging, recipient earnings; CSV exports with formula-injection protection | ✅ | `reports.test.ts` |
| Console: Earnings view (creators/drivers) with statement downloads; Reports view (finance) | ✅ | Earnings view and PDF download browser-checked at 390 px |

Test totals: finance-core 28, API 127.

## 2026-11-03 — Session 10: account lifecycle, support access and metrics (Phase 1 remainder) ✅

| Item | Status | Evidence |
|---|---|---|
| Email verification for self-registered accounts; verified-email gate on paid/publishing permissions | ✅ | `accounts.test.ts` |
| Uniform registration response (no enumeration); existing owner notified; password strength checks | ✅ | `accounts.test.ts`, `campaigns.test.ts` |
| Password reset (no enumeration, single-use, unlocks, revokes sessions, change notice) | ✅ | `accounts.test.ts`, browser-checked |
| Invitations (single-use, 7 days, revocable, role/org-kind checks, existing-account attach) | ✅ | `accounts.test.ts` |
| Support actions: unlock, disable, enable, MFA reset (reason, audited, not on self) | ✅ | `accounts.test.ts` |
| Support impersonation (≤30 min, ticket + reason, both identities audited, user notified, staff excluded, ends on demand) | ✅ | `accounts.test.ts` |
| Transactional email outbox + delivery job (bodies purged after send); production provider pending (D-044) | ✅ / ⬜ | `accounts.test.ts` |
| Prometheus `/metrics` with business health gauges | ✅ | `accounts.test.ts` |
| Console: verify/reset/invite link handling, forgot-password | ✅ | browser-checked |
| Purge jobs for nonces/heartbeats (M1.10), OpenTelemetry tracing | ⬜ | |

Risk R-019 mitigated. Test totals: finance-core 28, API 138.

## 2026-11-03 — Session 11: rider engagement (Phase 5) ✅

| Item | Status | Evidence |
|---|---|---|
| Rider accounts (18+, uniform responses, verification, separate identity), wallet, self-service deletion with erasure | ✅ | `riders.test.ts` |
| QR sign-in: 2-minute single-use code, token delivered to the tablet once, device-bound 30-minute session, ends on drop-off/purge/suspend/new pairing | ✅ | `riders.test.ts` (invariant 11) |
| Coupons saved to the signed-in rider's wallet | ✅ | `riders.test.ts` |
| Proximity alerts: eligibility, speed suppression, global gap, cooldown, daily cap, randomized pacing, silent passenger-only 60 s alerts, outcomes, stats; no coordinates stored | ✅ | `proximity.test.ts`, `riders.test.ts` |
| Skill games: server-measured duration, server-scored trivia, implausibility checks, guest play; chance-based games blocked by DB constraint | ✅ | `riders.test.ts` |
| Sponsor reward programs, capped grants, single-use POS redemption with scoped key, outstanding obligations | ✅ | `riders.test.ts` |
| Tablet UI for all of the above | ⬜ | Android app (M2.5) |

Test totals: finance-core 28, API 153.

## 2026-11-03 — Session 12: web tablet player (D-049 web-first) ✅

| Item | Status | Evidence |
|---|---|---|
| `apps/player`: TypeScript web player served at `/player/` with strict CSP | ✅ | browser e2e |
| Enrollment with a non-extractable WebCrypto Ed25519 key; signed requests matching the server verifier; clock-offset tracking | ✅ | browser e2e |
| Playback: content, ad breaks (priority, frequency cap, expiry), banners, skip countdown, Next; "Advertisement" header | ✅ | browser e2e + screenshots |
| Exposure measurement (visible/unmuted time), offline IndexedDB event queue, signed batch upload | ✅ | events validated server-side in e2e |
| Ad taps with QR-to-phone + sandboxed in-tablet view; coupons; rider QR sign-in (token in memory only); trivia/memory games with rewards; silent proximity alerts | ✅ | browser e2e |
| Fleet commands (suspend/resume/refresh/purge) and heartbeat | ✅ | browser e2e |
| CI job running the browser e2e (Playwright + ffmpeg) | ✅ written | `.github/workflows/ci.yml` (not yet run on GitHub) |
| Fixed during e2e: `hidden` overridden by component CSS; `/player/` redirect dropped the query string | ✅ | |

Test totals: finance-core 28, API 153, plus the browser e2e ride.

## 2026-11-03 — Session 13: rider phone web app (installable PWA) ✅

| Item | Status | Evidence |
|---|---|---|
| `apps/rider` at `/rider/`: create account, email confirmation, sign in/out, password reset, profile, delete account | ✅ | rider browser e2e (Pixel 7 emulation) |
| Connect to a tablet: phone camera on the QR deep link, in-app scanner (BarcodeDetector), or typed code; pending link pairs after sign-in | ✅ | rider e2e (camera path simulated by opening the QR link) |
| Wallet with QR + code for checkout; offline via service worker app shell + saved wallet | ✅ | rider e2e (offline reload) |
| Server: rider password reset, profile update, deep-link pairing QR | ✅ | API tests + e2e |
| CI runs both browser e2e suites | ✅ written | not yet run on GitHub |

Bug found by e2e and fixed: the `?pair=` deep link was re-wrapped before parsing, so it never paired.
In-app camera scanning is not exercised by automation (no camera/BarcodeDetector in headless Linux); verify on a real phone.

Test totals: finance-core 28, API 153, browser e2e: tablet ride + rider app.

## 2026-11-03 — Session 14: Android kiosk shell (D-052, D-053)

| Item | Status | Evidence |
|---|---|---|
| `apps/android`: Kotlin shell loading the web player full-screen; managed config (`server_url`, `kiosk_enabled`); boot start; renderer-crash recovery; offline retry | ✅ builds | `./gradlew assembleDebug` |
| Device key in Android Keystore (ECDSA P-256, StrongBox preferred), never exported | ✅ written | not run on hardware (R-004) |
| Origin-restricted WebMessage bridge; signs only canonical `/v1/devices/` strings | ✅ | `BridgeProtocolTest` |
| Main frame locked to the server origin; https-only server URL in release | ✅ | `UrlPolicyTest` |
| Kiosk: lock task, HOME, keyguard/status bar disabled when device owner | ✅ written | needs a real tablet + EMM (D-017) |
| API accepts ECDSA P-256 device keys (DER signatures) besides Ed25519; rejects others | ✅ | `devices.test.ts` |
| Web player uses the native bridge when present (no key material in the page) | ✅ | player e2e: second tablet through a simulated bridge enrolls, signs and plays |
| CI job: Android build, unit tests, lint, debug APK artifact | ✅ written | not yet run on GitHub |

Fixed during e2e: the heartbeat overwrote the shell's app version with the web version.

Test totals: finance-core 28, API 154, Android unit tests (UrlPolicy, BridgeProtocol), browser e2e: tablet ride (web key + simulated Android key) and rider app.

### Next steps (in order; reprioritized by the product owner: payouts and Stripe go last)
1. Upgraded business web portals (advertiser, creator, driver, fleet, staff).
2. Android field test on one tablet with the chosen EMM; add key attestation at enrollment (R-028).
3. **Last:** Stripe test-mode round-trip with real keys (R-025), then M4.3 payouts (D-026).
