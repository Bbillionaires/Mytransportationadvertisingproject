# Business portal

`apps/portal` is the web portal for business users at `/portal/`. It now covers every business user: **fleet operators** (session 15), **advertisers** (session 16), **creators** (session 17), **platform staff** (session 18) and **drivers** (session 19). The old `/admin/` console is retired; its address redirects to the portal.

> Status: tested end to end in a real browser against the real API and database. Not yet used by a real fleet.

## Sign-in and accounts
- **Self-service sign-up** for creators and advertisers ("Create an account"): they confirm their email from a link, then sign in. Fleet operators, drivers and staff join only by invitation.
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

## Advertiser sections
| Section | What it does | Permission |
|---|---|---|
| Overview | Available balance, campaigns running, impressions / qualified views / taps (last 7 days), to-do list (empty balance, drafts, campaigns needing changes) | `campaign.read` |
| Campaigns | List with status, dates, price and budget. **New campaign**: name, category (restricted categories refused), pay per qualified view or per 1,000 impressions, price, dates, total/daily budget, markets, landing page, schedule (days, hours, time zone), skip delay, frequency cap | `campaign.read` / `campaign.manage` |
| Campaign page | Status and reviewer's note; edit drafts and rejected campaigns; submit, pause, resume, end (confirmed). Spend, today's spend and remaining budget; delivery status in plain language (e.g. "prepaid balance is used up"); results for the last 7 days and since start (impressions, qualified and completed views, taps, tap rate, seconds watched; validated plays only) | `campaign.read` / `campaign.manage` |
| Ads | Upload video or image ads with a progress bar. The upload is resumable and chunked, with SHA-256 checked by the server; ffmpeg probes and transcodes it, and the duration comes from the file, not the advertiser. Text banners can also be added. Every ad shows its review status and note | `media.upload` / `campaign.manage` |
| Coupons & commissions | Percent or fixed commission offers with a rider-facing coupon description and validity window; end an offer | `campaign.manage` |
| Location alerts | Place, message, latitude/longitude, radius; shows how many alerts were shown, opened and claimed; pause/resume | `campaign.manage` |
| Game rewards | Sponsor a reward for a skill game (minimum score, quantity, face value, dates). Shows given away, redeemed and outstanding obligation; end a program | `campaign.read` / `campaign.manage` |
| Billing | Available, prepaid, delivered-not-yet-billed and commissions owed; **Add funds** ($10–$100,000) through hosted checkout (simulated in development, see PAYMENTS.md); receipts | `campaign.read` / `billing.manage` |
| Sales tracking | How sales are credited (a coupon beats a tap; sales with neither are recorded but not credited). Integration keys (report sales and/or redeem game rewards), with the full key shown once, last-used time and revoke. Developer quick start with a ready-to-run example. Reported sales with how each was credited, sale, refunds, commission and status, plus a CSV download | `campaign.read` / `integrations.manage` |
| Campaign report | **Download daily report (CSV)** on each campaign: impressions, qualified and completed views, taps, billable plays, spend (exact milli-cent amount included) and rejected events per day, in the campaign's time zone | `campaign.read` |
| Team | Invite advertiser admins and read-only members | `org.members.manage` |

Read-only members see results and balances but no management actions and no billing documents.

## Creator sections
| Section | What it does | Permission |
|---|---|---|
| Overview | Channel and monetization status in plain words ("Not yet earning" until staff confirm eligibility); videos live and in review; qualified views and watch hours (30 days); allocated earnings; to-do list (rejected videos, copyright notices, failed processing); earnings disclosure | `creator.read` |
| Videos | Thumbnails, duration, status (processing, in review, live, not approved, removed); rejection reasons and reviewer note; appeal status; copyright notice details and restoration date | `creator.read` |
| Upload a video | File, title, description. All four parts of the rights statement are required (`RIGHTS_ATTESTATION_V1`, stored with the video). Resumable upload with progress; the video is submitted immediately and moves from processing to review on its own | `creator.manage` + `media.upload` |
| Appeal | One appeal per decision (at least 20 characters), decided by a different reviewer | `creator.manage` |
| Counter-notice | Sworn statement, good-faith and jurisdiction confirmations, and a signature; shows when restoration becomes possible (10 business days) | `creator.manage` |
| Performance | Per-video qualified views, watch hours, ad revenue billed alongside (not earnings), taps and sales, over 7/30/90 days | `creator.read` |
| Earnings | Earned (allocated), balance owed, indicative estimate, reversals; by source; allocation lines; monthly ledger statements as PDF or CSV. Disclosure: earnings are not guaranteed. Payouts are not enabled | `creator.read` |
| Team | Invite co-owners | `org.members.manage` |

## Staff sections (platform organization)
Every staff permission requires a two-step-verified session. A staff member without it sees a "Two-step verification required" card and a link to set it up.

| Section | What it does | Permission |
|---|---|---|
| Overview | Counts for each queue the role can work (ads, videos, appeals, copyright notices, eligibility, journal requests, rules), linking to the queue | per queue |
| Ad review | Each submitted campaign with its terms, markets and landing page. Each ad is shown as riders will see it (video player or image through a signed 30-minute link, or banner text), with the AI pre-screen marked as advisory. Approve or reject each ad (with a note), then approve or reject the campaign. New ads on running campaigns are decided one by one | `campaign.review` |
| Video moderation | Video player, title, description and channel; AI pre-screen marked advisory; approve, or reject with at least one policy reason and a note. Appeals show the creator's statement and the original reasons, and are overturned or upheld (by a different reviewer — enforced by the API) | `content.review` |
| Copyright notices | Claim, claimant, counter-notice and the creator's open-notice count. Uphold, withdraw, or restore (only after a counter-notice and the 10-business-day wait) | `takedown.manage` |
| Earnings eligibility | Creators (videos live, open notices) and drivers (fleet, subscription status). Set eligible, pending, suspended or terminated, with a reason that is audited. Staff cannot decide for their own organization | `platform.eligibility.manage` (new; super admin) |
| Finance | Journal requests awaiting approval (approver role only; the requester can never approve their own), revenue rules awaiting their two approvals, a trial balance check, and CSV reports | `finance.read` / `finance.journal.approve` / `finance.rules.approve` |
| Organizations | Every organization, with type, status and creation date | platform membership |
| Audit log | The latest 200 entries, filterable by action | `platform.audit.read` |

The site root `/` and the old `/admin/` address both open the portal.

## Driver sections (drivers are members of a fleet operator)
| Section | What it does | Permission |
|---|---|---|
| My earnings | Disclosure ("Earnings are not guaranteed…"); eligibility status and what it depends on; earned, balance owed, indicative estimate, sales from their tablet; the tablet in their vehicle with online status; earnings by source and lines; monthly ledger statements (PDF/CSV) | `driver.self.read` |
| Subscription | $30/month participation subscription. The disclosure must be accepted before checkout (simulated in development). Status (active, payment failed, ends at period end), renewal or end date, receipts. Cancellation: no further charges, access until the end of the paid period | `driver.subscription.manage` |

A driver who has accepted an invitation but has not been added to a fleet sees an explanation instead. Fleet admins add accepted drivers to a fleet on **Drivers** ("Accepted invitations — add to a fleet").

## Security notes
- Strict CSP: scripts and styles from the same origin only, no inline script, no framing.
- All server text is rendered with `textContent`. There is no HTML injection path.
- Retiring a tablet invalidates its key immediately (signed requests return 401), ends its assignment and rider session, and expires its pending commands.
- Enrollment codes are stored hashed; the list endpoint never returns a code.

## Testing (advertiser)
`apps/portal/e2e/advertiser.e2e.ts` runs against the real API, PostgreSQL and ffmpeg. It:
- adds $250 through the simulated checkout, then checks the balance and receipt
- creates a draft campaign; submitting it with no ads is refused
- uploads a real 8-second video (processed by ffmpeg) and adds a banner, an offer and a location alert
- submits the campaign; a reviewer rejects it with a note; the advertiser edits and resubmits; the reviewer approves it
- has a real web-player tablet in the market play the ad, then checks that validated results and spend appear on the campaign page
- pauses and resumes the campaign, and sponsors a trivia reward
- signs in a read-only member on a phone-sized screen and confirms they cannot change anything
- downloads the daily report and checks that its spend matches the portal
- creates an integration key, reports a sale with it, sees the sale listed as "not credited" (no coupon or tap), downloads the CSV, then revokes the key and checks that it stops working
- checks that every action was audited

## Testing (creator)
`apps/portal/e2e/creator.e2e.ts`:
- signs up in the portal (a short password is blocked) and confirms the email from the link
- uploads a real video; it cannot be submitted without the rights statement, and the stored attestation is checked
- the reviewer rejects it with a reason; the creator sees the reason and appeals (only once)
- a second video is approved and goes live with a thumbnail
- a copyright notice removes it; the creator sends a sworn counter-notice
- opens the performance and earnings pages and downloads a real PDF statement
- shows "Earning" once eligibility is set

Not covered by this test: earnings with allocation lines. They are covered by `reports.test.ts`, because producing them in a browser test needs the whole delivery and allocation pipeline. Monetization eligibility is set directly in the test because there is no staff screen or endpoint for it yet.

## Testing (staff)
`apps/portal/e2e/staff.e2e.ts`: every staff member signs in with real TOTP codes. It checks that:
- a moderator without two-step verification is blocked until they set it up
- the reviewer can load the signed ad video preview; they approve the video ad, reject the banner with a note, and approve the campaign
- one video is approved; a rejection without a policy reason is refused; another video is then rejected with a reason
- an appeal on a different reviewer's rejection is overturned
- a copyright notice is upheld
- a super admin marks a creator and a driver eligible with reasons, and the audit log shows it
- the finance admin who requested a journal entry sees no approve button; a separate approver posts it, the trial balance stays balanced, and the advertiser is credited

## Testing (driver)
`apps/portal/e2e/driver.e2e.ts` covers the following on a phone-sized screen:
- the retired `/admin/` address redirects to the portal
- a fleet admin invites a driver, who accepts from the email link
- before being added to a fleet, the driver sees an explanation instead
- the fleet admin adds the driver to a fleet and assigns the tablet with the driver
- the driver sees the disclosure, their eligibility and their tablet
- subscribing is blocked until the disclosure is accepted; the simulated checkout makes the subscription ACTIVE, issues a receipt, and books $30 to account 4200 (outside the revenue pools)
- the driver cancels transparently and downloads a PDF statement

## Testing (fleet)
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
