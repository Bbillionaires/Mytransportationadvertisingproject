# Playback Events and Validation (milestone M2.6)

Earnings are computed only from **validated** events. What a tablet reports is stored as received (raw), then checked against a versioned policy. Only events with status `VALID` count toward advertiser billing and creator/driver allocations.

```
tablet ──signed batch──▶ raw_events (append-only, deduped) ──validator──▶ validated_events
                                                                     VALID │ INVALID │ HELD_REVIEW ──human──▶ VALID/INVALID
                                                       VALID only ──▶ campaign window aggregation ──▶ allocation batches ──▶ ledger
```

## 1. Device protocol: `POST /v1/devices/events`
- Signed with the device key, exactly like heartbeat (see `API.md`).
- Body: `{ "batchId": uuid, "events": [ ≤ 500 events ] }`.
- Each event has a device-generated `eventId` (UUID). Resending an event is harmless: `(device, eventId)` is unique, so retries and offline-queue replays are counted once.
- Malformed events are rejected individually (`rejected[]`); the rest of the batch is stored.
- **Clock drift.** The server measures `offset = server receive time − X-Device-Timestamp` (bounded to ±300 s by signature verification) and adds it to every time in the batch. Raw rows keep both the device time and the corrected time.
- Tablets must report content playback as separate segments around ad breaks; overlapping video playback is rejected.

| Type | Fields |
|---|---|
| `AD_PLAYBACK` | campaignId, creativeId, contentVideoId? (the creator content the ad ran alongside), startedAt, endedAt, visibleMs, mutedMs, completed, skipped |
| `CONTENT_PLAYBACK` | videoId, startedAt, endedAt, visibleMs, mutedMs, completed |
| `CLICK` | campaignId, creativeId, contentVideoId?, target (LANDING_PAGE \| COUPON), occurredAt |
| `ACTIVE_SEGMENT` | startedAt, endedAt (≤ 15 min), screenOn, interactions |

## 2. Definitions: `VALIDATION_POLICY_V1` (`apps/api/src/modules/events/policy.ts`)
These definitions drive billing and payouts. They are **DECISION REQUIRED (D-027)** and must be disclosed in advertiser, creator and driver terms. Changing one requires a new policy version.

| Term | V1 definition |
|---|---|
| Video ad impression | ≥ 1 s visible |
| Qualified video ad view | unmuted visible ≥ min(15 s, 50% of creative duration) |
| Banner/display impression (= qualified view) | ≥ 1 s visible |
| Muted playback | counts as an impression, never as a qualified video ad view or verified watch time |
| Verified watch seconds (content) | floor(unmuted visible ms, capped at video duration ÷ 1000) |
| Qualified content view | unmuted visible ≥ min(30 s, 50% of video duration) |
| Creator attribution of an ad | the ad's `contentVideoId` is an **approved** video; that video's creator is attributed. Otherwise the ad is standalone |
| Eligible active time (driver) | screen on, segment ≤ 15 min, and either touch interactions or server-validated playback overlapping it (anti-idle); capped at 16 h per tablet per UTC day |
| Engagement (driver) | valid clicks |
| Earned spend | CPQV: qualified views × rate. CPM: floor(impressions × rate ÷ 1000) |

## 3. Outcomes
**INVALID** (never counts): unknown or unapproved campaign or creative; event outside the campaign window; unknown or unapproved video; tablet not ACTIVE at event time (from `device_status_history`); tablet not assigned to a vehicle at event time; future timestamp; older than 7 days; impossible duration (visible > wall clock or media length, or muted > visible); overlapping video playback on the same tablet; a second click on the same campaign within 10 min; idle or over-long active segment.

Campaign terms (session 4): `OUTSIDE_SCHEDULE` (outside the campaign's daypart in its time zone), `MARKET_NOT_TARGETED` (the tablet's fleet market is not targeted), and `FREQUENCY_CAP_EXCEEDED` (more qualified views on one tablet in a rolling hour than the advertiser's cap) are also INVALID, so advertisers never pay for delivery outside their terms.

Budgets and funds (session 6): a billable play (qualified view for CPQV, impression for CPM) is INVALID with `BUDGET_EXHAUSTED`, `DAILY_BUDGET_EXHAUSTED` (campaign-local day) or `ADVERTISER_FUNDS_EXHAUSTED` if it would push committed spend past the campaign's total budget, its daily budget, or the advertiser's prepaid balance minus unbilled spend on all of its campaigns. The playlist applies the same test, so ads stop being served at that point.

**HELD_REVIEW** (counts only after a person with `events.review` approves it):
- `OFFLINE_DELAYED`: received > 10 min after occurring. Offline playback never becomes revenue automatically (spec invariant 12).
- `RATE_ANOMALY`: more than 40 qualified ad views on one tablet in a rolling hour, across all campaigns.
- `ACTIVE_CAP_EXCEEDED`: more than 16 h of active time on one tablet in a day.
- `LATE_AFTER_ALLOCATION`: the event falls in a window that has already been allocated. It can only be rejected for now; paying it later needs a separate adjustment batch.

Validated measurements are immutable (DB trigger). A held event can be decided exactly once, by a named reviewer with a note.

## 4. Allocating a campaign window
`POST /v1/finance/campaigns/:id/allocation-windows` (`finance.allocation.post`, MFA):
1. The window must have ended at least `ALLOCATION_SETTLE_MINUTES` ago (default 60).
2. It is refused while any raw event for the campaign is unvalidated, or any event in the window is held.
3. Earned spend is computed from `VALID` events and split into a **creator-content** batch (rule 5/60/35) and a **standalone** batch (rule 5/0/95). Permitted deductions are spread across the two batches in proportion to earned spend.
4. Creator pool inputs: attributed earned spend, verified watch seconds and qualified content views in the window. Driver pool inputs: qualified ad views delivered, valid clicks, and eligible active seconds. All come from the database.
5. Windows for a campaign can never overlap (GiST exclusion), so no event is paid twice. The call is idempotent on `idempotencyKey`.

`/preview` returns the same calculation without posting. `GET /v1/finance/campaigns/:id/metrics?from&to` returns impressions, starts, qualified views, completions, skips, visible seconds, average visible seconds, clicks, CTR, and the invalid and held counts.

## 4b. Scheduled allocation (session 6)
`npm run jobs:allocate-windows -w @rmn/api` (hourly, after the validator) or `POST /v1/finance/allocation-windows/run` (`finance.allocation.post`).
For each campaign with unbilled valid events, it allocates one window from the end of the previous window (or the campaign start) to the most recent `ALLOCATION_WINDOW_MINUTES` boundary that closed at least `ALLOCATION_SETTLE_MINUTES` ago. Blocked windows (unvalidated or held events, closed period, missing rule) are skipped with a reason and the job exits non-zero so alerting picks them up. Postings are recorded as the system scheduler identity. Automated windows apply no deductions (D-038).

## 5. Operations
- Run `npm run jobs:validate-events -w @rmn/api` every minute. It is a single runner (advisory lock) and processes events in a deterministic order: per tablet, playback before active segments, in time order.
- Raw events are retained ≥ 13 months for dispute handling (proposed; see the ERD retention table).
