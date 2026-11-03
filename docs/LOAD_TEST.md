# Load test results (R-015)

`apps/api/load/tablet-load.ts` starts the real API server as its own process against a dedicated PostgreSQL database. It then enrols N simulated tablets with real Ed25519 keys. Each tablet sends signed requests on a **compressed** schedule: a heartbeat every 10 s (real tablets: 60 s), a playlist every 30 s and a batch of 3 ad plays every 20 s. The plays are realistic: back to back, after the tablet's first check-in, reported as soon as they end. All of them validate. After the run the script times the validation job over everything uploaded.

Environment for the results below: a single shared cloud container (one Node process, PostgreSQL 16 on the same machine), with row-level security on. Treat the numbers as indicative, not as capacity guarantees.

## 2026-11-03

| Tablets | Requests/s | Heartbeat p50 / p95 / p99 | Playlist p50 / p95 / p99 | Events p50 / p95 / p99 | Errors | Validation |
|---:|---:|---|---|---|---|---|
| 300 | 44.6 | 11 / 23 / 41 ms | 14 / 30 / 65 ms | 11 / 30 / 40 ms | none | 891 events, 117 events/s, all VALID |
| 1,000 (before fix) | 154.7 | 14 / 66 / 186 ms | 25 / **490** / 642 ms | 13 / 38 / 52 ms | none | 6,000 events, 75 events/s |
| 1,000 (after fix) | 154.6 | 13 / 36 / 56 ms | 15 / **50** / 71 ms | 13 / 35 / 50 ms | none | 6,000 events, 77 events/s, all VALID |

Because heartbeats are 6× more frequent than real tablets send them, 1,000 simulated tablets put roughly the heartbeat load of 6,000 real ones on the server.

## Findings and fixes
1. **Playlist budget checks were the bottleneck (R-024).** Each playlist request recounted every validated play of every scheduled campaign, so its cost grew with campaign history. **Fixed:** each campaign's "can it play another billable view?" decision is cached per process for `PLAYLIST_BUDGET_CACHE_MS` (5 s by default; 0 in tests). Playlist p95 dropped from 490 ms to 50 ms at 1,000 tablets. Billing is unaffected: the validator still checks every play exactly, so at most one cache window of extra plays can be served after a limit is reached, and those plays are never billed (D-056).
2. **Per-IP rate limiting would have throttled fleets on carrier NAT.** **Fixed:** signed tablet traffic is limited per device (`ratelimit.test.ts`).
3. **Validation throughput (open, R-024).** The validator processes about 75–120 events per second in one run. Its cost is dominated by the per-event budget recount. Real tablets produce about 1 billable event per minute, which is about 17 events/s for 1,000 tablets, so there is headroom for a pilot. **Before scaling beyond a few thousand tablets**, maintain per-campaign spend counters that the validator updates incrementally.

## Not covered yet
- Portal and rider traffic (low volume compared with tablets).
- Media delivery: video bytes go through a CDN in production (R-021), not the API.
- Multi-instance API deployments, and the database on separate hardware.
- An external penetration test (R-015 remains open for that).
