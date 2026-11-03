# Media, Moderation and Rights (milestones M2.1–M2.3)

## Upload → processing → human review

```
client ──POST /uploads──▶ session ──PUT chunks (Content-Range)──▶ .part ──POST complete──▶ UPLOADED
   (size, SHA-256 declared)          resumable: GET /uploads/:id → receivedBytes        SHA-256 + magic-byte type check
UPLOADED ──jobs:process-media──▶ ffprobe ─▶ limits ─▶ transcode H.264/AAC 720p + faststart ─▶ thumbnail
                                  ─▶ sample ≤30 frames + 16 kHz mono audio ─▶ AI providers + text screen ─▶ moderation case (OPEN)
OPEN case ──human moderator──▶ APPROVE (video live on tablets) │ REJECT (policy reasons) ──creator appeal──▶ different moderator
```

- **File type comes from the bytes**, never from the declared content type. Allowed: MP4, MOV and WebM video; PNG and JPEG images (display ads only).
- **Length limits:** creator video 5 s – 30 min; ad video 1 s – 3 min (D-037). The probed duration is authoritative and becomes the creative's or video's billing duration.
- **Originals are never served.** Only `720p.mp4`, `display.jpg` and `thumb.jpg` renditions, through signed, expiring links (`/media/*` locally; the CDN edge in production), with HTTP range support for players.

## MODERATION_POLICY_V1 (fail closed)
| AI outcome | Recommendation | Priority | Video status |
|---|---|---|---|
| All providers OK, max category score < 0.2 | LIKELY_OK | NORMAL | PENDING_REVIEW (human must approve) |
| Any score ≥ 0.2, or any provider UNAVAILABLE/ERROR | NEEDS_REVIEW | HIGH if degraded | PENDING_REVIEW |
| Any score ≥ 0.85 | LIKELY_VIOLATION | HIGH | PENDING_REVIEW |

- Nothing is published without a human decision. `MODERATION_AUTO_APPROVE` can only be `false` (D-034).
- AI findings (scores, provider status, transcript excerpt, frame count) are immutable. Decided cases are immutable; a change of outcome goes through an appeal.
- Rejections must cite policy reasons (PROFANITY, SEXUAL_CONTENT, NUDITY, GRAPHIC_VIOLENCE, HATE_OR_ABUSE, SELF_HARM, DRUGS, WEAPONS, COPYRIGHT, NOT_FAMILY_FRIENDLY, LOW_QUALITY, MISLEADING, OTHER).
- Reviewers cannot decide content from an organization they belong to. Appeals are decided by a different reviewer.
- **Providers:** a built-in deterministic text screen (titles, descriptions, banner copy, transcripts) is the floor. The visual and speech classifier is a pluggable `ModerationProvider`. None is configured yet, so every case is marked degraded and HIGH priority (D-035).
- Ad creative media gets the same AI pre-screen. The campaign reviewer's creative decision closes that asset's moderation case, so there is one human decision per creative.

## Rights
- Video submission requires all four statements of `RIGHTS_ATTESTATION_V1` (`GET /v1/rights/attestation`), stored immutably with the statement hash, user and IP.
- Optional `video_licenses` records (licensor, scope, territory, expiry, document reference).

## Copyright notices (DMCA-style; D-036)
1. `POST /v1/takedowns` (public, rate-limited) requires identification of the work, contact details, good-faith and accuracy-under-penalty statements, and a signature. An approved video is **removed from tablets immediately** (TAKEN_DOWN).
2. The creator may file a counter-notice (good-faith belief of mistake, consent to jurisdiction, signature). Restoration becomes possible after **10 business days**.
3. `takedown.manage` resolves the notice: RESTORE (only after the waiting period, and only if no other open notice exists), UPHOLD (court action filed or claim accepted), or WITHDRAWN (complainant withdrew, so it is restored).
4. Open strikes per creator are shown to staff; the repeat-infringer policy is DECISION REQUIRED.

## Operations
- Run `npm run jobs:process-media -w @rmn/api` continuously or every minute. Each upload is claimed with `FOR UPDATE SKIP LOCKED`, so multiple workers are safe.
- Requires `ffmpeg`/`ffprobe` on the worker. Production storage: an object store adapter implementing `LocalMediaStore`'s interface, behind a CDN that verifies signed URLs.
