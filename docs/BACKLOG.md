# Milestone Backlog and Acceptance Criteria

Each milestone is done only when its criteria pass in CI against PostgreSQL. It must also ship migrations, API docs updates, and PROGRESS/DECISIONS/RISKS updates.

## Phase 0 — Architecture ✅
- [x] PRD, ADRs, ERD, ledger spec with journal examples, API contracts, permissions matrix, threat model, decisions register, risk register, this backlog.

## Phase 1 — Foundation (🟡 mostly done)
- [x] **M1.1 Identity.** Login/logout/lockout; TOTP MFA with encrypted secret and replay protection. *AC:* finance endpoints return `MFA_REQUIRED` until verified; a reused TOTP step is rejected.
- [x] **M1.2 Tenancy and RBAC.** *AC:* fleet admin A gets 403 on org B routes and 404 for B's ids under A's routes; DB rejects cross-tenant FKs.
- [x] **M1.3 Audit.** *AC:* hash chain links; UPDATE/DELETE/TRUNCATE refused.
- [x] **M1.4 Fleet and device registry.** *AC:* single-use enrollment; signed heartbeat; replay, tampering, foreign key and skew rejected; suspend stops playback; one active assignment per device/vehicle.
- [x] **M1.5 CI.** Typecheck, tests with a Postgres service, dependency audit.
- [ ] **M1.6 Account lifecycle.** Invitations, password reset (time-boxed tokens), admin unlock. *AC:* tokens single-use and expire; all audited.
- [ ] **M1.7 Support impersonation.** Start (reason, ticket, ≤ 30 min), banner, stop. *AC:* every action audited with both identities; finance perms impossible.
- [ ] **M1.8 Observability.** Prometheus metrics, OpenTelemetry traces, alert rules (heartbeat gaps, 5xx, unbalanced trial balance, failed webhooks).
- [ ] **M1.9 Admin console write actions** for orgs, members, fleets, devices, commands.
- [ ] **M1.10 Purge jobs** for device nonces and heartbeats per retention policy.

## Phase 2 — Media and campaigns
- ✅ **M2.1 Media pipeline** (session 5; object store + CDN adapter remains): resumable upload → virus scan → transcode (HLS ladders) → signed CDN URLs. *AC:* unapproved media never served.
- ✅ **M2.2 Moderation** (session 5; vendor classifier D-035 remains): ASR transcript, frame sampling, image/text checks, risk score → `HOLD` by default; human decision required when uncertain or erroring. *AC:* invariant 13 test (AI failure → HOLD).
- ✅ **M2.3 Rights** (session 5): creator attestations, takedown + counter-notice + appeal workflow.
- 🟡 **M2.4 Campaigns** (session 4: scheduling with time zones and overnight windows, market targeting, frequency caps, priority, skip delay, restricted categories, review queue; budgets and geofences remain): creatives (video, word/text banners, display), schedules with time zones, frequency caps, skip delay, rotation, budgets, regional targeting, approval queue.
- 🟡 **M2.5 Tablet playlist API** ✅ (session 4) **+ Android player** ⬜: kiosk (dedicated device) enrollment, autoplay, skip, banners, restricted webview with return control, media cache with expiry enforcement, signed offline event queue. *AC:* real-device test plan executed on target hardware.
- ✅ **M2.6 Event pipeline** (session 2, see `EVENTS.md`): raw append-only store → validator (signature, dedupe, drift, eligibility, fraud heuristics) → validated aggregates. *AC:* invariant 12 (offline events are not automatically billable); replayed events counted once.
- 🟡 **M2.7 Advertiser portal** (session 4: self-registration, campaign/creative API, metrics, balance, basic console views; full portal UI with uploads remains): self-registration, scoped users, metrics (impressions … ROI), never other advertisers' data.

## Phase 3 — Financial foundation
- ✅ **M3.1 Stripe test-mode Billing** (session 7; real Stripe run pending, R-025) for the $30 driver subscription. *AC:* subscription receipts post only to 4200; cancellation transparent.
- ✅ **M3.2 Webhook inbox** (session 7): signature verification, unique event ids, retries, outbox. *AC:* duplicate webhooks never double-post.
- 🟡 **M3.3 Invoices and advertiser prepayments** (session 7: prepayments, receipts, credit notes, subscription invoices; commission invoicing and tax engine remain) with tax lines (2100).
- ✅ **M3.4 Refunds/chargebacks → allocation reversals** (session 3) via `proportionalReversal`; clawback receivable for paid shares. *AC:* invariant 9.
- ✅ **M3.5 Reconciliation runs** (session 7) and exception queue; period-close checklist.
- **M3.6 Reports:** GL, trial balance, P&L, balance sheet, cash flow, receivables, liabilities, CSV/PDF.

## Phase 4 — Monetization
- 🟡 **M4.1 Scheduled allocation batches** (session 6: scheduled windows from validated events; per-advertiser fee schedules remain) from validated aggregates (no caller-supplied metrics).
- ✅ **M4.2 Attribution** (session 8; commission invoicing/collection deferred to the final Stripe phase): clicks, unique QR/coupon codes, conversion API, windows, dedupe, disputes.
- **M4.3 Payout onboarding** (Stripe Connect or chosen provider, D-026), payout batches with dual approval. *AC:* invariant 10 (payout ≤ approved payable; concurrent payouts can't overdraw).
- **M4.4 Creator and driver dashboards and statements:** gross → deductions → net → allocation → adjustments → pending/approved/paid with drill-down.

## Phase 5 — Rider engagement
QR sign-in with short-lived tokens; auto-logout and purge (invariant 11); coupons and redemption; geofence alerts; skill games; reward liability accounting. Chance-based features stay off until legal sign-off.

## Phase 6 — Scale
White label, module SDK with scoped clients, RLS, advanced anti-fraud, load tests (target: 50k tablets × 1 event/10 s), pen test, compliance approvals.
