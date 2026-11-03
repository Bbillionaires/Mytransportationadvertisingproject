# Product Requirements — Rideshare Media Network

## Problem and opportunity
Passengers in rideshare, taxi and shuttle vehicles spend idle minutes in the back seat. Local and national advertisers want measurable, geographically relevant reach. Drivers and independent creators want fair, transparent extra income. Today no network combines family-safe entertainment, verifiable ad delivery, purchase attribution, and an **auditable** revenue split.

## Product
A passenger-facing tablet network with original and licensed creator channels, advertiser commercials and banners, interactive offers and coupons, and optional rider accounts. Revenue from it is split, auditably, between drivers, creators and the platform.

## Users and primary jobs
| Role | Primary jobs |
|---|---|
| Super Admin | Run the network: tenants, devices, content and campaign approvals, revenue rules, accounting, compliance |
| Fleet Operator | Manage own vehicles, drivers, tablets; see fleet metrics; nothing outside their fleet |
| Driver | Subscribe ($30/mo, no earnings guarantee), keep the tablet healthy, see estimated vs. approved earnings and statements |
| Advertiser | Upload creatives, run scheduled/geofenced campaigns, set commission offers, see performance and invoices |
| Creator | Publish family-friendly original/licensed videos, see watch metrics and earnings, handle takedowns/appeals |
| Rider | Watch and tap without an account; optionally sign in via QR for rewards, saved coupons and games |

## Business rules (v1, from the master spec)
- Splits apply to **net distributable** revenue: 5/60/35 creator-content ads, 5/0/95 standalone ads, 15/10/75 commissions with creator, 15/0/85 without.
- Creator pool: weighted 50/30/20 (attributed revenue, watch time, qualified views). Driver pool: weighted 50/25/25 (monetized delivery, engagement, active hours).
- Driver subscription: $30/month, billed and accounted for separately, transparent cancellation.
- Rule changes are new, approved, effective-dated versions. History is never recalculated.

## Success metrics (pilot)
- Ledger: 0 unbalanced entries; 100% of payouts reconciled to provider reports within 2 business days.
- Device fleet: ≥ 97% tablets reporting heartbeat during service hours.
- Integrity: invalid-traffic rate measured and < 3% of raw impressions after validation.
- Safety: 0 published items without human confirmation where AI moderation was uncertain.

## Non-goals (v1)
Cash gambling or paid chances; ingesting YouTube or other third-party platform content without authorization; driver-facing screens; storing rider trip history.

## Release plan
Six phases (see `BACKLOG.md`). Pilot in a single city with synthetic-to-real data migration only after phases 1–4 pass their acceptance criteria and the blocking decisions in `DECISIONS.md` are resolved.
