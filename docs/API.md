# API Contracts (v1)

Conventions:
- JSON over HTTPS. Money is an **integer string of minor units** (`"97070"` = $970.70) plus an ISO-4217 `currency`.
- Errors have the shape `{ "error": { "code", "message", "details?" }, "requestId" }`.
- Every response carries `x-request-id`.
- Auth: `Authorization: Bearer <session token>` for people. Tablets use signed device headers (see below).
- Mutating financial endpoints take an `idempotencyKey`; replaying it returns the original result.
- Cross-tenant resources return 403 (wrong org route) or 404 (foreign id inside your own org route).

Error codes: `UNAUTHENTICATED` 401 · `FORBIDDEN` / `MFA_REQUIRED` / `SEPARATION_OF_DUTIES` / `IMPERSONATION_RESTRICTED` / `IMMUTABLE_RECORD` 403 · `NOT_FOUND` 404 · `CONFLICT` / `OVERLAP_VIOLATION` 409 · `UNPROCESSABLE` / `FINANCIAL_RULE_VIOLATION` / `INTEGRITY_VIOLATION` 422 · `RATE_LIMITED` 429.

## Implemented

### Identity
| Method | Path | Permission | Notes |
|---|---|---|---|
| POST | `/v1/auth/login` | public (10/min) | `{email,password}` → `{token, expiresAt, mfaRequired}` |
| POST | `/v1/auth/logout` | session | revokes session |
| GET | `/v1/me` | session | user, session MFA state, memberships + permissions |
| POST | `/v1/auth/mfa/enroll` | session | returns TOTP secret + otpauth URI (shown once) |
| POST | `/v1/auth/mfa/activate` | session | `{code}` enables MFA and verifies the session |
| POST | `/v1/auth/mfa/verify` | session | `{code}`; time-step replay rejected |

### Organizations and audit
| Method | Path | Permission |
|---|---|---|
| POST | `/v1/orgs` | `platform.orgs.manage` (MFA) |
| GET | `/v1/orgs` | session (own orgs; platform staff see all) |
| POST | `/v1/orgs/:orgId/members` | `org.members.manage` in org; platform roles need `platform.users.manage` |
| GET | `/v1/orgs/:orgId/members` | `org.members.manage` |
| GET | `/v1/audit?orgId&limit` | `platform.audit.read` (MFA) |

### Fleets
| Method | Path | Permission |
|---|---|---|
| GET/POST | `/v1/orgs/:orgId/fleets` | `fleet.read` / `fleet.manage` |
| GET/POST | `/v1/orgs/:orgId/vehicles` | `fleet.read` / `fleet.manage` |
| GET/POST | `/v1/orgs/:orgId/drivers` | `fleet.read` / `fleet.manage` |
| POST | `/v1/orgs/:orgId/drivers/:driverId/eligibility` | `fleet.manage`; `ELIGIBLE` only by platform staff |

### Devices
| Method | Path | Auth |
|---|---|---|
| POST | `/v1/orgs/:orgId/devices/enrollment-codes` | `device.manage` → one-time code (shown once) |
| GET | `/v1/orgs/:orgId/devices` | `device.read`; includes health and current assignment |
| POST | `/v1/orgs/:orgId/devices/:deviceId/assignments` | `device.manage` `{vehicleId, driverId?}` |
| POST | `/v1/orgs/:orgId/devices/:deviceId/commands` | `device.command` `{command: REFRESH_PLAYBACK\|SUSPEND\|RESUME\|UPDATE_CONFIG\|PURGE_RIDER_DATA}` |
| POST | `/v1/devices/enroll` | enrollment code (5/min) `{code, serial, publicKey(base64 SPKI Ed25519), appVersion}` |
| POST | `/v1/devices/heartbeat` | **signed device** → `{deviceStatus, playbackAllowed, commands[]}` |
| POST | `/v1/devices/commands/:id/ack` | **signed device** `{ok, detail?}` |

**Device signature:** the headers `X-Device-Id`, `X-Device-Timestamp` (unix seconds, within ±300 s), `X-Device-Nonce` (16–64 url-safe characters, single use) and `X-Device-Signature` = base64 Ed25519 signature over
`METHOD \n PATH \n TIMESTAMP \n NONCE \n hex(sha256(raw body))`.

### Finance (all require an MFA-verified session)
| Method | Path | Permission |
|---|---|---|
| GET | `/v1/finance/accounts` | `finance.read` |
| GET | `/v1/finance/trial-balance?asOf` | `finance.read` → rows, per-currency totals, `balanced` |
| GET | `/v1/finance/journal-entries[/:id]` | `finance.read` (detail includes lines, `reversedBy`) |
| GET/POST | `/v1/finance/periods` | `finance.read` / `finance.period.manage` |
| POST | `/v1/finance/periods/:id/close` | `finance.period.manage`; refused while requests are pending in the period |
| POST | `/v1/finance/journal-requests` | `finance.journal.request` `{idempotencyKey, entryDate, description, reason, lines[]}` |
| POST | `/v1/finance/journal-entries/:id/reversal-requests` | `finance.journal.request` |
| GET | `/v1/finance/journal-requests?status` | `finance.read` |
| POST | `/v1/finance/journal-requests/:id/decision` | `finance.journal.approve`; requester ≠ approver |
| GET/POST | `/v1/finance/revenue-rules` | `finance.read` / `finance.rules.draft` |
| POST | `/v1/finance/revenue-rules/:id/approve` | `finance.rules.approve`; two distinct non-drafter approvers |
| POST | `/v1/finance/allocations/preview` | `finance.read` — full calculation, nothing posted |
| POST | `/v1/finance/allocations` | `finance.allocation.post` — idempotent, funding-checked, posts journal |
| GET | `/v1/finance/allocations/:id` | `finance.read` |
| GET | `/v1/finance/payables` | `finance.read` — from ledger balances |
| POST | `/v1/finance/allocations/:id/reversal-requests` | `finance.journal.request` `{idempotencyKey, type: REFUND\|CHARGEBACK\|CREDIT, amount, entryDate, reason, processor?}` → request + proportional plan; approved via journal-requests decision |

Allocation request body:
```json
{
  "idempotencyKey": "camp-42:2026-11-01",
  "kind": "AD",
  "sourceRef": "campaign-42:2026-11-01..2026-11-02",
  "advertiserOrgId": "uuid",
  "fundingAccount": "2000",
  "currency": "USD",
  "periodStart": "2026-11-01T00:00:00Z",
  "periodEnd": "2026-11-02T00:00:00Z",
  "entryDate": "2026-11-03",
  "grossReceipts": "100000",
  "taxCollected": "0", "refunds": "0", "credits": "0", "chargebacks": "0",
  "deductions": [{ "type": "PAYMENT_PROCESSING_FEE", "amount": "2930", "description": "card", "contractRef": "ADV-MSA-v1 §4.2" }],
  "creators": [{ "creatorId": "uuid", "attributedRevenue": "60000", "verifiedWatchSeconds": "3000", "qualifiedViews": "40" }],
  "drivers":  [{ "driverId": "uuid", "monetizedAdDelivery": "300", "qualifiedEngagement": "10", "eligibleActiveSeconds": "36000" }]
}
```
Phase 2 note: once the validated-event pipeline exists, creator/driver metrics will be computed server-side from validated aggregates, and the request will carry only the source window.

### Events (session 2, see `EVENTS.md`)
| Method | Path | Auth |
|---|---|---|
| POST | `/v1/devices/events` | **signed device** `{batchId, events[≤500]}` → `{received, accepted, duplicates, rejected[]}` |
| POST | `/v1/events/validate` | `events.validate` (MFA) → `{processed, valid, invalid, held}` |
| GET | `/v1/events/held` | `events.review` (MFA) |
| POST | `/v1/events/review` | `events.review` `{eventIds[], decision: APPROVE\|REJECT, note}` |
| GET | `/v1/finance/campaigns/:id/metrics?from&to` | `finance.read` |
| POST | `/v1/finance/campaigns/:id/allocation-windows[/preview]` | `finance.allocation.post` / `finance.read` `{idempotencyKey, periodStart, periodEnd, entryDate, deductions[]}` |

### Campaigns, review and playlist (session 4)
| Method | Path | Auth |
|---|---|---|
| POST | `/v1/advertisers/register` | public (3/min) `{organizationName, email, displayName, password}` |
| GET/POST | `/v1/orgs/:orgId/campaigns` | `campaign.read` / `campaign.manage` |
| GET/PATCH | `/v1/orgs/:orgId/campaigns/:id` | `campaign.read` / `campaign.manage` (billing terms frozen after submit → 403) |
| POST | `/v1/orgs/:orgId/campaigns/:id/creatives` | `campaign.manage` `{name, kind: VIDEO\|BANNER\|DISPLAY, durationMs?, headline?, bodyText?, mediaKey?, destinationUrl?}` |
| POST | `/v1/orgs/:orgId/campaigns/:id/{submit,pause,resume,end}` | `campaign.manage` |
| GET | `/v1/orgs/:orgId/campaigns/:id/metrics?from&to` | `campaign.read` |
| GET | `/v1/orgs/:orgId/balance` | `campaign.read` (prepaid, refunds pending, commissions owed) |
| GET | `/v1/review/campaigns` | `campaign.review` (MFA) |
| POST | `/v1/review/campaigns/:id/decision` | `campaign.review` `{decision, note, creatives[{creativeId, decision, note?}]}`; every pending creative must be decided to approve |
| POST | `/v1/review/creatives/:id/decision` | `campaign.review` (new creative on a live campaign, or withdrawal) |
| GET | `/v1/devices/playlist` | **signed device** → `{playbackAllowed, market, validUntil, ads[], content[]}` with signed expiring media URLs |

Campaign fields: `category`, `pricingModel` (CPM \| CPQV), `rateMinor`, `startsAt`, `endsAt`, `destinationUrl` (https only), `markets[]` (empty = all), `timezone`, `daysOfWeek[]` (0 = Sunday), `startMinute`, `endMinute` (overnight allowed), `frequencyCapPerHour`, `priority` 1–10, `skipDelaySeconds`.

### Media, moderation and rights (session 5, see `MEDIA_MODERATION.md`)
| Method | Path | Auth |
|---|---|---|
| POST | `/v1/orgs/:orgId/uploads` | `media.upload` `{filename, contentType, sizeBytes, sha256}` → `{uploadId, chunkSizeLimit}` |
| PUT | `/v1/uploads/:id/content` | `media.upload`; `application/octet-stream` chunk ≤ 8 MB with `Content-Range: bytes s-e/total` |
| POST | `/v1/uploads/:id/complete` | `media.upload` → UPLOADED or FAILED (checksum/type) |
| GET | `/v1/uploads/:id` | `media.upload` → progress, status, error, asset (duration, size, signed thumbnail) |
| GET | `/media/<key>?exp&sig` | signed link only; renditions and thumbnails only; supports `Range` |
| POST | `/v1/creators/register` | public (3/min) `{channelName, email, displayName, password}` |
| GET | `/v1/orgs/:orgId/channels`, `/v1/orgs/:orgId/videos` | `creator.read` (videos include moderation outcome and notices) |
| POST | `/v1/orgs/:orgId/videos` | `creator.manage` `{channelId, uploadId, title, description?, attestation{RIGHTS_ATTESTATION_V1 …}}` |
| GET | `/v1/rights/attestation` | public: current attestation text, version, hash |
| POST | `/v1/orgs/:orgId/videos/:id/appeal` | `creator.manage` `{statement}` |
| POST | `/v1/orgs/:orgId/videos/:id/counter-notice` | `creator.manage` `{takedownId, statement, signature, goodFaithBeliefOfMistake, consentToJurisdiction}` |
| GET | `/v1/moderation/queue`, `/v1/moderation/appeals` | `content.review` (MFA) |
| POST | `/v1/moderation/cases/:id/decision` | `content.review` `{decision, reasons[], note}` |
| POST | `/v1/moderation/appeals/:id/decision` | `content.review` `{decision: UPHOLD\|OVERTURN, note}`; not the original reviewer |
| POST | `/v1/takedowns` | public (5/min) notice → video removed immediately |
| GET | `/v1/takedowns`; POST `/v1/takedowns/:id/resolve` | `takedown.manage` `{action: RESTORE\|UPHOLD\|WITHDRAWN, note}` |

Ad creatives (`POST /v1/orgs/:orgId/campaigns/:id/creatives`) now take `uploadId` for VIDEO/DISPLAY; `durationMs` and the media key come from the processed asset.

### Budgets and scheduled allocation (session 6)
| Method | Path | Auth |
|---|---|---|
| POST/PATCH | `/v1/orgs/:orgId/campaigns[/:id]` | adds `totalBudgetMinor`, `dailyBudgetMinor` (nullable; editable while live) |
| GET | `/v1/orgs/:orgId/campaigns/:id/spend` | `campaign.read` → `spent`, `spentToday`, `unbilled`, `remainingBudget`, `deliveryBlockedBy` |
| GET | `/v1/orgs/:orgId/balance` | now also `committedUnbilled` and `available` |
| POST | `/v1/finance/allocation-windows/run` | `finance.allocation.post` → per-campaign ALLOCATED/SKIPPED with reasons |

### Payments, billing and reconciliation (session 7, see `PAYMENTS.md`; test mode only)
| Method | Path | Auth |
|---|---|---|
| POST | `/v1/webhooks/stripe` | Stripe signature (HMAC, 5-minute tolerance); idempotent per event id |
| GET/POST | `/v1/drivers/me/subscription` | `driver.subscription.manage`; POST needs `{acceptDisclosure: true}` → checkout URL |
| POST | `/v1/drivers/me/subscription/cancel` | `driver.subscription.manage` (cancel at period end) |
| GET | `/v1/drivers/me/invoices` | `driver.subscription.manage` |
| POST | `/v1/orgs/:orgId/prepayments` | `billing.manage` `{amountMinor}` → checkout URL |
| GET | `/v1/orgs/:orgId/invoices` | `billing.manage` (receipts and credit notes) |
| POST | `/v1/orgs/:orgId/prepayment-refund-requests` | `finance.reconcile` → approved via journal-requests decision by a different user |
| GET | `/v1/finance/webhooks`; POST `/v1/finance/webhooks/retry` | `finance.reconcile` |
| POST | `/v1/finance/reconciliation/runs` | `finance.reconcile` `{from, to, compareBalance}` |
| GET | `/v1/finance/reconciliation/exceptions`; POST `/:id/resolve` | `finance.reconcile` / `finance.journal.approve` |

### Attribution and commissions (session 8)
See `COMMISSIONS.md` for the full table: commission offers, integration API keys, `POST /v1/devices/coupons`, `POST /v1/conversions`, `POST /v1/conversions/refunds`, `GET /v1/orgs/:orgId/conversions`, `POST /v1/finance/commissions/run`. The playlist now includes `clickIdParam` and `coupon` per ad.

### Earnings, statements and reports (session 9)
See `REPORTING.md`.

### Accounts, support access and metrics (session 10)
See `ACCOUNTS.md`. Self-registration now returns `202 {status: PENDING_VERIFICATION}` (no ids); clients read their organization from `GET /v1/me` after verification.

## Planned (Phase 2–6, contracts to be versioned when built)
- Media: creator playlists/series, object-store adapter, virus scanning.
- Campaigns: geofences and per-campaign budgets.
- Payouts: `/v1/finance/payout-batches` (dual approval), provider onboarding links.
- Riders: QR session handoff, coupons, games.
