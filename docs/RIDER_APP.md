# Rider Phone Web App — `apps/rider`

An installable web app (PWA) at **`/rider/`**. No app store is needed: the tablet's sign-in QR is a normal https link, so the phone's built-in camera opens this app, which pairs immediately.

```bash
npm run build:web    # player + rider bundles
npm run dev          # http://127.0.0.1:8080/rider/
npm run e2e          # tablet ride + rider app, in real Chromium against the real API
```

| Feature | Behaviour |
|---|---|
| Account | Create (nickname, email, password ≥ 12, birth year, 18+ and terms checkboxes, optional marketing), email confirmation link, sign in/out, forgot/reset password by email, edit name and marketing preference, delete account with password confirmation. |
| Connect to a screen | 1) Phone camera on the tablet QR → `…/rider/?pair=CODE` opens the app and pairs (after sign-in if needed). 2) In-app camera scanner where the browser supports `BarcodeDetector`. 3) Type the 8-character code. |
| Wallet | Coupons and rewards, each expandable to a QR and large code for the checkout; used/expired items are dimmed. |
| Offline | A service worker caches only the app shell. The last wallet is kept on the phone (`localStorage`), so codes can be shown with no signal; it is cleared on sign-out and account deletion. API responses are never cached by the service worker. |
| Privacy & security | Strict CSP; camera permitted only on this app (Permissions-Policy); all text via `textContent`; one-time tokens are removed from the address bar after use; the session token is stored on the rider's own phone (30-day expiry, revoked on sign-out, password reset and deletion). |
| Accessibility | ≥ 48 px controls, labelled inputs, visible focus, live status messages, tab semantics. |

Server additions this session: rider password reset (`POST /v1/riders/password-reset/request|confirm`), `PATCH /v1/riders/me`, and the tablet pairing QR now encodes `${APP_PUBLIC_URL}/rider/?pair=CODE` (the pairing endpoint accepts the bare code, the link or the legacy `RMNPAIR:` form).
