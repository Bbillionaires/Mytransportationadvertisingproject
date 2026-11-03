# Entity-Relationship Design

## Implemented (migrations 0001–0004)

```mermaid
erDiagram
  organizations ||--o{ memberships : has
  users ||--o{ memberships : holds
  roles ||--o{ memberships : grants
  roles ||--o{ role_permissions : ""
  permissions ||--o{ role_permissions : ""
  users ||--o{ sessions : ""
  organizations ||--o{ fleets : owns
  fleets ||--o{ vehicles : ""
  fleets ||--o{ drivers : ""
  users ||--o| drivers : "is"
  organizations ||--o{ devices : owns
  devices ||--o{ device_assignments : ""
  vehicles ||--o{ device_assignments : ""
  drivers ||--o{ device_assignments : ""
  devices ||--o{ device_commands : ""
  devices ||--o{ device_heartbeats : ""
  devices ||--o{ device_nonces : ""
  organizations ||--o{ device_enrollment_codes : ""
  organizations ||--o{ creator_profiles : ""
  ledger_accounts ||--o{ journal_lines : ""
  journal_entries ||--|{ journal_lines : "balanced"
  journal_entries |o--o| journal_entries : "reverses"
  journal_requests }o--o| journal_entries : "approved into"
  accounting_periods ||..o{ journal_entries : "date within OPEN"
  revenue_rule_versions ||--o{ allocation_batches : "governs"
  allocation_batches ||--o| journal_entries : "posted as"
  allocation_batches ||--o{ allocation_lines : ""
```

### Key constraints
- **Tenant scoping:** `fleets`, `vehicles`, `drivers`, `devices` and `device_assignments` use composite `(id, org_id)` keys and composite FKs, so a row can never reference another tenant's row.
- `memberships`: the role's `org_kind` must match the organization's kind (trigger).
- `device_assignments`: GiST exclusion prevents overlapping assignments per device **and** per vehicle.
- `journal_lines`: exactly one of debit/credit > 0; party columns both present or both null.
- `journal_entries.reverses_entry_id UNIQUE`; `source_type = 'REVERSAL'` ⇔ `reverses_entry_id` present.
- `accounting_periods`: non-overlapping date ranges (GiST exclusion).
- `revenue_rule_versions`: bps sum to 10000; no creator share on no-creator categories; approver1 ≠ approver2 ≠ drafter; non-draft versions cannot overlap per category (GiST exclusion).
- `allocation_batches`: `net = gross − tax − refunds − credits − chargebacks − deductions`; POSTED ⇔ journal entry present.

### Retention (proposed defaults; DECISION REQUIRED with counsel)
| Data | Retention |
|---|---|
| Ledger, allocations, rules, audit log | ≥ 7 years, immutable |
| `device_nonces` | 1 day (purge job, Phase 1 remainder) |
| `device_heartbeats` | 90 days raw, then daily aggregates |
| Sessions | 90 days after expiry |
| Rider session data on tablet | purged at session end |
| Precise location | not stored server-side by default (Phase 5) |

## Planned entities by phase
- **Phase 2:** channels, videos, video_versions, licenses/attestations, moderation_cases, moderation_decisions, playlists, playlist_items, advertisers (profile on org), campaigns, creatives, schedules, geo_targets, budgets, raw_events (event store), validated_events, analytics_aggregates.
- **Phase 3:** subscriptions, invoices, payments, refunds, chargebacks, webhook_inbox, webhook_outbox, reconciliation_runs, reconciliation_exceptions, tax_records.
- **Phase 4:** commission_agreements, click_events, conversions, commission_events, attribution_decisions, payout_accounts (provider refs only, no bank data), payout_batches, payout_records, disputes.
- **Phase 5:** rider_accounts, rider_sessions, qr_login_tokens, coupons, coupon_claims, redemptions, geofences, geofence_triggers, games, game_sessions, rewards, reward_liabilities.
- **Phase 6:** integration_clients (scoped keys/OAuth), module_registry, white-label themes.
