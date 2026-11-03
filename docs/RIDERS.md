# Rider Engagement (Phase 5)

Guests can watch, tap ads and claim public coupons with no account. A free rider account (adults only, D-018) adds a wallet, games with sponsor rewards, and sign-in on any tablet by QR code.

## Rider accounts (personal phone)
| Endpoint | Notes |
|---|---|
| `POST /v1/riders/register` | `{email, password, displayName, birthYear, confirmAdult: true, termsVersion: RIDER_TERMS_V1, marketingOptIn}`. Under-18 → 422 (guest mode needs no account). Always 202 otherwise (no enumeration). Only the birth year is stored. |
| `POST /v1/riders/verify-email`, `POST /v1/riders/login` (→ `rdr_…`, 30 days), `POST /v1/riders/logout`, `GET /v1/riders/me` | Rider identities are separate from staff/business users; rider tokens are not accepted by staff endpoints. |
| `GET /v1/riders/me/wallet` | coupons saved on tablets + reward codes |
| `POST /v1/riders/me/delete {password}` | erases email, password, name and birth year; ends every session; codes stay valid for merchants but no longer identify anyone |

## QR sign-in on a tablet
1. Tablet: `POST /v1/devices/rider-pairings` (signed) → `RMNPAIR:XXXXXXXX`, valid **2 minutes**.
2. Phone: `POST /v1/riders/pair {code}` (verified email required). This ends any previous rider session on that tablet.
3. Tablet: `GET /v1/devices/rider-pairings/:id` → the `rts_…` session token, delivered **once**, then erased from the server.
4. The tablet sends `X-Rider-Session` together with its device signature. The token works **only on that tablet**, expires after **30 minutes**, and ends on `POST /v1/devices/rider-sessions/end` (drop-off), on the `PURGE_RIDER_DATA` or `SUSPEND` device command, or when a new rider pairs. The tablet must also purge its local rider cache (spec invariant 11).

## Proximity alerts (PROXIMITY_POLICY_V1)
- Advertisers register fences per campaign: name, message (family-friendly text screen), centre, radius 50–2000 m, daily cap per tablet, cooldown.
- The tablet posts its position to `POST /v1/devices/proximity`. Coordinates are used in memory only: they are **never stored or logged**, and only `(tablet, fence, time, outcome)` is recorded, which is enough for cooldowns and reporting. No rider is linked, so there is no trip history.
- An alert is shown only if the campaign is live, in schedule, in market and funded, and the vehicle is under 25 m/s. Pacing rules:
  - at most one alert per tablet every 10 minutes;
  - a per-fence cooldown and daily cap;
  - 50% random pacing.
- Alerts are silent (`sound: false`), passenger-only, say "Near your route", and expire after 60 s, so they never imply the business is still nearby (R-005).
- Outcomes: `POST /v1/devices/proximity/alerts/:id/outcome` (SHOWN/OPENED/CLAIMED/DISMISSED/EXPIRED). Advertisers see per-fence stats.

## Games and rewards (GAME_POLICY_V1)
- Seeded skill games: Memory Match, Picture Pairs, Slide Puzzle, City Trivia. **Chance-based games cannot exist in the database without a legal approval reference** (D-019). There is never a purchase or payment.
- Session duration is measured by the server. Trivia is scored by the server (answers never sent to the tablet). Implausible results (too fast, above the game maximum) are rejected.
- Guests can play; only a signed-in rider who started the session can earn a reward.
- Sponsor reward programs (`POST /v1/orgs/:orgId/reward-programs`) set a non-cash reward, face value, quantity, minimum score, per-rider daily cap, validity and dates. Codes are single-use, and the sponsor's point of sale redeems them with an API key scoped `rewards:redeem` (`POST /v1/rewards/redeem`).
- Outstanding obligations (issued − redeemed − expired) × face value are reported per program. These are the sponsor's own non-cash promotions, so they create no platform ledger liability. Account 2300 is reserved for platform-held reward funds (D-046).
