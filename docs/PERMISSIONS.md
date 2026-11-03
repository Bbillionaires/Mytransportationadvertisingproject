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
| events.review | ✔ | ✔ | | ✔ | | | | | | |

¹ Separation of duties applies to everyone, super admins included: nobody can approve their own journal request, rules need two approvers who are not the drafter, and DB `CHECK` constraints back this up.

**Scoping rules** (`auth/context.ts#authorize`):
- A platform-scope permission is granted only through a PLATFORM-org membership.
- An org-scope permission is granted through a membership in that exact org, or through a PLATFORM membership (cross-tenant staff access, always audited).
- Tenant admins can create new users in their org but cannot attach users who already exist elsewhere (prevents account discovery).
- Only platform staff can mark a driver `ELIGIBLE` for earnings.

**Planned roles:** `advertiser_member` (read-only campaigns), `moderator`, `payout_operator`, `tax_reviewer`, `rider` (separate rider identity, not an org membership).
