# Financial Ledger Specification

Highest-priority subsystem. The source of truth for every balance is `journal_lines`. Analytics, dashboards and allocation rows are derived views and never override the ledger.

## 1. Principles (all implemented and tested unless marked)

| Principle | Enforcement |
|---|---|
| Integer minor units only | `bigint` in TS and PG; floats throw `MoneyError`; JSON amounts are integer strings |
| Every entry balances per currency, ≥ 2 lines | Deferred constraint trigger `journal_entry_assert_balanced` runs at COMMIT |
| Posted history is immutable | `BEFORE UPDATE/DELETE/TRUNCATE` triggers on entries and lines; lines can only be added in the creating transaction |
| Corrections reverse and repost | `reverses_entry_id UNIQUE` (one reversal per entry); reversals of reversals are refused |
| Posting only inside an OPEN period | `journal_entries_period_guard`; closed periods cannot reopen (D-020) |
| Idempotency | `idempotency_key UNIQUE`, plus a payload hash: same key with same content returns the original, different content → 409 |
| Subledger dimensions | Accounts with a `subledger` require `party_type/party_id` on every line (e.g. 2200 needs a CREATOR) |
| Client liabilities never commingle with revenue | Liabilities flagged `is_client_liability`; pools post to payables (2200/2210), held (2400) or platform revenue (4000/4010/4020/4100) explicitly |
| Dual control | Manual entries and reversals: requester ≠ approver (DB `CHECK` and API). Rule versions: two approvers, neither the drafter |
| Allocations never exceed the funded net pool | `splitParties` + `allocatePool` reconcile exactly (property-tested); batch `CHECK net = gross − tax − adjustments − deductions` |

## 2. Chart of accounts (migration 0003)

| Code | Account | Type | Subledger | Client liability |
|---|---|---|---|---|
| 1000 | Cash – operating bank | Asset | | |
| 1010 | Payment processor clearing | Asset | (processor on line) | |
| 1100 | Accounts receivable – advertisers | Asset | ADVERTISER | |
| 1200 | Recipient clawback receivable | Asset | CREATOR/DRIVER | |
| 2000 | Advertiser prepaid balances | Liability | ADVERTISER | ✔ |
| 2100 | Sales tax payable | Liability | | ✔ |
| 2200 | Creator earnings payable | Liability | CREATOR | ✔ |
| 2210 | Driver earnings payable | Liability | DRIVER | ✔ |
| 2300 | Rewards and coupon liability | Liability | ADVERTISER | ✔ |
| 2400 | Held undistributed pools | Liability | | ✔ |
| 2500 | Payouts in transit | Liability | CREATOR/DRIVER | ✔ |
| 2600 | Refunds payable | Liability | ADVERTISER | ✔ |
| 2700 | Reserves | Liability | | |
| 3000 / 3100 | Owner contributions / Retained earnings | Equity | | |
| 4000 | Platform advertising revenue share | Revenue | | |
| 4010 | Platform share of unallocated party shares | Revenue | | |
| 4020 | Rounding residual | Revenue | | |
| 4100 | Platform sales-commission revenue share | Revenue | | |
| 4200 | Driver subscription revenue | Revenue | DRIVER | |
| 5000 / 5001 | Processing fees / fees recovered from pools (contra) | Expense | | |
| 5100 / 5101 | Direct campaign costs / recovered from pools (contra) | Expense | | |
| 5200 | Chargeback losses | Expense | | |
| 5900 | G&A overhead (never deducted from pools) | Expense | | |

Presentation (gross vs. net, principal vs. agent) is **DECISION REQUIRED (D-011)**. The ledger keeps gross detail so either presentation can be reported.

## 3. Net waterfall (`finance-core/src/waterfall.ts`)

```
gross receipts
 − taxes collected for governments        (→ 2100, never revenue)
 − refunds − credits − chargebacks
 − permitted, disclosed, contract-cited deductions   (only PAYMENT_PROCESSING_FEE, DIRECT_CAMPAIGN_COST,
                                                      and only if the governing rule version permits them)
 = NET distributable
```
- `CORPORATE_INCOME_TAX`, `PERSONAL_INCOME_TAX` and `GENERAL_OVERHEAD` are rejected outright.
- Every deduction must cite a `contractRef`.
- Net > 0 → `DISTRIBUTABLE`. Net = 0 → `NO_DISTRIBUTION`. Net < 0 → `REVIEW_NEGATIVE_NET`, which posts nothing and is queued for finance review.

## 4. Splits (versioned in `revenue_rule_versions`)

| Category | Driver | Creator | Platform |
|---|---:|---:|---:|
| CREATOR_CONTENT_AD | 500 bps | 6000 | 3500 |
| STANDALONE_AD | 500 | 0 | 9500 |
| SALES_COMMISSION_WITH_CREATOR | 1500 | 1000 | 7500 |
| SALES_COMMISSION_NO_CREATOR | 1500 | 0 | 8500 |

- Category is derived from whether an **eligible** creator is attributed; eligibility comes from the database, never from the caller.
- No approved rule effective at `period_end` → the batch is refused (no silent fallback).
- **Party rounding** (`RESIDUAL_TO_PLATFORM_V1`, D-007): driver, creator and platform shares are each `floor(net × bps / 10000)`; the residual (0–2 minor units) is credited to **4020**.
- **No eligible driver/creator** (D-009): the share follows the rule's policy, `TO_PLATFORM` → 4010 or `HOLD` → 2400.

### Pool distribution (`finance-core/src/pools.ts`)
- Creator pool weights v1: revenue 50%, verified watch-seconds 30%, qualified views 20%.
- Driver pool weights v1: monetized ad delivery 50%, qualified engagement 25%, eligible active seconds 25%.
- Scores are exact rationals with integer numerators over a common denominator. Payouts use largest remainder with an ascending-ID tie-break, so they sum **exactly** to the pool.
- Zero denominators: drop the component and renormalize the rest (`REWEIGHT_NONZERO_V1`, D-008). All zero → pool **held** in 2400.

## 5. Journal examples (USD, minor units shown as dollars)

### 5.1 Advertiser prepays $1,082.50 including $82.50 sales tax (if taxable, see D-016)
| Account | Dr | Cr |
|---|---:|---:|
| 1010 Processor clearing (stripe) | 1,082.50 | |
| 2000 Advertiser prepaid [Main St Coffee] | | 1,000.00 |
| 2100 Sales tax payable | | 82.50 |

Processor fee charged ($29.30): Dr 5000 29.30 / Cr 1010 29.30.

### 5.2 Creator-content ad allocation (exact figures from `revenue.test.ts`)
Earned spend $1,000.00 from prepaid; permitted processing-fee deduction $29.30 (contract ADV-MSA-v1 §4.2). **Net = $970.70.**

- Driver 5% = floor(4,853.5¢) = $48.53 · Creator 60% = $582.42 · Platform 35% = floor(33,974.5¢) = $339.74 · Residual = $0.01
- Creator pool $582.42 → A: score .605 → $352.36; B: score .395 → $230.06 (largest remainder gives B the extra cent)
- Driver pool $48.53 → D1 (.5625) $27.30; D2 (.4375) $21.23; D3 is `PENDING` and receives nothing

| Account | Dr | Cr |
|---|---:|---:|
| 2000 Advertiser prepaid [advertiser] | 1,000.00 | |
| 5001 Processing fees recovered from pools | | 29.30 |
| 2210 Driver payable [D1] | | 27.30 |
| 2210 Driver payable [D2] | | 21.23 |
| 2200 Creator payable [A] | | 352.36 |
| 2200 Creator payable [B] | | 230.06 |
| 4000 Platform ad revenue share | | 339.74 |
| 4020 Rounding residual | | 0.01 |
| **Total** | **1,000.00** | **1,000.00** |

### 5.3 Standalone commercial with no eligible driver, net $100.00
Dr 2000 100.00 / Cr 4000 95.00 / Cr 4010 5.00 (unallocated driver share → platform per signed terms).

### 5.4 Advertiser-funded sales commission with creator, net $20.00 (from receivable)
Dr 1100 20.00 / Cr 2210 3.00 / Cr 2200 2.00 / Cr 4100 15.00.

### 5.5 Driver $30 subscription (Phase 3; never enters any pool)
Dr 1010 30.00 / Cr 4200 Driver subscription revenue [driver] 30.00, then the fee: Dr 5000 / Cr 1010.

### 5.6 Refund, chargeback or credit after allocation (implemented, D-021, D-030)
`POST /v1/finance/allocations/:id/reversal-requests` → a different approver decides via `/v1/finance/journal-requests/:id/decision`.
The amount is spread over **every** allocation line of the batch (payables, platform, held, rounding and deduction recoveries) in proportion to what each line has left un-reversed, using largest remainder. A line can never be reversed beyond its original amount: this is checked in code and by a DB trigger.

Example: a $100.00 refund of the §5.2 batch reverses exactly 10% of each line (A: 35,236¢ → 3,524¢ after rounding):

| Account | Dr | Cr |
|---|---:|---:|
| 5001 fees recovered (platform absorbs the unrefunded fee) | 2.93 | |
| 2210 Driver payable [D1] / [D2] | 2.73 / 2.12 | |
| 2200 Creator payable [A] / [B] | 35.24 / 23.01 | |
| 4000 Platform share | 33.97 | |
| **2600 Refunds payable [advertiser]** (REFUND) · **1010 Processor clearing** (CHARGEBACK) · **funding account 2000/1100** (CREDIT) | | 100.00 |

Shares already **PAID** are debited to **1200 Recipient clawback receivable** [recipient] instead of the payable. Paying the refund to the advertiser is a separate cash entry (Dr 2600 / Cr 1010).
Generic journal reversal of an allocation entry is refused, so per-recipient tracking can't be bypassed.

### 5.7 Payout of $352.36 to creator A (Phase 4)
Submit: Dr 2200 [A] / Cr 2500 [A]. Provider confirms: Dr 2500 / Cr 1000. Provider fails: Dr 2500 / Cr 2200 (restores payable). A payout can never exceed the approved payable balance (to be enforced with a row lock on the recipient's balance, like D-015).

### 5.8 Held pool released
When the hold reason clears, Dr 2400 / Cr payables per the rule version in force when the pool was funded. If the hold is forfeited under signed terms, Cr 4010 instead (requires dual approval).

## 6. Settlement lifecycle
`allocation_lines.status`: PENDING → APPROVED → PAYABLE → PAID (or HELD / REVERSED). Amounts and parties are immutable (trigger); only the status advances. The ledger remains authoritative for balances.

## 7. Reconciliation (Phase 3)
- Daily: processor balance and payouts reports vs. 1010/2500, by processor and currency.
- Per webhook: inbox row (signature verified, unique event id) → idempotent posting key `stripe:<event_id>`.
- Exceptions table with owner and resolution, and a period-close checklist: trial balance balanced, no pending journal requests in the period (enforced), reconciliation exceptions cleared.
