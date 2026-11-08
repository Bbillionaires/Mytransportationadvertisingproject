# Media storage and backups (R-021, R-029)

## How it works
| Where | What | Who can delete |
|---|---|---|
| **Railway bucket** (main store) | `originals/<upload id>`: every verified upload, written once. `assets/<asset id>/…`: processed video, image and thumbnail | Nobody through the app. The app only ever adds objects; takedowns and rejections only hide videos |
| **AWS S3 backup** (backup1) | A copy of every original, in Glacier Instant Retrieval, with **version history + Object Lock (Governance)** | Nobody by accident or with stolen keys. Only the account owner, deliberately, with a special permission |
| Optional second Railway bucket (backup2) | Another copy of every original, in a different region and project | Its keys can delete it (Railway has no Object Lock), so keep it in a separate project or account |
| **Each tablet** | A local copy of the media in its current playlist | Removed automatically when the server stops listing it (ended, withdrawn or taken down) |

- **Delivery:** tablets, the portal and reviewers get short-lived signed links straight to the Railway bucket. Downloads don't pass through the API, so they cost nothing (bucket egress is free on Railway).
- **Backups:** `jobs:backup-media` (every 5 minutes) copies new originals to every backup bucket. Copies are add-only: a conditional write refuses to overwrite an existing backup.
- **Nightly check:** `jobs:verify-media` confirms every original exists in every bucket with the recorded size and SHA-256. It re-copies a missing backup automatically and exits non-zero for anything else. Run `jobs:verify-media -- --deep` monthly: it re-downloads and re-hashes the main bucket's copies, where downloads are free.
- **Restore:** `jobs:restore-media` copies missing or damaged originals back from a backup and re-creates their processed video and thumbnail. Run it for everything, or pass upload ids.
- **Setup check:** `jobs:check-media-storage` tests every bucket, sets the main bucket's CORS rule (so tablets can keep offline copies), and confirms at least one backup has version history and Object Lock. Run it after setup and on each deploy.

Approximate cost for 1.5 TB of video (about 1,000 hours of 720p):

| Item | Per month |
|---|---|
| Railway main bucket | ~$22 |
| AWS backup (Glacier Instant Retrieval) | ~$6 |
| Optional second Railway backup | +~$22 |

Restoring a file from AWS costs about $0.03/GB retrieval plus ~$0.09/GB download, so about $0.18 for one 1.5 GB video.

## Step 1 — AWS backup bucket (you, in the AWS console, about 10 minutes)
Do this signed in as the account owner, with your authenticator app at hand.

1. **Pick a region** (top right): **US East (Ohio) us-east-2**. Any region different from your Railway bucket's is fine.
2. Search **S3** → **Create bucket**:
   - **Bucket type:** General purpose.
   - **Bucket namespace:** **Global** (the standard kind).
   - **Bucket name:** for example `rmn-media-backup-<something-unique>`. Lowercase, numbers and hyphens only.
   - **Object Ownership:** ACLs disabled (default).
   - **Block all public access:** leave it **ON** (default).
   - **Bucket Versioning:** **Enable**.
   - **Default encryption:** SSE-S3 (Amazon S3 managed keys, the default and free). Not the KMS options: they cost per request and need extra permissions. Bucket Key doesn't apply.
   - **Advanced settings → Object Lock:** **Enable**, and tick the acknowledgement. *This can only be turned on now, at creation.*
   - **Create bucket**.
3. Open the bucket → **Properties** → **Object Lock** → **Edit**:
   - **Default retention:** Enable. **Mode: Governance.** **Retention type: Fixed retention** (not "variable retention with event hold"; the app doesn't manage holds). **Retention period: 1 year.**
   - Save. Governance means nobody can delete or change a locked copy unless they hold a special permission, and the backup user never gets it. Compliance mode would also stop *you* from removing content you are legally required to delete, so don't use it.
4. Create the backup user's permissions. Search **IAM** → **Policies** → **Create policy** → **JSON**, paste this, and replace `BUCKET` (two places in each statement) with your bucket name:
   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       { "Sid": "AddAndReadBackups", "Effect": "Allow",
         "Action": ["s3:PutObject", "s3:GetObject", "s3:GetObjectVersion"],
         "Resource": "arn:aws:s3:::BUCKET/*" },
       { "Sid": "ListAndCheck", "Effect": "Allow",
         "Action": ["s3:ListBucket", "s3:GetBucketVersioning", "s3:GetBucketObjectLockConfiguration"],
         "Resource": "arn:aws:s3:::BUCKET" },
       { "Sid": "NeverDeleteOrUnlock", "Effect": "Deny",
         "Action": ["s3:DeleteObject", "s3:DeleteObjectVersion", "s3:BypassGovernanceRetention", "s3:PutObjectRetention",
                    "s3:PutObjectLegalHold", "s3:PutBucketObjectLockConfiguration", "s3:PutBucketVersioning",
                    "s3:PutLifecycleConfiguration", "s3:PutBucketPolicy", "s3:DeleteBucketPolicy", "s3:DeleteBucket"],
         "Resource": ["arn:aws:s3:::BUCKET", "arn:aws:s3:::BUCKET/*"] }
     ]
   }
   ```
   **Next** → name it `rmn-media-backup-writer` → **Create policy**.
5. **IAM** → **Users** → **Create user**:
   - **User name:** `rmn-media-backup`. **Do not** give it console access.
   - **Permissions:** attach policies directly → `rmn-media-backup-writer` → **Create user**.
6. Open the user → **Security credentials** tab (or **Create access key** under "Access key 1" in the Summary) → **Create access key** → **Application running outside AWS** → **Create**.
   - Copy the **Access key ID** and **Secret access key** straight into Railway (Step 3).
   - **Never paste them into chat or email.** AWS shows the secret only once; if you lose it, delete the key and create a new one.

## Step 2 — Railway main bucket (about 2 minutes)
In your Railway project: **Create** → **Bucket** → pick the region closest to your first city → name `media`. The region can't be changed later. With your OK, Claude can create it through the Railway connector.

## Step 3 — Railway variables (on the API service and every job service)
| Variable | Value |
|---|---|
| `MEDIA_STORE` | `s3` |
| `MEDIA_S3_ENDPOINT` | `${{media.ENDPOINT}}` |
| `MEDIA_S3_REGION` | `${{media.REGION}}` |
| `MEDIA_S3_BUCKET` | `${{media.BUCKET}}` |
| `MEDIA_S3_ACCESS_KEY_ID` | `${{media.ACCESS_KEY_ID}}` |
| `MEDIA_S3_SECRET_ACCESS_KEY` | `${{media.SECRET_ACCESS_KEY}}` |
| `BACKUP1_S3_REGION` | `us-east-2` (your AWS region) |
| `BACKUP1_S3_BUCKET` | your AWS bucket name |
| `BACKUP1_S3_ACCESS_KEY_ID` / `BACKUP1_S3_SECRET_ACCESS_KEY` | from Step 1.6 (mark them as sealed/secret) |
| `BACKUP1_S3_STORAGE_CLASS` | `GLACIER_IR` |

Leave `BACKUP1_S3_ENDPOINT` empty for AWS. For an optional second Railway backup in a separate project, set `BACKUP2_S3_*` the same way from that bucket's Credentials tab.

Give only the **backup job** the `BACKUP*` keys if you can. The API never needs them.

## Step 4 — Jobs and the check
- Railway cron services:
  - `npm run jobs:backup-media -w @rmn/api` every 5 minutes
  - `npm run jobs:verify-media -w @rmn/api` nightly
  - `npm run jobs:verify-media -w @rmn/api -- --deep` monthly
- Alert on non-zero exits.
- Run `npm run jobs:check-media-storage -w @rmn/api` once. Every line should read **PASS**; WARN is acceptable only for an unlocked secondary copy.

## Legally required deletion
Some content must be permanently deleted, for example illegal material or under certain court orders. The account owner deletes the main-bucket objects and, in AWS, the locked versions. Governance mode needs an explicit bypass permission for this, deliberately not given to the backup user. Record each case in the audit log. **DECISION REQUIRED:** who may approve such deletions (D-057).

## Testing
`apps/api/test/mediabackup.test.ts` runs against a real S3 API: moto locally and in CI, the same code that talks to Railway and AWS. It covers:
- upload, then process, then signed direct links
- backups to two buckets, idempotent; overwrite refused; locked version can't be deleted; written as Glacier IR
- lost original and lost renditions detected, then restored and re-rendered
- an original corrupted in place detected and restored, then clean under a deep check
- a lost backup copy re-copied automatically

The player browser test covers tablet caching: it caches its media, keeps playing with the network cut, and deletes an ended campaign's cached ad.
