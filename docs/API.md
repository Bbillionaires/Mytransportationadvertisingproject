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

## Planned (Phase 2–6, contracts to be versioned when built)
- Media: `POST /v1/creators/:id/videos` (resumable upload → transcode → moderation HOLD), `GET /v1/videos/:id`, takedown/appeal endpoints.
- Campaigns: `/v1/advertisers/:orgId/campaigns`, `/creatives`, `/schedules`, `/geofences`, submit-for-review; admin approval queue.
- Tablet: `GET /v1/devices/playlist` (signed, returns signed media URLs and expirations), `POST /v1/devices/events` (batched, signed, event-ID deduped).
- Subscriptions: `/v1/drivers/me/subscription` (Stripe Billing test mode), `POST /v1/webhooks/stripe` (signature-verified inbox).
- Attribution: `POST /v1/conversions` (advertiser API key, HMAC-signed, deduped by advertiser order ID), refunds/cancellations.
- Payouts: `/v1/finance/payout-batches` (dual approval), provider onboarding links.
- Riders: QR session handoff, coupons, games.
