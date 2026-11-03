# Sales Attribution and Advertiser-Funded Commissions (M4.2)

## Flow
```
advertiser ─ commission offer (campaign; % of sale or fixed per sale; immutable) ─┐
tablet ─ ad tap (CLICK event, validated)  ──────────── clickId = the event's eventId ─┤
tablet ─ "Get coupon" → unique code / QR (RMNCOUPON:XXXXXXXXXX) ────────── couponCode ─┤
advertiser server ─ POST /v1/conversions (API key) {orderId, saleAmountMinor, couponCode | clickId}
        → ATTRIBUTED (commission computed) | UNATTRIBUTED (reason recorded)
after hold_days (default 14) ─ jobs:allocate-commissions → allocation batch 15/10/75 or 15/0/85, funded by 1100 receivable
refund reported ─ before allocation: commission reduced │ after allocation: CREDIT reversal request → finance approver
```

## ATTRIBUTION_POLICY_V1 (D-022: defaults implemented, still to be confirmed in contracts)
- Only an explicit order reported by the advertiser counts. A landing-page visit is never a sale.
- **Coupon beats click.** A coupon code is single-use (DB unique) and valid from issue until `coupon_window_hours` (default 30 days).
- **Click:** the tablet appends `rmn_click=<eventId>` to the destination URL (`clickIdParam` in the playlist). The advertiser returns it as `clickId`. Only a **VALID** click on the advertiser's own campaign counts, and the order must fall within `click_window_hours` (default 7 days). One tap may lead to several separate orders (last-click).
- An order before its touchpoint, an expired code, a product or currency outside the offer, or a foreign advertiser's touchpoint all mean UNATTRIBUTED, with the reason stored.
- **Creator attribution:** the approved content video the ad or coupon was shown with. **Driver attribution:** the vehicle assignment at the time of the tap or code issue.
- The commission base is the advertiser-funded commission, never the whole sale: `floor(net sale × bps / 10000)`, or the fixed amount while any part of the sale stands.
- Orders are deduplicated per advertiser by `orderId`. A re-send with the same values is idempotent; different values give a 409 (changes are reported as refunds).

## Anti-fraud
- Up to 3 codes per tablet per campaign per hour.
- Codes are issued only to ACTIVE, vehicle-assigned, signed tablets for running, approved campaigns with an active coupon offer.
- Clicks go through the event validator (duplicate-click, schedule, market and device checks).
- Commissions are allocated only after the refund-hold period.

## API
| Method | Path | Auth |
|---|---|---|
| POST/GET | `/v1/orgs/:orgId/campaigns/:id/commission-offers` | `campaign.manage` / `campaign.read` |
| POST | `/v1/orgs/:orgId/commission-offers/:offerId/end` | `campaign.manage` |
| POST/GET | `/v1/orgs/:orgId/integration-keys`; POST `/:keyId/revoke` | `integrations.manage` (key shown once; stored as SHA-256) |
| POST | `/v1/devices/coupons` | signed device `{campaignId, creativeId, contentVideoId?}` → `{code, qrPayload, expiresAt}` |
| POST | `/v1/conversions` | `Authorization: Bearer rmnk_…` `{orderId, occurredAt, saleAmountMinor, currency, couponCode?, clickId?, productSku?}` |
| POST | `/v1/conversions/refunds` | API key `{orderId, refundRef, saleAmountMinor}` (idempotent per refundRef) |
| GET | `/v1/orgs/:orgId/conversions` | `campaign.read` |
| POST | `/v1/finance/commissions/run` | `finance.allocation.post` (normally `jobs:allocate-commissions`, daily) |
