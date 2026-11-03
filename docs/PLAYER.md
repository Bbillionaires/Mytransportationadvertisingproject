# Passenger Tablet Player (web) — `apps/player`

The tablet experience as a web app. It runs in any modern browser (demos, pilots, non-Android screens) and will be wrapped by the Android kiosk shell (next milestone) for production tablets. It is served by the API at **`/player/`**.

```bash
npm run build:player        # bundle to apps/player/dist (esbuild)
npm run dev                 # builds the player, starts the API → http://127.0.0.1:8080/player/
npm run e2e                 # real Chromium + real API/DB/ffmpeg end-to-end ride (uses database rmn_e2e)
```

## What it does
| Area | Behaviour |
|---|---|
| Enrollment | One-time code from the fleet admin. The browser generates an **Ed25519 key pair with a non-extractable private key**, kept in IndexedDB (the Android shell will use a hardware-backed Keystore key). Every request is signed exactly as the server verifies; the clock offset is learned from the server `Date` header. |
| Playback | Creator content; an ad break (video or display ad, priority-ordered, local frequency cap) after each item; word/text banners rotating over content; "Next" for content; skip countdown per campaign; expired signed media is never used; the last playlist is kept for brief offline periods. |
| Measurement | Visible time counts only while media is playing **and** the page is visible; muted time is tracked separately. Each item produces a CONTENT_PLAYBACK or AD_PLAYBACK event; ACTIVE_SEGMENT events carry interaction counts for anti-idle checks. |
| Offline | Events are written to an IndexedDB queue first and uploaded in signed batches; the server deduplicates retries. |
| Ad taps | A CLICK event; a QR code (with the `rmn_click` id) opens the offer on the passenger's own phone. "Open on this screen" shows it in a sandboxed frame with an always-visible "Back to ride". |
| Coupons | One tap; the code and QR are shown, saved to the wallet when a rider is signed in. |
| Rider sign-in | QR/code pairing; the session token is kept **in memory only** and is cleared on sign-out, expiry, or the `PURGE_RIDER_DATA` command. |
| Games | City Trivia (server-scored) and Memory Match; sponsor rewards for signed-in riders. |
| Proximity | Browser geolocation → `/v1/devices/proximity`; alerts are a silent corner card that expires on its own. |
| Fleet control | Heartbeat with app version, storage and playback state; commands SUSPEND, RESUME, REFRESH_PLAYBACK, PURGE_RIDER_DATA and UPDATE_CONFIG are applied and acknowledged. |
| Security | Strict CSP on the page (own scripts and styles only; media from the configured media origin; frames only over https); text is always set via `textContent`; screen wake lock when available. |
| Accessibility | 44–48 px touch targets, visible focus, dialog semantics with Escape to close, live regions for status and alerts, reduced-motion support. |

`?fast=1` shortens timers for local development and tests; it is ignored on any host other than localhost/127.0.0.1.

## Verified end-to-end (`apps/player/e2e/player.e2e.ts`)
Real Chromium against the real API, PostgreSQL and ffmpeg-generated media. The test walks through:
1. Enroll the tablet and check the private key is non-extractable.
2. Wait for vehicle assignment, then play content with a banner, a video ad with a skip countdown, and the "Advertisement" header.
3. "Learn more" QR, then rider QR sign-in, then a coupon saved to the wallet.
4. Trivia scored 3 with the sponsor reward shown.
5. Drive into a geofence and see the silent alert.
6. Fleet suspend, resume and purge.

Finally the uploaded events are validated by the server: qualified content view, qualified video ad view, banner impression and a valid click. A play that starts in the seconds between a server-side suspension and the tablet's next heartbeat is correctly rejected as `DEVICE_NOT_ACTIVE`.

## Known limits (handled by the Android shell)
- Kiosk lock and auto-start; hardware-backed key; background location; large offline media cache; OTA updates and EMM-managed config.
- Plain browsers block autoplay with sound until a tap ("Tap to start"); kiosk WebViews allow it.
