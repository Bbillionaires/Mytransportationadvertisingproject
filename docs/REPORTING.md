# Earnings Dashboards, Statements and Financial Reports (M4.4, M3.6)

All figures come from the ledger and the immutable allocation records; nothing is recomputed.

## Creator and driver dashboards
| Endpoint | Auth | Contents |
|---|---|---|
| `GET /v1/orgs/:orgId/earnings?from&to[&format=csv]` | `creator.read` | summary (earned, refund/chargeback reductions, net, by category, balance owed, owed back, paid out, pending/approved/paid) + drill-down per allocation line: batch gross → deductions → net → rule split → pool score basis → share → reversed |
| `GET /v1/orgs/:orgId/videos/performance?sort=qualifiedViews\|watchHours\|monetizedRevenue\|clicks\|conversions` | `creator.read` | per-video ranking with approval status |
| `GET /v1/drivers/me/earnings` | `driver.self.read` | same summary and drill-down, plus assigned tablets and their health, subscription, eligibility, attributed conversions |
| `GET /v1/orgs/:orgId/statements/:yyyy-mm?format=json\|csv\|pdf` and `GET /v1/drivers/me/statements/:yyyy-mm` | as above | opening balance owed + earnings − reductions − payouts = closing; owed-back balance |
| `GET /v1/finance/statements/:CREATOR\|DRIVER/:id/:yyyy-mm` | `finance.read` | any recipient's statement |

**Estimates** are labelled `indicativeOnly`: they are valid, unbilled delivery and unallocated attributed commissions, multiplied by the party's rule share, before deductions and pool sharing. Every response carries the "earnings are not guaranteed" disclosure.

## Financial reports (`finance.read`, MFA; all support `?format=csv`)
| Report | Path | Notes |
|---|---|---|
| General ledger | `/v1/finance/reports/general-ledger?from&to&account` | running balance per account, starting from the true opening balance |
| Income statement | `/v1/finance/reports/income-statement?from&to` | contra-expense recoveries reduce expenses; recipient shares are presented net (D-011 pending) |
| Balance sheet | `/v1/finance/reports/balance-sheet?asOf` | current unclosed earnings shown in equity; `balanced` asserts A = L + E; client-fund liabilities totalled separately |
| Cash flow (direct) | `/v1/finance/reports/cash-flow?from&to` | movements of 1000 and 1010 by source; internal clearing → bank transfers excluded |
| Liabilities | `/v1/finance/reports/liabilities?asOf` | by account and party |
| Receivables | `/v1/finance/reports/receivables?asOf` | advertiser 1100 balances with age bucket of the oldest open item |
| Recipient earnings | `/v1/finance/reports/recipient-earnings?year` | annual allocated earnings per creator/driver, to prepare information returns; payment-based reporting follows payouts |
| Trial balance | `/v1/finance/trial-balance` | (existing) |

CSV cells beginning with `= + - @` (except plain numbers) are prefixed with `'` to prevent spreadsheet formula injection. PDFs are produced by a small built-in writer (Helvetica; non-ASCII characters replaced with `?`).
