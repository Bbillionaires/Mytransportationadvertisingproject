# Gap Analysis (against the master build prompt v1.0)

**Starting point:** the repository was empty (no commits, no framework, no features). Everything below is new. "Built" means implemented and covered by automated tests in this session.

| Spec section | Built | Gap remaining | Phase |
|---|---|---|---|
| Mission / working docs | PRD, ADRs, ERD, API, permissions, ledger spec, backlog, deployment, PROGRESS/DECISIONS/RISKS | Keep updated each step | ongoing |
| Roles and tenancy | 10 roles, permissions, memberships, tenant isolation, MFA for privileged perms, dual control, impersonation restrictions | Impersonation start/stop endpoints, rider identity, advertiser/creator scoped sub-users | 1, 5 |
| Immutable business rules | Versioned rules with all four splits, effective dates, approvals, frozen history, no silent fallback | Contract documents linked to each version | 3 |
| Net revenue waterfall | `computeNet` with tax exclusion, adjustments, cited permitted deductions, prohibited deductions, negative-net review | Automatic sourcing from invoices/payments/fees | 3 |
| Ledger and payouts | (session 7: Stripe test-mode subscriptions and prepayments, signed webhook inbox, refunds, disputes, receipts, reconciliation with fee/payout booking) Double-entry ledger, chart of accounts, immutability, periods, idempotency, reversals, dual-approved manual entries, trial balance, payables | Invoices, Stripe Billing/Connect, webhook inbox, payout batches, reconciliation runs, P&L / balance sheet / cash flow, CSV/PDF statements, holds/disputes | 3–4 |
| Hybrid creator monetization | Exact 50/30/20 scoring, zero-denominator reweighting, hold, exact-sum payouts | Qualified-view definitions computed from validated events, creator dashboards, rights attestations, takedown | 2, 4 |
| Driver pool and commissions | Exact 50/25/25 pool, eligibility from DB, 15% commission routing | Anti-idle active-time computation, driver dashboard, statements | 2, 4 |
| Purchase attribution | Commission batches (with/without creator) funded from receivable | Click/coupon capture, conversion API, dedupe, windows, refunds reversing commissions, disputes | 4 |
| Admin console | Shell: sign-in, MFA, orgs, trial balance, rules, audit | All management screens and write actions, approval queues, scheduling, emergency override | 1–2 |
| Advertiser portal | Self-registration, campaigns, creatives, submit/pause/resume/end, metrics, prepaid balance, console views | Full UI, media upload, invoices, refund history, team users UI | 2–3 |
| Tablet player (Android) | Server side: enrollment, signed heartbeat, remote commands, assignments | Native app, kiosk enrollment, playback, caching, offline queue, restricted webview | 2 |
| Geofenced promotions | — | Eligibility engine, cooldowns, privacy minimization | 5 |
| Coupons, rewards, games | Reward liability account (2300) | Everything else; chance-based games disabled pending legal review | 5 |
| Creator marketplace and moderation | Creator self-registration, channels, resumable uploads, ffmpeg processing, AI pre-screen + mandatory human review, policy-coded rejections, appeals, rights attestations, copyright notices/counter-notices | Vision/speech classifier vendor, creator playlists, creator dashboard UI, repeat-infringer policy | 2–4 |
| Playback analytics / invalid traffic | Signed batch ingestion, raw vs. validated store, VALIDATION_POLICY_V1, overlaps, duplicate clicks, rate caps, anti-idle, offline/late holds with human review, campaign metrics | Coupon, game and landing-page events; device spoofing heuristics across tablets; dashboards | 2–5 |
| Modular integration architecture | Module boundaries, versioned `/v1` REST | Webhooks out, scoped API keys/OAuth, module registry | 4–6 |
| Core schema | Identity, tenancy, fleets, devices, ledger, rules, allocations | See `ERD.md` planned list | 2–6 |
| Security / ops / compliance | See `THREAT_MODEL.md` | RLS, non-owner DB role automation, metrics/tracing, backups runbook, secret manager, pen test | 1, 6 |
| Testing invariants | #1, #2, #3, #4, #5, #6, #7 (allocations, journal posts, device replay), #8, #14 tested; #10 partly (subscription isolated from pools) | #10 payouts, #11 rider sessions (#12 offline events: session 2; #9 refunds/chargebacks: session 3; #13 AI failure → human review: session 5) | 2–5 |
| Phased delivery | Phase 0 done; Phase 1 mostly done; Phase 3/4 calculation core done | See `BACKLOG.md` | — |
