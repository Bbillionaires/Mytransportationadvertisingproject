# Business portal

`apps/portal` is the web portal for business users at `/portal/`. It is built in stages. **Fleet operators come first** (session 15). Advertiser, creator, driver and staff sections follow; until then those users see a placeholder, and staff keep using `/admin/`.

> Status: tested end to end in a real browser against the real API and database. Not yet used by a real fleet.

## Sign-in and accounts
- Email and password; two-step verification (TOTP) when enabled, with self-service setup under **Security**.
- The session token is kept in `sessionStorage`, so it is gone when the tab closes. A 401 response clears the session.
- One-time email links now open the portal (`/portal/?verify=…`, `?reset=…`, `?invite=…`): email confirmation, password reset and invitation acceptance.
- Users in several organizations switch between them in the header. Sections are shown according to the user's role permissions. The API enforces every permission; the UI only hides what a role cannot do.

## Fleet operator sections
| Section | What it does | Permission |
|---|---|---|
| Overview | Tablets playing, offline (no check-in for 10 min), suspended, unassigned, vehicle count; "needs attention" list (offline, unassigned, suspended, under 1 GB free) | `device.read` |
| Tablets | Status, last check-in, vehicle, Android app vs web player, waiting commands. Actions: assign/move, unassign, refresh, suspend (confirmed), resume, clear rider, details (rename, command history, retire with reason) | `device.read` / `device.manage` / `device.command` |
| Add a tablet | Install instructions; one-time enrollment code (30 min, 2 h or 24 h), shown once; recent codes with revoke | `device.manage` |
| Vehicles & fleets | Add fleets (market, time zone) and vehicles; which tablet is in each vehicle | `fleet.read` / `fleet.manage` |
| Drivers | Drivers and earnings eligibility (set by platform staff; no earnings guarantee) | `fleet.read` |
| Team | Invite fleet admins, viewers and drivers by email; revoke pending invitations | `org.members.manage` |

The tablets list refreshes every 30 seconds while visible. Every change is written to the audit log.

## Security notes
- Strict CSP: scripts and styles from the same origin only, no inline script, no framing.
- All server text is rendered with `textContent`. There is no HTML injection path.
- Retiring a tablet invalidates its key immediately (signed requests return 401), ends its assignment and rider session, and expires its pending commands.
- Enrollment codes are stored hashed; the list endpoint never returns a code.

## Testing
`npm run e2e -w @rmn/portal` does the following in Chromium:
- signs in a fleet admin
- adds a fleet and a vehicle
- creates a code, then enrolls a real web-player tablet with it
- assigns the tablet, then suspends and resumes it (the tablet reacts each time)
- renames it and checks its history
- invites a viewer, who accepts on a phone-sized screen and sees no management actions
- turns on two-step verification and signs in with a code
- retires the tablet, checks the audit log, and resets the password from the email link

Screenshots are saved in `/tmp` as `portal-*.png`.
