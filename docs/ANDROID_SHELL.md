# Android tablet shell

`apps/android` is a thin Kotlin app that turns a dedicated Android tablet into a passenger screen. All product behaviour (playback, ads, games, rewards, proximity alerts, event queue) lives in the web player (`/player/`), which the shell loads full-screen. The shell adds only what a browser cannot: a **hardware-backed device key**, **kiosk lock**, **boot-to-player**, and crash recovery. See D-052 and D-053.

> Status: builds, unit-tests and lints in CI. **Not yet run on a physical tablet**; kiosk behaviour varies by OEM and EMM (R-004).

## What it does
| Concern | Implementation |
|---|---|
| Device identity | ECDSA P-256 key generated in the Android Keystore (StrongBox when available, else TEE). Never leaves the hardware. Enrollment sends its SPKI public key; the API verifies P-256 (DER) and Ed25519 signatures. |
| Bridge to the web player | `WebViewCompat.addWebMessageListener("RMNDevice", allowedOrigins = {server origin})`. Android injects the bridge **only** into frames from the configured server origin, and the shell additionally requires the main frame. Advertiser iframes and other sites never see it. `addJavascriptInterface` is deliberately not used. |
| Signing oracle limits | The bridge has two ops (`info`, `sign`). `sign` accepts only canonical device-protocol strings: `GET|POST`, a `/v1/devices/...` path, timestamp, nonce, body SHA-256 (≤ 512 bytes). It cannot sign arbitrary data or requests to staff/finance APIs. |
| Navigation | The main frame can never leave the server origin (no `intent://`, other hosts, http downgrade). Ad landing pages open on the passenger's phone by QR, as in the web player. |
| WebView hardening | No file/content access, mixed content blocked, Safe Browsing on, camera/microphone requests denied, geolocation granted only to the server origin (coarse). Cleartext is disabled in release builds. |
| Kiosk | When the EMM makes the app device owner or allow-lists it for lock task: `startLockTask()`, keyguard and status bar disabled, the player set as HOME. Otherwise it runs as a normal full-screen app with immersive mode and back disabled. |
| Resilience | Starts on boot; recreates the WebView if the renderer crashes; retries every 10 s when offline at start; managed-config changes apply without reinstall. |
| Privacy | Backups and device-transfer disabled; the only local state is the key alias, a random serial (`AND-…`) and the web player's IndexedDB. |

## Managed configuration (EMM)
| Key | Type | Default | Meaning |
|---|---|---|---|
| `server_url` | string | build default | HTTPS origin of the API, e.g. `https://rides.example.com`. Anything else (http, credentials in URL, other schemes) is ignored. |
| `kiosk_enabled` | bool | `true` | Enter lock task mode when permitted. |

## Build
```bash
cd apps/android
export ANDROID_HOME=/path/to/android-sdk          # platforms;android-35, build-tools;35.0.0
./gradlew :app:assembleDebug :app:testDebugUnitTest :app:lintDebug
```
Debug builds (`net.ridesharemedia.shell.debug`) default to `http://10.0.2.2:8080`, which is the host's `npm run dev` as seen from the emulator. Release builds require HTTPS and a signing key. Signing keys are never committed (`*.jks` is git-ignored); release signing is a CI secret (**DECISION REQUIRED**: who holds the upload key / Play App Signing, D-052).

## Pilot provisioning (one tablet)
1. Factory-reset the tablet and install the APK.
2. For a pilot without an EMM: `adb shell dpm set-device-owner net.ridesharemedia.shell/.AdminReceiver`. This works only on a freshly reset device with no accounts.
3. Set `server_url` via the EMM, or build with the pilot URL as `DEFAULT_SERVER_URL`.
4. Create an enrollment code in the fleet console and type it on the tablet. Assign the device to a vehicle.

For a fleet rollout, use an EMM with Android Enterprise dedicated-device enrollment (QR / zero-touch). The EMM vendor is **DECISION REQUIRED** (D-017).

## Testing
- JVM unit tests: `UrlPolicyTest` (origin validation and navigation lock) and `BridgeProtocolTest` (signatures verify; refuses non-device payloads, unknown ops and malformed input).
- The player browser e2e runs a second tablet through a **simulated bridge** with the same protocol and allow-list, using ECDSA P-256 with DER signatures. This proves the web player and API work end to end with a hardware-style key.
- Not automated yet: an instrumented test on an emulator, and real-device kiosk and boot checks (R-004).

## Not yet done
- Play Integrity / key attestation sent at enrollment, so the server can prove the key is hardware-backed (R-028).
- Large offline media cache with expiry enforcement in the shell (R-029).
- OTA update policy through the EMM; per-OEM kiosk quirks.
