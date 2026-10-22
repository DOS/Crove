# 0013. Evidence storage and integrity: generations, staged uploads and presigned transfers

- Status: accepted (2026-10-16), as the acceptance criteria of issue #109 require; the owner may amend it
- Date: 2026-10-16
- Deciders: owner (JOY), through issue #109
- Builds on: plan §7.6 (file upload), §4.11 (surfaces: presigned URLs with S3, streaming with local disk), red-team S25 ("evidence swapped after approval"), External-tenant gate T7 (the S3 adapter, #110, #133)
- Tracking: issue #109; plan "External-tenant gate" row T7. Amended 2026-10-22 by issue #1009 (section 6, retention holds), on the owner's decision there

## Context and problem statement

A file in Crove is evidence: an invoice is approved and booked on the strength of what the file says. Red-team S25 asked what happens when the bytes behind a file change after a human approved the proposal made from it. Before this ADR:

- `crove_kernel.file` kept `storage_key` and `sha256`. The key is the content address `org/<org_id>/<sha256>`, and `S3BlobStore` writes create-only (`If-None-Match: *`, on GCS `x-goog-if-generation-match: 0`) with an `x-amz-checksum-sha256` the server verifies, so Crove itself never replaces an object.
- Nothing stopped anyone else with write access to the bucket (an operator, a leaked key, a backup restore) from replacing the object under a key. Reads took whatever the key held at the time and never checked it against the recorded sha256. The download, the worker's extraction and a later re-extraction could all read different bytes from the ones that were approved.
- Uploads and downloads streamed through the kernel on every store, and `BlobStore.put` returned nothing, so no version could be recorded.
- Tenant roles could `UPDATE` a file row, so a reference could also change in the database.

Plan §7.6 lists the target: (1) upload to a random staging key through a single-use presigned URL (5-minute TTL, size-limited); (2) the server streams the file and computes the sha256; (3) copy to `org/<org_id>/<sha256>` create-only and record the `generation`; (4) bucket versioning and a retention hold; (5) every reference uses the triple (key, generation, sha256).

## Decision drivers

- Fail closed: a read never returns bytes other than the ones the row recorded. When it cannot prove that, it refuses.
- The sha256 the server computed is the only identity of a file. A client-supplied hash or a staged object never becomes a file on its own.
- One design for every S3-compatible store (AWS S3, MinIO, Cloudflare R2, GCS interoperability) and for local disk, without a second code path for evidence.
- The API and the worker run as separate containers (T7); browsers move file bytes directly to and from the bucket when the store is S3, so the kernel does not carry 25 MB bodies it does not need to.
- The database enforces what it can (immutability, single use, clocks) for every role, not only the TypeScript path.

## Decision

### 1. Every file reference is the triple (key, generation, sha256)

`crove_kernel.file` gains `generation text`. `BlobStore.put` returns the generation of the object it created or found, and `kernel.file.ingest` and `kernel.inbound.receive` require it. The value is tagged by where it lives:

| Generation | Meaning | Written by |
|---|---|---|
| `s3:<VersionId>` | The S3 object version (bucket versioning on) | `S3BlobStore` on AWS S3, MinIO and any server that returns `x-amz-version-id` |
| `gcs:<generation>` | The GCS object generation (`x-goog-generation`) | `S3BlobStore` against `storage.googleapis.com` |
| `content:<sha256>` | No native version: the object is known by its content address only | `LocalDiskStore`; `S3BlobStore` with `S3_VERSIONING=off` |

Why tagged: the row stays unambiguous when an org's files move between stores, and the read path knows from the value alone whether it can pin a version. A `CHECK` constraint accepts only these forms, and a `content:` generation must be the row's own sha256.

Why `content:<sha256>` on local disk, and not an inode number, a modification time or a counter: local disk has one copy per key, and the store only ever creates a key once (hard link, #111). Nothing can be pinned, so the honest value is "the content address"; an inode or a timestamp would change on a backup restore while the bytes stay the same, and a counter would have to live somewhere shared by the API and the worker for no gain. The sha256 check on read (below) is the whole guarantee there.

Rows written before this ADR keep `generation` NULL. Their reads are checked by sha256 alone, and they are downloaded through the kernel, never presigned. Nothing backfills them, because the version they were written as was never recorded, and a re-upload of the same bytes dedupes to the existing row without pinning it (the guard trigger refuses the change). A one-time migration that reads each legacy object, verifies its sha256 and records the version it read is a possible follow-up.

A file row never changes: a `BEFORE UPDATE` trigger (`crove_kernel.file_guard`) refuses any change to it, for every role, the database owner included (only a superuser can skip triggers, with `session_replication_role = replica`). A `NOT VALID` check ties `storage_key` to `org/<org_id>/<sha256>` for every new row. Tenant roles keep the `UPDATE` privilege only because the commands lock the file row (`SELECT ... FOR UPDATE` needs it). Everything that points at a file (extractions, proposals, documents) points at the row by id, so it points at the triple.

### 2. Reads request the recorded version and verify the sha256

`readVerified(store, ref)` is the only way kernel code reads a file: the download path, the extraction job and re-extraction. It asks the store for the exact version (`GetObject` with `VersionId`; on GCS the same request with `generation`), hashes the bytes and raises `BlobIntegrityError` when they differ from the recorded sha256. A missing version is a missing blob, never "the current object instead". The API answers `500 BLOB_INTEGRITY` and logs an `ALERT`; the worker retries and then records the extraction as failed. Nothing is served or parsed.

What this gives against S25, by store:

- Versioned bucket: an overwrite creates a new version; Crove keeps reading the recorded one, so the original evidence is still what is served and parsed. Deleting the recorded version makes reads fail closed. With a retention hold (below), neither is possible within the retention period.
- Unversioned bucket (`S3_VERSIONING=off`) and local disk: an overwrite is detected by the sha256 check and the file is refused. The original is gone; recovery is from backups.

### 3. Bucket versioning is required by default

`S3_VERSIONING=required` (the default) makes `S3BlobStore.put` fail with `BlobStoreVersioningError` when the bucket answers without a version id (or with `null`, the id of an object written while versioning was off or suspended). That makes a misconfigured production bucket fail on the first upload instead of silently storing evidence without versions.

`S3_VERSIONING=off` is an explicit operator choice for stores without versioning (Cloudflare R2 has none today). The kernel logs a warning at startup, and generations are `content:<sha256>`.

Not a hard production refusal: a production deployment on R2 is legitimate, and the sha256 check still detects a swap. The trade-off (detection without recovery) is stated in `.env.example` and here.

Operator requirements for an evidence bucket (S3 terms; GCS and others have equivalents):

- Versioning enabled before the first write.
- Object Lock enabled on the bucket, so that Crove can hold the original file of every posted invoice for the legal retention period of plan §7.9 (section 6). Without it the worker reports that files wait for their hold and posting goes on; a GCS retention policy or an R2 bucket lock rule on `org/` is the substitute on stores without per-object retention.
- IAM: `s3:GetObject`, `s3:GetObjectVersion`, `s3:PutObject`, `s3:DeleteObject`, `s3:GetObjectRetention`, `s3:PutObjectRetention` on objects, `s3:ListBucket` and `s3:GetBucketObjectLockConfiguration` on the bucket. Never `s3:BypassGovernanceRetention`.
- A lifecycle rule that expires `staging/` objects, their noncurrent versions and delete markers after one day. Without one, the worker's daily retention job deletes `staging/` objects older than an hour (issue #223, section 4); on a versioned bucket those deletes leave noncurrent versions behind, which only the lifecycle rule removes, because Crove holds no `s3:DeleteObjectVersion`.
- With presigned transfers, a CORS rule allowing `POST` and `GET` from `PUBLIC_URL`.

### 4. Staged uploads with presigned POST (STORAGE=s3)

1. `POST /api/files/uploads`: after the same membership check as a direct upload (viewers refused), the command `kernel.file.upload.begin` creates a row in `crove_kernel.file_upload` with a random staging key `staging/<64 hex>` and returns it; the API signs an S3 **POST policy** for it. The policy pins the bucket and the exact key, sets `content-length-range` to 1 byte .. 25 MB and expires after 5 minutes.
2. The browser posts the file to the bucket with the form fields, without any Crove credentials.
3. `POST /api/files/uploads/:id/complete`: the command `kernel.file.upload.claim` uses the grant (sets `used_at`), and only then does the server stream the staged object through sha256 with the size cap, sniff its type from the content, write those exact bytes create-only to `org/<org_id>/<sha256>` with `put`, record the triple with `kernel.file.ingest`, and delete the staging object.

Why POST and not PUT: a presigned PUT URL cannot bound the size; the signed `Content-Length` header is a single exact value the client chooses before signing, and some servers ignore it. A POST policy's `content-length-range` is enforced by the store. The server checks the size again while it streams, so a store that ignores the condition still cannot pass a larger file.

Why the server re-writes the bytes instead of a server-side `CopyObject`: within its 5 minutes the same form can be posted again, replacing the staging object. A `CopyObject` would copy whatever the staging key holds at copy time, possibly not the bytes that were hashed; pinning it (`CopySourceVersionId`, `CopySourceIfMatch`) and conditional copies (`If-None-Match` on the destination) are not supported the same way across S3-compatible servers. Writing the buffered bytes the server just hashed has no window at all, uses the same create-only `put` and checksum as every other write, and costs at most 25 MB of memory for one request, as a direct upload already does.

Why the bytes are buffered rather than streamed from the staging object into the destination: the destination key is the sha256 of the bytes (`org/<org_id>/<sha256>`), which is known only once the last byte has been read, and the create-only `put` sends that sha256 as its checksum up front. Streaming would need a temporary destination and a copy, which is the window above. So the memory is bounded instead (issue #223): each API process completes at most `UPLOAD_COMPLETE_CONCURRENCY` (default 4) uploads at once, and one user at most half of them. A completion past that answers `503 UPLOAD_BUSY` with `Retry-After` at once, without waiting in memory. The slot is taken before the claim, so a refused completion leaves its grant unused and the app retries the same upload (with backoff, for about a minute).

Single use is enforced by the database, not by the URL: a presigned POST can be replayed until it expires, so the grant row is what is used once.

`crove_kernel.file_upload` (`org_id`, `id`, `staging_key`, `created_by`, `max_bytes`, `created_at`, `expires_at`, `used_at`), a tenant table with the standard RLS policy:

- A `BEFORE INSERT` trigger sets `created_at` and `expires_at` (5 minutes) from the database clock, clears `used_at`, and takes `created_by` from the sealed context whenever a user is in it, so no runtime role picks any of them.
- A `BEFORE UPDATE` trigger allows exactly one change: claiming an unused, unexpired grant, by its creator (when a user is in the context), with `used_at` from the database clock. A second claim (`UPLOAD_USED`), a claim after expiry (`UPLOAD_EXPIRED`), another user's claim (`UPLOAD_NOT_YOURS`) and any other change (`UPLOAD_IMMUTABLE`) are refused for every role, the owner included (short of a superuser skipping triggers). Without a user in the context (the worker's system context) the creator checks do not apply; no system command creates or claims grants.
- Tenant roles hold `SELECT`, `INSERT` and `UPDATE (used_at)` only; no `DELETE`.
- The claim command locks the row, so of concurrent completions exactly one proceeds; the others get `409 UPLOAD_USED`. Another user's grant reads as `404`.
- `kernel.file.upload.begin` refuses a user with 20 open grants in the org (`429 RATE_LIMITED`), counted under a per-user advisory lock so concurrent requests cannot pass the cap together.
- It also refuses a user who opened `UPLOAD_BEGIN_LIMIT_PER_MINUTE` (default 20) grants in the org in the last minute, by `created_at` (the database clock), under the same lock, so the limit holds across API instances (issue #223). The open cap alone does not bound a loop of begin, claim and a late POST to the still valid form: a claimed grant is no longer open, yet each round can leave a 25 MB staging object.
- The worker's daily retention job deletes grants created more than 7 days ago (`crove_kernel.retention_purge`, store `kernel.file_upload`); a grant expires 5 minutes after it is created, so each of them is used or expired and nothing can claim it any more. The audit rows keep the grant id. The purge runs as the table owner and only the worker may call it; tenant roles still cannot delete a grant.

The staging object never becomes a file: no file row points at a `staging/` key (the ingest command accepts only the org content address), and a write to the staging key after the claim is never read. A grant that is begun and never completed leaves at most one staging object, and so does a form posted again after its claim. The lifecycle rule removes them. As a fallback, the worker's daily retention job lists `staging/` (`ListObjectsV2`, 10,000 keys per call, at most 100 calls per run) and deletes every staging object last modified more than an hour ago, logging an `ALERT` when objects remain or the sweep fails. A grant lives 5 minutes and its completion reads the object right after the claim, so an hour-old staging object is never read again. The sweep frees space only on an unversioned bucket: on a versioned one each delete leaves a noncurrent version, so the lifecycle rule stays the real bound there. The per-minute grant rate bounds what one user can leave behind between sweeps (at most 20 objects of 25 MB a minute per org by default).

Clock note: the database decides the grant's expiry; the API's clock signs the POST policy's expiration. Both are 5 minutes; a skew between them shifts which of the two refuses first, never lets a late upload become a file.

The direct `POST /api/files` stays available with S3 (scripts, API clients, `S3_PRESIGNED_URLS=false`); it takes the same server-side hash and create-only write. With presigned uploads on, it takes documents of at most 4 MB (`DIRECT_UPLOAD_MAX_BYTES`, #432): bulk intake sends small files that way rather than opening a grant for each, and a larger document goes through the staged upload. Every body it reads holds one of a bounded number of upload slots per process.

### 5. Presigned downloads of the exact version

`GET /api/files/:id` runs the same authorization as before (membership, `kernel.file.get` under RLS). With S3 and a versioned generation it answers `302` to a presigned `GET` for that `VersionId`, valid 60 seconds, with `response-content-disposition: attachment` (RFC 6266 filename), the sniffed content type and `cache-control: private, no-store`. The version is inside the signature, so the URL cannot be pointed at another version. `?link=1` returns the same URL as JSON, which the app uses so that its `Authorization` and org headers never follow a redirect to the bucket.

A presigned GET is the one read that skips the sha256 check: the bytes go from the bucket to the browser and never pass through the kernel. That is sound because the URL names the exact version the row recorded, inside the signature, and an object version is immutable: a write to the key creates a new version and never changes the recorded one. Those bytes were verified when they were written (the create-only `put` sends their sha256 as `x-amz-checksum-sha256`, which the server checks, or the store reads the object back and compares). The worst a bucket writer can do is delete that version, and then the GET fails; it cannot make the URL serve other bytes. Unpinned generations are exactly the ones that cannot rely on this, so they are never presigned.

A generation that cannot be pinned (`content:`, or NULL) is never presigned: the kernel streams it through `readVerified`, so an unversioned object is still checked before it is served. Local disk always streams through the kernel, as before.

With a GCS endpoint presigned transfers stay off (the POST policy fields `@aws-sdk/s3-presigned-post` signs have not been verified against GCS), so transfers stream through the kernel there.

Cloudflare R2 does not accept POST policy uploads, so with presigned transfers on every browser upload would fail at the bucket. The kernel refuses to start when `S3_ENDPOINT` or `S3_PUBLIC_ENDPOINT` is an R2 host (`*.r2.cloudflarestorage.com`) and `S3_PRESIGNED_URLS` is `true` (the default), and says to set it to `false` (issue #223). Refusing rather than warning: a warning would let a deployment start with an upload button that never works, and R2 gains nothing from presigned transfers anyway, since without versioning (`S3_VERSIONING=off`) its generations are `content:` and are never presigned for download.

The SPA adds the bucket's origin to `connect-src` in its Content-Security-Policy only when presigned transfers are on. On a public `PUBLIC_URL` that origin must be `https`: the kernel refuses to start when the endpoint browsers reach (`S3_PUBLIC_ENDPOINT`, else `S3_ENDPOINT`) is plain `http` and presigned transfers are on (issue #223), because the files would cross the network unencrypted and the CSP would allow an `http` origin.

### 6. Retention holds on evidence files (issue #1009)

Owner decision (2026-10-22, issue #1009): a file that backs a posted journal entry or a filed return is held for 10 years in GOVERNANCE mode, from the posting; other files keep the bucket default; offboarding and personal-data erasure skip held files and say so. The accountant (#61) is asked which files need 10 years and whether the period starts at the posting or at the end of the fiscal year, so the period is a setting.

- **Which files:** the original file of every invoice posted to the journal (`crove_finance.purchase_document.source_file_id` of a document whose journal entry exists; purchases and sales). That is the only link from a stored file to the books today: cash, bank and general journal vouchers have no file, and Crove stores no filed return file yet (the VAT declaration XML is built on demand; the year's 01/GTGT is held as part of the year archive package under `archive/`, issue #922). A future link joins `crove_kernel.evidence_hold_due`.
- **How long:** `EVIDENCE_LOCK_DAYS` (default 3650; 0 turns holds off) from the posting time (the journal entry's `created_at`), rounded up to the whole second because S3 keeps whole seconds. A file posted more than once is held from its latest posting. A longer setting lengthens existing holds on the next run; a shorter one never shortens a hold.
- **How:** `PutObjectRetention` in GOVERNANCE mode on the exact version the row records (`VersionId` of its `s3:` generation), after `GetObjectRetention` showed a shorter retention or none. A longer retention, or a COMPLIANCE one, is kept (a COMPLIANCE hold is lengthened in COMPLIANCE: S3 refuses a change of mode on a locked version, and it is the stronger mode). A row without a pinned version holds the current version only after its bytes match the recorded sha256, so a swapped object is never the one kept. Only `org/` keys are held. The credentials never hold `s3:BypassGovernanceRetention`, so Crove can lengthen a hold and never shorten or lift one; lifting one (a court order, a mistake) is an operator step with that permission (`docs/runbooks/evidence-holds.md`).
- **Outside the transaction:** posting writes nothing for the hold. A worker job every 5 minutes reads the files whose hold is missing or too short (`crove_kernel.evidence_hold_due`, a definer the worker alone may call, across orgs that are not closed), checks once per run that the bucket has Object Lock, sets each hold and records the outcome with the system command `kernel.file.hold.record` on four columns of the file row: `held_until` (the retention the store confirmed), `hold_attempted_at`, `hold_attempts` and `hold_error`. `file_guard` lets those columns change only in a system context and refuses clearing or shortening `held_until`; the file reference itself still never changes.
- **Failures never reach the posting:** a refused hold (the version is gone, the bytes of an unpinned row changed, a permission is missing) is recorded in `hold_error` as a code (`BLOB_NOT_FOUND`, `BLOB_INTEGRITY`, `STORE_ERROR:<name>`; members of the org can read file rows, so the store's message goes to the worker log only) with an `ALERT` log and retried after 5 minutes, then 10, 20 and so on, at least daily; the posting has already committed. A bucket without Object Lock records nothing per file (each file would fail the same way, and an audit row per file per day would only be noise): the job logs one `ALERT` a day while files wait, and holds them on the first run after Object Lock is on. Local disk has no per-object retention: the store has no `holds`, and the worker says so once at start. GCS interoperability has no Object Lock API and counts as a bucket without it.
- **Offboarding and erasure:** the deletion map keeps every posted file until `held_until` (and a posted file not yet held as well), and the export carries `held_until`; the erasure result lists the original files of posted invoices that name the person's party under "kept", with the date their hold runs to. Neither deletes a stored file.

Why columns on the file row, not a table of holds: a hold is a property of the stored object, one per file, and its state is what offboarding and erasure read; the posting stays untouched, and the files that need a hold are derived from the books, so files posted before this change are held by the first run without a backfill. A queue table filled by a trigger on `journal_entry` would add a write to every posting and a second source of truth. Why GOVERNANCE: the owner's decision (an operator can still correct a mistake or obey a court order); the year archive package uses `ARCHIVE_LOCK_MODE` and may be COMPLIANCE.

## Considered options

- **Rely on create-only writes alone.** Rejected: it stops Crove from overwriting, not anyone else with bucket access, and reads still took the current object.
- **Check the sha256 on read without versions.** Kept as the floor (local disk, `S3_VERSIONING=off`, legacy rows), but alone it only detects; versions let Crove keep serving the original.
- **ETag as the generation on unversioned buckets.** Rejected: an ETag is not a version (it is an MD5 for single-part uploads and opaque otherwise), `If-Match` only detects a change, which the sha256 check already does, and it would add a fourth generation form.
- **Presigned PUT.** Rejected: cannot bound the size (section 4).
- **Server-side `CopyObject` from staging.** Rejected: copies what the key holds at copy time (section 4).
- **A signed, stateless upload token instead of a table.** Rejected: single use needs state somewhere; the idempotency table could replay a response but not refuse a second upload with new bytes before the copy, and a new secret would have to be distributed to every API instance. One small tenant table with triggers is simpler to reason about and is covered by the generated RLS matrix.
- **Hard refusal of unversioned buckets in production.** Rejected: excludes stores without versioning (R2) for a guarantee that the sha256 check partly gives anyway; the default is `required`, and opting out is explicit and logged.

## Consequences

- A swapped object after approval is detected on every read, and on a versioned bucket the original is what is served and parsed (tests below).
- Evidence buckets need versioning (default), `s3:GetObjectVersion`, a lifecycle rule for `staging/` and, for presigned transfers, CORS. A bucket without versioning fails the first upload until the operator enables it or sets `S3_VERSIONING=off`.
- Two new dependencies in `@crove/kernel-runtime`: `@aws-sdk/s3-presigned-post` and `@aws-sdk/s3-request-presigner`, the same release as `@aws-sdk/client-s3`.
- With presigned transfers the kernel no longer carries download bodies; uploads are still read back once by the API to hash them (bounded at 25 MB).
- Done in issue #223: a per-process cap on concurrent completions, a per-user rate on grants, a daily sweep of `staging/` objects for stores without lifecycle rules, pruning of old `file_upload` rows, the R2 and plain-`http` endpoint refusals at startup.
- Done in issue #1009: per-object retention holds on the original files of posted invoices (section 6).
- Not done, follow-ups: holds on GCS (event-based hold) and R2 (bucket lock rules only); running the presigned and generation paths against GCS and R2 (T7 lists them as not yet run).

## Tests

- Unit, mocked S3 client and offline signing (`packages/kernel-runtime/test/s3-store.test.ts`): generations from `VersionId` (also on the 412 dedupe path, read back with the bytes), refusal without a version unless versioning is off, version-pinned reads, missing version is not the current object, sha256 mismatch fails closed, staged reads capped by declared length and while streaming, POST policy (exact key, no `starts-with`, bucket, `content-length-range`, 5-minute expiration, public endpoint), GET presign (version id, 60 s, attachment, content type), no presign without a version, GCS `generation` parameter.
- MinIO with versioning enabled (`packages/kernel-runtime/test/s3-store.integration.test.ts`): the full presigned POST, size limit, key pinning and expiry refused by the server, overwrite of a recorded key still reads and downloads the original, deleted version fails closed, unversioned bucket refused unless off, tampered version id refused.
- PostgreSQL plus an in-memory versioned store, and MinIO when `CROVE_TEST_S3_URL` is set (`apps/kernel/test/upload.db.test.ts`, through the HTTP API): staged upload end to end with the triple recorded and the staging object deleted, single use (also after new bytes reach the staging key), expiry, other users, viewers, missing bytes, unsupported content, the generation-pinned 302 after an overwrite, fail closed for a row without a version, the open-grant cap.
- Invariant suite (`apps/kernel/test/invariant/file-upload.db.test.ts`): the triple required and checked, file rows immutable for every role, grant columns set by the database, single use under concurrency, expiry, creator-only claims, no delete; plus the generated RLS matrix row factory for `crove_kernel.file_upload`.
- Local disk (`apps/kernel/test/storage.test.ts`): `content:` generations, a file replaced on disk is refused.
- Issue #223: the completion cap (`apps/kernel/test/concurrency.test.ts`; through the HTTP API in `upload.db.test.ts`, a busy completion answers 503 with `Retry-After` and its grant stays usable), the per-minute grant rate per user (`upload.db.test.ts`), the staging sweep (mocked client in `s3-store.test.ts`, MinIO in `s3-store.integration.test.ts`, the job in `apps/kernel/test/staging-sweep.test.ts`), the grant purge (`apps/kernel/test/retention.db.test.ts`), the R2 and `http` endpoint refusals (`apps/kernel/test/storage.test.ts`) and the app's retry (`apps/app/test/errors.test.ts`).

- Issue #1009 (section 6): the store's holds with a mocked client (`packages/kernel-runtime/test/s3-store.test.ts`: GOVERNANCE on the recorded version, a longer or COMPLIANCE retention kept, the current version of an unpinned row only when its sha256 matches, a missing version, org/ keys only, Object Lock detection and GCS), against MinIO with an Object Lock bucket (`s3-store.integration.test.ts`: the retention set, never shortened, lengthened, a held version refused deletion, a plain delete still leaving the recorded version readable), the job on PostgreSQL through a real posting (`apps/kernel/test/evidence-hold.db.test.ts`: posted files held from the posting and unposted files never, a refusal recorded and retried after the backoff with the posting untouched, nothing recorded without Object Lock or on local disk, a longer period lengthening and a shorter one never shortening), the erasure result (`apps/kernel/test/personal-data.db.test.ts`) and the guard in the invariant suite (`apps/kernel/test/invariant/file-upload.db.test.ts`: only the system records a hold, never cleared or shortened).

## References

- AWS: [Browser-based uploads using POST (Signature Version 4)](https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-HTTPPOSTConstructPolicy.html), `content-length-range` condition
- AWS: [Retaining multiple versions of objects with S3 Versioning](https://docs.aws.amazon.com/AmazonS3/latest/userguide/Versioning.html); objects written while unversioned have the version id `null`
- AWS: [Locking objects with Object Lock](https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lock.html)
- Google Cloud: [Object versioning](https://cloud.google.com/storage/docs/object-versioning) and [generation numbers](https://cloud.google.com/storage/docs/metadata#generation-number)
