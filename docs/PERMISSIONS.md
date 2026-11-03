# Permissions Matrix

The source of truth is the `role_permissions` table (migration 0001); this table mirrors it. **MFA** marks permissions that need an MFA-verified session and that are unavailable during support impersonation.

| Permission | MFA | super_admin | finance_admin | finance_approver | support_agent | fleet_admin | fleet_viewer | driver | advertiser_admin | creator_owner |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| platform.orgs.manage | ✔ | ✔ | | | | | | | | |
| platform.users.manage | ✔ | ✔ | | | | | | | | |
| platform.audit.read | ✔ | ✔ | | | | | | | | |
| support.impersonate | ✔ | ✔ | | | ✔ | | | | | |
| org.members.manage | | ✔ | | | | ✔ own | | | ✔ own | ✔ own |
| fleet.read | | ✔ | | | ✔ | ✔ own | ✔ own | | | |
| fleet.manage | | ✔ | | | | ✔ own | | | | |
| device.read | | ✔ | | | ✔ | ✔ own | ✔ own | | | |
| device.manage | | ✔ | | | | ✔ own | | | | |
| device.command | | ✔ | | | | ✔ own | | | | |
| finance.read | ✔ | ✔ | ✔ | ✔ | | | | | | |
| finance.journal.request | ✔ | ✔ | ✔ | | | | | | | |
| finance.journal.approve | ✔ | ✔¹ | | ✔ | | | | | | |
| finance.period.manage | ✔ | ✔ | | ✔ | | | | | | |
| finance.rules.draft | ✔ | ✔ | ✔ | | | | | | | |
| finance.rules.approve | ✔ | ✔¹ | | ✔ | | | | | | |
| finance.allocation.post | ✔ | ✔ | ✔ | | | | | | | |
| driver.self.read | | | | | | | | ✔ | | |
| events.validate | ✔ | ✔ | ✔ | | | | | | | |
| campaign.read | | ✔ | | | | | | | ✔ own (+ advertiser_member) | |
| campaign.manage | | ✔ | | | | | | | ✔ own | |
| campaign.review | ✔ | ✔ | | | | | | | | |
| media.upload | | ✔ | | | | | | | ✔ own | ✔ own |
| creator.read / creator.manage | | ✔ | | | | | | | | ✔ own |
| content.review | ✔ | ✔ | | | | | | | | |
| takedown.manage | ✔ | ✔ | | | | | | | | |
| billing.manage | | ✔ | | | | | | | ✔ own | |
| driver.subscription.manage | | | | | | | | ✔ own | | |
| finance.reconcile | ✔ | ✔ | ✔ | ✔ | | | | | | |
| integrations.manage | | ✔ | | | | | | | ✔ own | |
| events.review | ✔ | ✔ | | ✔ | | | | | | |

¹ Separation of duties applies to everyone, super admins included: nobody can approve their own journal request, rules need two approvers who are not the drafter, and DB `CHECK` constraints back this up.

**Scoping rules** (`auth/context.ts#authorize`):
- A platform-scope permission is granted only through a PLATFORM-org membership.
- An org-scope permission is granted through a membership in that exact org, or through a PLATFORM membership (cross-tenant staff access, always audited).
- Tenant admins can create new users in their org but cannot attach users who already exist elsewhere (prevents account discovery).
- Only platform staff can mark a driver `ELIGIBLE` for earnings.

**Platform `moderator` role** (sessions 4–5): `campaign.review`, `campaign.read`, `content.review`, `takedown.manage`, `creator.read`. A reviewer cannot approve campaigns of an organization they belong to.

**Planned roles:** `payout_operator`, `tax_reviewer`, `rider` (separate rider identity, not an org membership).
