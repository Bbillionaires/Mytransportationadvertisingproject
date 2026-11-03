# Payments, Billing and Reconciliation (Phase 3, TEST MODE ONLY)

Live money movement is disabled: `LIVE_PAYMENTS_ENABLED` can only be `false`, the Stripe client accepts only `sk_test_…` keys, and live-mode webhook events are recorded as exceptions and never acted on (D-010).

## Flows
| Flow | Trigger | Ledger (posted only on the processor's confirmation) |
|---|---|---|
| Driver $30/month subscription | `POST /v1/drivers/me/subscription` (driver must accept the no-earnings-guarantee disclosure) → Stripe Checkout | `invoice.paid`: Dr 1010 Processor clearing / Cr **4200** Driver subscription revenue [driver] (+ Cr 2100 tax). Never touches revenue pools or payables. |
| Subscription status | `customer.subscription.created/updated/deleted`, `invoice.payment_failed` | none (status: ACTIVE / PAST_DUE / CANCELED) |
| Cancellation | `POST /v1/drivers/me/subscription/cancel` → cancel at period end | none; no further charges |
| Advertiser prepayment | `POST /v1/orgs/:orgId/prepayments` ($10–$100,000) → Stripe Checkout | `payment_intent.succeeded`: Dr 1010 / Cr **2000** Advertiser prepaid [advertiser]; receipt invoice |
| Prepayment refund | finance request (capped by unrefunded payment **and** uncommitted funds) → different approver → Stripe refund | `charge.refunded`: Dr 2000 / Cr 1010; credit note. Refunds made directly in Stripe also post, and raise an exception if they exceed uncommitted funds. |
| Dispute | `charge.dispute.created` | exception for a person (evidence; allocation reversal via the refund/chargeback flow) |
| Processor fees | reconciliation run | Dr 5000 / Cr 1010 per charge (balance transaction id) |
| Processor payout to bank | reconciliation run | Dr 1000 / Cr 1010 |

Each posting is idempotent on the processor's object id (`stripe-invoice-paid:<in_>`, `stripe-payment:<pi_>`, `stripe-refund:<re_>`, `stripe-fee:<txn_>`, `stripe-payout:<txn_>`), so duplicate or replayed events can never double-post.

## Simulated checkout (development only)
With `PAYMENTS_PROVIDER=fake` (the default outside production), checkout links open `/dev/checkout/<session>` instead of Stripe. The page is clearly labelled as simulated. **Pay** builds the same signed events Stripe would send (`payment_intent.succeeded`; or `customer.subscription.created` + `invoice.paid` for subscriptions) and posts them to the real `/v1/webhooks/stripe` endpoint. Balances, receipts and ledger entries therefore follow the production code path. No money moves.

Guards:
- The fake provider is refused when `NODE_ENV=production`, and the route module throws if registered in production.
- Each session can be paid once.
- Sessions live in memory and are lost when the dev server restarts.

## Webhook inbox
`POST /v1/webhooks/stripe` verifies the `Stripe-Signature` header (HMAC-SHA256 over `t.payload`, 5-minute tolerance), stores the event (unique per event id), then processes it. Failures retry with exponential backoff (`jobs:process-webhooks`, every minute). After 8 attempts the event becomes an `UNHANDLED_EVENT` exception. Ops view: `GET /v1/finance/webhooks`.

## Reconciliation
`POST /v1/finance/reconciliation/runs {from, to, compareBalance}` matches Stripe balance transactions to recorded payments and refunds, books fees and payouts, and raises exceptions for:
- unknown provider transactions;
- amount mismatches;
- recorded payments missing at the provider;
- a lifetime clearing balance that differs from the provider's net balance.

Exceptions are resolved with a note by `finance.journal.approve`. **A period cannot close while exceptions dated in it are open.**

## Stripe test-mode setup checklist (not yet performed against Stripe)
1. In a Stripe **test** account, create Product "Driver participation" with a recurring Price of $30.00/month. Set `STRIPE_DRIVER_PRICE_ID`.
2. Set `PAYMENTS_PROVIDER=stripe` and `STRIPE_SECRET_KEY=sk_test_…`.
3. Create a webhook endpoint `https://<host>/v1/webhooks/stripe` for the events `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`, `payment_intent.succeeded`, `charge.refunded` and `charge.dispute.created`. Set `STRIPE_WEBHOOK_SECRET=whsec_…`. Locally: `stripe listen --forward-to localhost:8080/v1/webhooks/stripe`.
4. Run the scenarios in `apps/api/test/payments.test.ts` by hand with test cards (4242…, 4000 0000 0000 0341 for failed renewals, 4000 0000 0000 0259 for disputes), then run reconciliation with `compareBalance: true` and expect zero exceptions.
5. Record the results in PROGRESS.md. Only after this, together with D-026 (payout provider) and explicit approval, may live mode be considered.
