# GAM Platform — Cleanup & GCP Production Migration Plan

_Drafted 2026-08-27 from a full portability audit of the monorepo. Leadership briefing: https://claude.ai/code/artifact/26874d8f-6adb-42b3-83cb-178e18b25f63_

## Context

GAM's production backend today is a single Mac Studio: Express API (:4000, launchd `com.gam.api`, also the cron runner), Postgres 16 (`gam` + read-only `gam_properties` parcel corpus), a self-hosted Hermes LLM (MLX, :8080) and bge-large embeddings (:8081), all behind a Cloudflare Tunnel, with nightly pg_dump to a local dir + iCloud. Frontends deploy to Vercel, but only by hand from the operator's Mac (`deploy.sh` local prebuilt flow, because Vercel's remote build can't resolve the `@gam/shared` workspace package). The goal is a **full production migration to GCP**: backend on **Cloud Run + Cloud SQL**, self-hosted LLM/embeddings replaced with **hosted APIs**, frontends **staying on Vercel**. Prod stays on the Mac until cutover; the Mac becomes a dev box afterward.

## Audit findings (verified, ranked)

1. **File storage is local disk with no abstraction.** ~25 modules hardcode `path.join(process.cwd(), 'uploads', <subdir>)` (signed leases, tenant ID scans/PII, inspection media, receipts, avatars, business attachments…). DB rows store `/uploads/...` relative URLs; authed routes resolve them via `lib/fileServe.ts` + `lib/uploadPaths.ts` and `res.sendFile`. One cross-dir `fs.renameSync` in `jobs/leaseParser/resolveIntent.ts:451`.
2. **Scheduler is replica-hostile.** `schedulerInit()` runs unconditionally in `app.listen` (`apps/api/src/index.ts:418`): 69 `cron.schedule` calls + dynamic timezone crons (`jobs/timezoneCronManager.ts`). Money jobs take pg advisory locks; notification jobs don't (2 replicas = double emails). No SIGTERM handlers anywhere. Fire-and-forget in-process jobs (`services/autoFieldJobs.ts`, leaseParser `setTimeout`).
3. **Config is machine-bound.** `apps/api/src/db/index.ts:3` hardcodes `dotenv.config({path:'/Users/nicholasrhoades/gam/apps/api/.env'})` (CLI scripts depend on it). ~90 env vars read by the API are absent from `.env.example` (incl. `ENCRYPTION_KEY`, `BANK_ENCRYPTION_KEY`, `VAPID_*`, `STRIPE_CONNECT_WEBHOOK_SECRET`, `API_PUBLIC_URL`). No pg SSL config; `db/propertiesDb.ts` reuses main DB credentials.
4. **No container story.** No Dockerfile; Node version unpinned (launchd = 22, CI = 20); `playwright` is a prod dep used only by ingest scrapers; `pdfjs-dist` needs intact `node_modules`; `@napi-rs/canvas` prebuilts (avoid musl). Health check is a shallow `/health` with no DB probe. `db/migrate.ts` shells out to `pg_dump` post-migration (warn-only).
5. **Per-replica in-memory state:** express-rate-limit MemoryStore, agent LRU caches, turn-gate semaphore, LLM endpoint pool breakers, metrics ring buffer. `trust proxy = 1` tuned for exactly one cloudflared hop.
6. **Domains hardcoded:** `goldassetmanagement.com` / `gam.biz` suffix-matched in CORS (`index.ts:174-177`) and auth reset flow (`routes/auth.ts:795`); 12 frontends silently fall back to `http://localhost:4000` when `VITE_API_URL` is unset; Cloudflare tunnel config lives entirely outside the repo.
7. **DB:** extensions pgcrypto, uuid-ossp, pgvector — all supported by Cloud SQL. The checksummed migration runner (564 migrations at drafting; 795 files as of 2026-10-11; 980 as of 2026-10-29) is solid and should be reused as-is.
8. **LLM coupling:** client is generic OpenAI-compatible `fetch` but sends no `Authorization` header; agent routes 500 (not degrade) when LLM env unset; embeddings locked to 1024-dim `vector(1024)` (provider change at another dim ⇒ re-embed the knowledge store); second independent LLM config path in `services/autoFieldPlacement.ts`.
9. **Deploy/CI:** manual `deploy.sh` from the Mac; CI tests 2 of 16 apps, no lint. `apps/property-api` (:4001) appears orphaned (own lockfile, localhost-only CORS, in no deploy script) — confirm and delete or migrate deliberately.
10. **Webhooks** (Stripe raw-body, Resend/Svix, Checkr HMAC) all land on `api.goldassetmanagement.com` through the tunnel — must be re-pointed at cutover.

## Decisions (confirmed 2026-08-26/27)

- Full prod migration to GCP; Mac decommissioned as prod (kept as dev machine).
- Backend on Cloud Run + Cloud SQL for PostgreSQL.
- ~~LLM + embeddings move to hosted APIs.~~ **Superseded 2026-10-29 (Nic):** the LLM and embeddings servers stay on the Mac. The agent code moves with the API to Cloud Run and calls them over a locked-down tunnel hostname (see A4).
- Frontends remain on Vercel.
- ~~**AI privacy rule override.**~~ **Withdrawn 2026-10-29:** the hard rule "no third-party AI API, no tenant data leaving GAM-controlled hardware" (`apps/api/src/services/agents/config.ts` header) stands. No DeepInfra, no DPA, no policy rewrite. Nic (10/29, on licence OCR): GAM's GCP compute counts as GAM's own server, so in-process work there (e.g. local OCR) does not breach the rule; third-party AI processors still do.
- Region: **us-west1**. Project `golddoor-gam` (org golddoor.io), billing linked, APIs enabled 2026-10-29.

## Status & re-assessment (2026-10-11)

Re-checked after merging 442 commits of `main` (S637–S655, through 10/11) into `gcp-migration`. **The plan still holds** — target architecture and phases are unchanged. What moved:

- **Done on `gcp-migration`:** A1 storage seam (all writers incl. those added on main since), A2 scheduler gate + SIGTERM, A3 portable config (dotenv path, `DATABASE_URL`/socket, `PROPERTIES_DB_*`, `TRUST_PROXY_HOPS`), A4 hosted-LLM `Authorization` headers, A5 Cloud Run warning. **Not yet:** `/health/ready`, A4 route-level 503 + policy docs, A6, Phase B–E.
- **Merged & fixed during the merge:** five new disk writers from main (bank-deposit receipt photos, tenant declared-deposit receipt photos, utility meter photos, sleeve/disclosure detection, two lease scripts) now go through the storage driver.
- **Logging (new since the plan):** S652 moved prod logs to daily files under `~/Library/Logs/gam`. On Cloud Run (`K_SERVICE`) or `LOG_TO_STDOUT=1` they now go to stdout as JSON with a Cloud Logging `severity`. The Phase C log-based alerts depend on this.
- **Scheduler flags:** main added `GAM_DISABLE_SCHEDULER=1` (S650 demo instance). Crons run unless `RUN_SCHEDULER=0` **or** `GAM_DISABLE_SCHEDULER=1`. `gam-api` sets `RUN_SCHEDULER=0`; `gam-scheduler` sets neither.
- **Crons grew 74 → 95** (all in `jobs/scheduler.ts`). Advisory locks grew 22 → 71 across the API, but the A2 item "lock every notification job" must be re-audited against the new jobs before the Mac/GCP overlap.
- **Migrations:** 186 new since the plan; use `migrate --status` (all applied, zero checksum mismatches) as the cutover check, never a fixed count. New `apps/api/src/db/post-deploy/` holds **manual contract steps** run after a deploy is live — not by the migrate job. The cutover runbook must list any pending ones.
- **New integrations/env:** Column bank (`COLUMN_API_KEY/BASE/AUTH_STYLE`, read-only, dormant without a key — confirm whether Column needs a fixed egress IP; if so, Cloud NAT + static IP is required and the "no VPC connector" rule changes). `LOG_DIR`, `LOG_TO_STDOUT`, `AGENT_PRERUN_LOOKUPS`.
- **Image contents:** `services/flexsuiteAcceptance.ts` reads repo-root `legal/*.md` at runtime — the Dockerfile must ship `legal/`.
- **Mac-only one-off scripts** (`scripts/disclosures/fixMountainViewLeases.ts`, `stockLibrary.ts`, `scripts/mattoon/load9_*`) still write to `uploads/leases` directly; since 10/12 the Campground Master import (`src/scripts/importCampgroundMasterCustomers.ts`) also reads a CSV from a Mac path. They are historical imports; port them before re-running any against GCP.
- **Admin health panel** (`services/platformHealth.ts`) now also checks Cloudflare tunnel, Vercel and `~/gam-backups` — part of the Phase E cleanup.

## Status & re-assessment (2026-10-29)

Re-checked after merging 115 commits of `main` (10/12–10/27, S656–S658) into `gcp-migration`. **The plan still holds.** Only two files conflicted (`routes/expenses.ts`, `routes/utility.ts`, both resolved to main's behavior over our storage calls). What moved:

- **Two new disk paths around the storage seam — fixed in the merge:** proof-of-income uploads (`routes/background.ts`, `income-documents/`, PII) now go memory → `storage.save`, served via `sendStoredFile`; orphaned-document cleanup (`lib/eraseUnfinishedDocument.ts` `removeOrphanedDocumentFiles`) now uses `storage.exists`/`remove` (takes a driver, defaulting to the live one). The remaining `multer.diskStorage` uses (walkthrough/inspection/maintenance video) are the intended temp-dir staging.
- **Third pg pool:** `db/ledgerPool.ts` (`ledgerDb`, GAM Books ledger) copies the main pool's options, so it follows `DATABASE_URL`/socket config with no change. `LEDGER_DB_POOL_MAX` (default 4) is in `.env.example`; the SIGTERM handler now ends it too. Connection budget per service: main 20 + ledger 4 + properties.
- **Crons:** 97 in `jobs/scheduler.ts`, plus `services/ledgerJobs.ts` (every-minute ledger drain behind an advisory lock; nightly 04:40/05:10), `jobs/monthlyPropertyReportEmail.ts` and the timezone manager. The shutdown loop stops all of them (`cron.getTasks()`). The ledger "after-commit kick" runs in request handlers on `gam-api` regardless of `RUN_SCHEDULER`. That's safe because the drain picks up anything a kick drops. New since 10/11: carryforward (04:35), birthday emails (09:15, deduped by `ON CONFLICT`), occupancy-nights (hourly), `revealTodaysSites` (every 15 min, no cron timezone but computes per-property local dates — TZ-safe on UTC), e-sign draft expiry (02:20). Advisory-lock call sites: 156. The A2 notification-lock re-audit still applies.
- **Image contents:** the API now reads `apps/api/geo/` (419 files, 16.7 MB), `apps/api/census/` and `apps/api/elections/` at runtime (`path.resolve(__dirname,'../../geo')` etc. in `services/platformMetricsGeo.ts`, `platformCensus.ts`, `platformElections.ts`). B1 updated.
- **Frontends:** `apps/books` is a Vercel project; `apps/pm-company` is now a one-page door to the landlord portal (PM_FOLD_PLAN) but still deploys so the subdomain answers. `deploy.sh` ships landlord, tenant, admin, pm-company, pos, admin-ops, books + marketing + storefront. B3 updated.
- **deploy.sh (10/17):** shared builds first; the API suite runs on `GAM_TEST_WORKERS` (default 6), each worker on its own test-DB copy and cwd (`src/test/testWorkers.ts`), beside the tenant/landlord/pos suites and all builds; a failed API step skips every frontend. B3 updated.
- **Client IP is now stored data:** payments record the request's IP/device (63aeecd3) and every request log line carries `ip`. `TRUST_PROXY_HOPS` behind the ALB is therefore a data-correctness setting, not just rate-limit tuning. Cutover verification updated.
- **Logging:** main added path redaction for invitation tokens (`redactLoggedUrl`) and the req serializers; merged cleanly with the stdout/`severity` mode.
- **Mac-only one-offs added:** the Campground Master customer import (reads `~/gam-imports/…`) and pre-deploy snapshots in `~/gam-backups/` (the one-time 10/13–10/14 erase scripts go through the storage driver). `ledger:rebuild` / `ledger:check` are ongoing ops commands — after cutover run them as a `gam-migrate`-style Cloud Run job execution with an overridden command.
- **Coming from Nic's working tree (uncommitted as of 10/29):** the guest-licence identity layer writes to a new `uploads/guest-licences/` — convert it to `storage.save` when it lands (or write it against the driver once this branch is on main). Its readers (tesseract.js 5.1.1, jimp 0.22.12, @zxing/library 0.21.3) are pure JS, so no native build in the image — but tesseract.js downloads its `traineddata` from a CDN at first use unless `langPath` points at a local copy: ship the language data in the image so OCR has no runtime network dependency. Four of its migrations are already applied on production.
- **Migrations:** 185 new (980 files). No new `db/post-deploy/` steps. No new integrations or env vars beyond `LEDGER_DB_POOL_MAX`.

## Target architecture

Cloud Run (`gam-api` + `gam-scheduler` from one image, plus `gam-storefront` and a `gam-migrate` job) + Cloud SQL for PostgreSQL 16 (databases `gam` + `gam_properties` on one instance) + GCS for uploads + Secret Manager, fronted by a Global External ALB for `api.goldassetmanagement.com` and wildcard `*.gam.biz` (Cloud Run domain mappings don't support wildcards). Cloudflare stays as DNS (grey-cloud to the LB IP). LLM/embeddings **stay on the Mac** (MLX Hermes :8080, bge-large :8081), published as tunnel hostnames behind Cloudflare Access (service token); `gam-api` reaches them over HTTPS. Same model and vectors, so no re-embedding. The Mac remains a production dependency for agent features only — when it is down, the assistant answers 503 "unavailable" and nothing else is affected. Frontends stay on Vercel; builds move into GitHub Actions.

Each phase ships independently; the Mac stays production until the Phase D cutover.

## Phase A — Code cleanup (12-factor; every change backward-compatible on the Mac)

### A1. Storage abstraction (largest task)
New `apps/api/src/lib/storage.ts` with a driver interface (`save`, `stream`, `exists`, `delete`, `move`) keyed by `STORAGE_DRIVER=local|gcs`. The storage key is exactly the stored DB string minus the `/uploads/` prefix — DB rows keep their `/uploads/<subdir>/<file>` strings unchanged (they become opaque keys), so **no URL-column data migration**, and the Mac keeps working with the `local` driver rooted at `UPLOADS_ROOT` (default `process.cwd()/uploads`).
- Local driver = current behavior incl. the traversal guard from `lib/fileServe.ts`; GCS driver = `@google-cloud/storage` with ADC, bucket `GCS_UPLOADS_BUCKET`.
- **Keep authed streaming, not signed URLs**: `streamStoredFile()` in `lib/fileServe.ts:34` becomes driver-backed (resolve key → `driver.stream` → pipe). All reads already flow through per-file authorized routes; signed URLs would touch every frontend for no current benefit.
- Write-path refactor (~25 modules): inventory via `grep -rn "process.cwd(), *'uploads'" apps/api/src` + `grep -rn multer apps/api/src/routes`; switch multer to `memoryStorage()` + `storage.save(key, buffer)`; direct `fs.writeFileSync` writers → `storage.save`; `jobs/leaseParser/resolveIntent.ts:451` `fs.renameSync` → `storage.move`; converge all readers on `fileServe.ts`.
- Verification: full API suite against `local` driver (identical behavior); a driver contract test run against both drivers (`fake-gcs-server` or a dev bucket); manual smoke of upload+download for lease, ID doc, inspection photo.

### A2. Scheduler gating + graceful shutdown
- Gate: `if (process.env.RUN_SCHEDULER === '1') schedulerInit()` at `apps/api/src/index.ts:418`; add `RUN_SCHEDULER=1` to the Mac launchd env so nothing changes. **Do not** convert the 69 crons + dynamic timezone crons (`jobs/timezoneCronManager.ts`) to Cloud Scheduler — the scheduler runs as a second Cloud Run service (same image, min=max=1, CPU always allocated, internal ingress).
- SIGTERM/SIGINT: `server.close()`, stop all crons (add `schedulerStop()`), `pool.end()` on both pools, exit with timeout backstop. (Zero handlers exist today.)
- Add advisory locks to notification jobs (money jobs already have them) — protects the Mac↔GCP overlap window; hard runbook rule: exactly one `RUN_SCHEDULER=1` anywhere.
- Add `GET /health/ready` doing `SELECT 1` (Cloud Run startup probe); keep shallow `/health` for liveness.
- Verification: boot without `RUN_SCHEDULER` → zero cron registrations; SIGTERM under load → in-flight request completes, clean exit.

### A3. Env/config consolidation
- `apps/api/src/db/index.ts:3`: replace the hardcoded `/Users/nicholasrhoades/...` dotenv path with `path.resolve(__dirname, '../../.env')` (env vars always win; CLI scripts keep working).
- Both pools: support `DATABASE_URL` / Cloud SQL unix socket (`host=/cloudsql/PROJECT:REGION:INSTANCE` — no SSL config or connector lib needed). `db/propertiesDb.ts`: add `PROPERTIES_DB_*` vars falling back to main vars.
- Complete env manifest: grep `process.env\.` across `apps/api/src`, document all ~90 missing vars in `.env.example`; expand `validateEnv()` (now `lib/validateEnv.ts`, which main extended for the gam_demo instance) to hard-fail in production on security-critical vars (ENCRYPTION_KEY, BANK_ENCRYPTION_KEY, JWT_SECRET, DB) and warn on optional ones.
- `trust proxy` → `Number(process.env.TRUST_PROXY_HOPS ?? 1)` (`index.ts:257`); tune during cutover verification.
- Pin Node 22: root `engines` + `.nvmrc`; bump CI from Node 20.

### A4. LLM/embeddings → Mac servers reached from Cloud Run (revised 2026-10-29)
- Done: optional `Authorization: Bearer` headers in `services/agents/engine.ts`, `embeddings.ts` and `services/autoFieldPlacement.ts`. **To do:** also send Cloudflare Access service-token headers (`CF-Access-Client-Id` / `CF-Access-Client-Secret`, from Secret Manager) on those three paths; endpoints swap via existing `LLM_ENDPOINTS`/`EMBEDDINGS_ENDPOINTS` to e.g. `https://llm.<internal>.goldassetmanagement.com/v1`.
- Cloudflare: two tunnel ingress hostnames for :8080/:8081, an Access application requiring the service token (no public reach). Keep timeouts generous — the endpoint pool's breaker already handles a slow or absent Mac.
- Graceful degradation: agent routes currently 500 when `getLlmConfig()` throws (`services/agents/config.ts:26,56`) — catch "not set" at the route layer, return 503 "assistant unavailable".
- Remove `/Users/nicholasrhoades/models` defaults (`services/autoFieldPlacement.ts:43`, `services/agents/agentBattery.ts:54`, `apps/api/package.json:15`).
- No policy change (the no-third-party-AI rule stands). Update the config.ts header only to say the API may run in GAM's cloud while the models stay on GAM's Mac.
- Verification: from staging Cloud Run, `agents:eval` against the tunnel hostnames; stop the MLX server and confirm agent routes return 503 within the breaker window while payments/files are unaffected.

### A5. Per-replica in-memory state — accept it, pin `max-instances=1`
express-rate-limit MemoryStore, agent caches, turnGate, endpointPool, metrics ring buffer all stay in-memory. At current scale one instance handles everything; Memorystore Redis (≥$35/mo + VPC connector) buys nothing yet. Add a startup warning when running on Cloud Run (`K_SERVICE` set) without a shared store; revisit only when scaling out.

### A6. Small cleanups
- 12 frontends: make a missing `VITE_API_URL` **fail the production build** instead of silently falling back to `http://localhost:4000` (e.g. `apps/landlord/src/lib/api.ts:5` and equivalents; keep localhost fallback in dev).
- `apps/property-api`: confirm orphaned with the operator → delete (don't migrate a dead app).
- Hardcoded domain suffixes (CORS `index.ts:174-177`, `routes/auth.ts:795`): domains aren't changing; leave (optionally lift to env).

## Phase B — Containerize + CI/CD

### B1. Dockerfile (repo root, multi-stage)
- Base `node:22-bookworm-slim` (glibc required for `@napi-rs/canvas` prebuilts — never alpine). Stage 1: workspace-aware `npm ci` with `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`, build shared then api (`tsc -b`). Stage 2: `npm ci --omit=dev`, copy `apps/api/dist`, `packages/shared/dist`+package.json, **`apps/api/src/db/migrations/`** (runner reads files from disk), **repo-root `legal/`** (FlexPay/FlexDeposit terms read at runtime) **and `apps/api/geo/`, `census/`, `elections/`** (admin metrics map/overlay data, ~17.5 MB, resolved relative to `dist/`). No bundling/pruning tools — `pdfjs-dist` needs intact `node_modules` (`lib/pdfText.ts:71-80`).
- Move `playwright` deps→devDeps in `apps/api/package.json` (only db/ingest scrapers use it; verify with grep).
- Migrations: keep `ts-node` + `typescript` as prod deps, run job as `node -r ts-node/register src/db/migrate.ts` (ship `src/` + tsconfig in image). The `dump-schema.sh` post-migration hook is warn-only — let it warn, or gate with `SKIP_SCHEMA_DUMP=1`.
- Verification: build + run against local docker-compose Postgres; hit `/health/ready`; exercise a PDF-generation route (canvas + pdfjs in-container); apply every migration to a scratch DB from the image.

### B2. Migration-at-deploy
Cloud Run **Job** `gam-migrate` executed by CD before rollout (clean logs, retries; runner is already transactional + checksummed). Order: build → push → migrate job (fail = abort) → deploy api → deploy scheduler.

### B3. GitHub Actions CI/CD
- `deploy.yml` (push to main): Workload Identity Federation (no key files), build+push to Artifact Registry, run migrate job, `gcloud run deploy` both services. Secrets live in Secret Manager, referenced by services.
- Vercel: **keep the prebuilt flow but move it into CI** — a matrix job over the `deploy.sh` FRONTENDS list {landlord, tenant, admin, pm-company, pos, admin-ops, books} plus marketing (its own `node build.js` packaging): `npm ci` → build shared → `vercel build` → `vercel deploy --prebuilt --prod`. CI has the full monorepo checkout, which is exactly why local prebuilt works today. This retires `deploy.sh`'s Mac dependency.
- CI expansion (`.github/workflows/ci.yml`): Node 22; build `@gam/shared` first, then in parallel the API suite with `GAM_TEST_WORKERS` (the Postgres role needs CREATEDB for the per-worker DB copies), the tenant/landlord/pos/admin vitest suites, and typecheck + `vite build` of all deployed frontends; run the existing `lint:hooks`; switch the service container to `pgvector/pgvector:pg16`. Mirror deploy.sh's rule: nothing deploys unless every suite is green.

## Phase C — GCP infrastructure

IaC: **checked-in gcloud scripts + runbook in `deploy/gcp/`, not Terraform** (~15 set-once resources, solo operator — state management costs more than it buys). Single project, one region (e.g. `us-east4`).

| Resource | Spec |
|---|---|
| Cloud SQL | Postgres 16, `db-custom-2-8192` (default `max_connections` covers 2 services × (main 20 + ledger 4 + properties) + migrate job + headroom), 100GB SSD, automated backups + PITR. Databases `gam` + `gam_properties`; extensions pgcrypto, uuid-ossp, vector; read-only role for `gam_properties`. Downsize after observing load. |
| GCS `gam-uploads-prod` | Uniform access, no public access, versioning + 30-day soft delete (ID-document PII lives here; access only via the API service account). |
| Cloud Run `gam-api` | 1 vCPU/1GB, **min=1, max=1**, startup probe `/health/ready`, Cloud SQL attached; SA roles: cloudsql.client, storage.objectAdmin (bucket-scoped), secretAccessor. |
| Cloud Run `gam-scheduler` | Same image, `RUN_SCHEDULER=1`, min=max=1, CPU always allocated, internal ingress. |
| Cloud Run Job `gam-migrate` | Same image, migrate entrypoint. |
| Cloud Run `gam-storefront` | Small container serving the Host-header static storefront (`apps/storefront/server.js` + dist). |
| Secret Manager | One secret per sensitive var. |
| Global external ALB + serverless NEGs | Host rules: `api.goldassetmanagement.com` → gam-api; `*.gam.biz` → gam-storefront. Certificate Manager wildcard cert for `*.gam.biz` via DNS authorization. Cloudflare stays DNS, grey-cloud records to the LB IP. |
| Monitoring | Uptime check on `/health`; alerts: 5xx rate, scheduler restart loops, Cloud SQL disk/CPU; log-based alert on money-job failures. |

Deliberately not used: Memorystore, Cloud Scheduler, DMS, VPC connector.

Verification = a **staging pass that becomes prod**: restore recent dumps into Cloud SQL, sync sample uploads, point a Vercel preview at the Cloud Run URL, full manual smoke (login, lease upload/download, Stripe test payment, agent chat, storefront via Host header).

## Phase D — Data migration + cutover

Pre-cutover (no window needed):
1. `gam_properties` (read-only, 3.4M rows): one-shot `pg_dump -Fc` → `pg_restore -j4`; verify row counts + index queries.
2. Uploads: `gcloud storage rsync -r` bulk, then daily incremental until cutover; verify object count/bytes + spot-download 10 files across subdirs through staging's authed routes.
3. Embeddings: no action (same servers, same vectors).
4. Rehearse the cutover against staging, timed; target < 30 min.

Cutover window (evening, landlords notified):
5. launchd-unload Mac API + scheduler (freezes writes; Postgres stays up).
6. Final `pg_dump -Fc gam` → restore; `migrate --status` from the image must show all-applied, zero checksum mismatches; sanity counts (users, leases, latest invoice) match the Mac.
7. Final uploads rsync.
8. Flip Cloudflare DNS (low TTL pre-set): `api.goldassetmanagement.com` + `*.gam.biz` → LB IP. Enable the scheduler service.
9. Webhooks (Stripe/Resend/Checkr): hostname unchanged, so URLs + signing secrets carry over — **verify, don't re-point**: send test events from each dashboard, confirm 200 + signature pass in Cloud Run logs. Audit the three dashboards beforehand for any tunnel-specific URLs.
10. Smoke: each portal login, a tenant payment (confirm the payment row's recorded IP is the client's, not the ALB's — fix `TRUST_PROXY_HOPS` before reopening), file download, agent chat, a real `*.gam.biz` subdomain, a push notification (VAPID keys carried over).

Rollback (any failure): repoint DNS to the tunnel, launchd-load the Mac stack (DB was frozen at step 5, so no divergence unless traffic reached Cloud SQL — tiny user base makes manual reconciliation feasible). Keep the Mac stack startable 2–4 weeks.

Backups: Cloud SQL automated daily (retain 14) + 7-day PITR; retire the pg_dump→iCloud job; optional weekly `gcloud sql export` to a `gam-db-exports` bucket, 90-day lifecycle.

## Phase E — Decommission + hardening

- After 2–4 quiet weeks, turn off on the Mac: `com.gam.api`, marketing fallback, storefront server, the API/storefront tunnel routes, watchdog/start-launch-set jobs for the retired services, backup cron. **Keep running:** MLX LLM (:8080), embeddings (:8081) and a tunnel carrying only their two Access-protected hostnames (plus the watchdog for those). Keep local Postgres + repo as the dev box. Archive one final dump + uploads tarball, then **delete prod PII from the Mac** (`uploads/id-documents` especially).
- Admin infra-readiness panel (`routes/admin.ts:516`, `lib/apiMetrics.ts`): `os.loadavg` is meaningless on Cloud Run — strip the host-metrics section, keep the request-latency p95, link out to Cloud Run metrics.
- Rough cost at current scale: Cloud SQL ~$100 (→~$55 downsized), Cloud Run ~$15–30, ALB ~$20, GCS/secrets/registry ~$5 ≈ **$115–155/mo** (LLM stays on the Mac).

## Sequencing & top risks

A1–A6 as parallel PRs (A4 can go live on the Mac immediately) → B → C staging → D rehearsal → D cutover → E after soak.

1. A missed hardcoded uploads path → 404 post-cutover. Mitigation: grep inventory as checklist + staging smoke of every file type.
2. Scheduler double-run during Mac/GCP overlap. Mitigation: "exactly one `RUN_SCHEDULER=1`" runbook rule + advisory locks on notification jobs.
3. Agent features depend on the Mac's uptime and home connection after cutover. Mitigation: graceful 503 (A4), breaker in the endpoint pool, an uptime check on the Access-protected LLM hostname.

## Workstream: money-flow audit & held-balance visibility (added 2026-09-06)

Prompted by rent card payments appearing to "pile up" in the main Stripe account. A full code audit confirmed the S560 platform-holds design is working as intended (rent lands on the platform balance, batched out via `jobs/autoPayouts.ts` on 50%/90% rent-roll triggers + a late-month sweep; cash payments count toward the triggers but are correctly never disbursed). The real gap is **visibility**: the landlord portal's balance reads the live Stripe Connect balance, which is structurally ~$0 under platform-holds, and nothing anywhere shows "GAM is holding $X, next payout ~date".

Work items (branch `money-flow-visibility`):
1. `GET /me/finances` (`apps/api/src/routes/finances.ts`): add `held_balance` (sum of unfired `allocation_owner_share` rows joined to `payments.platform_held=TRUE AND status='settled'` — the same query the RESERVE step uses in `services/landlordPassthrough.ts`) and `next_payout` (earliest unfired `payout_triggers` row for the user).
2. Landlord portal: show "Held by GAM" + next-payout date on the Finances/Disbursements surfaces.
3. Verification runbook for prod (Nic's Mac): job liveness, held totals vs platform balance, Connect readiness per landlord, stuck `platform_transfer_intents`, missed webhooks — shipped as a read-only SQL script under `scripts/`.
4. Follow-ups from the audit (separate): legacy `routes/terminal.ts` creates platform card_present PIs with no disbursement path (verify unreachable, then delete); business payouts unrecorded in `connect_payouts`; missing `application_fee_amount` on public-customer-portal and recurring off-session invoice charges; stale money-flow comments in `lib/stripe.ts`, `routes/bankAccounts.ts`, `services/connectPayouts.ts`.

## Needed from the Mac (Nic) — 2026-10-11

Send secrets through a password manager / encrypted share, never chat or email.

**Shortcut:** `bash scripts/gcp-handoff-bundle.sh` on the Mac collects items 1–3 into one AES-256 encrypted `.dmg` on the Desktop (read-only on prod; add `--with-uploads` to include the files themselves). Items 4–5 still need Nic.

**1. The production `apps/api/.env`, whole file** — the simplest way to get every value below. The ones that must carry over *exactly*:
- `ENCRYPTION_KEY`, `BANK_ENCRYPTION_KEY` — encrypted columns (bank details, PII) are unreadable forever without the same keys.
- `JWT_SECRET` — a new value logs everyone out.
- `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` — new keys break every existing push subscription.
- Stripe: `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_CONNECT_WEBHOOK_SECRET`.
- `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`; `CHECKR_API_KEY`, `CHECKR_WEBHOOK_SECRET`; `SENTRY_DSN`.
- If set: `COLUMN_API_KEY`, `CREDIT_LENDING_SERVICE_TOKEN`, `NY_OPENLEG_KEY`, `CLOUDFLARE_API_TOKEN`, `VERCEL_TOKEN`, `GEOCODER_URL`/`OSRM_URL` (if they point at local services).

**2. Data**
- `pg_dump -Fc gam` now (for the staging rehearsal); final dump at cutover.
- `pg_dump -Fc gam_properties` (one-shot, read-only corpus).
- Is `gam_demo` / the demo API instance (S650) served publicly? If yes, it migrates too; if not, it stays on the Mac.
- `uploads/`: `du -sh uploads/*` and `find uploads -type f | wc -l` first (sizing), then an rsync/tarball path for the bulk copy.
- Output of `SELECT version();`, `\dx` and `\du` (Postgres version, extensions, roles incl. the read-only `gam_properties` role).

**3. What is actually running**
- `git -C ~/gam rev-parse HEAD` and `git -C ~/gam status` — prod must be running committed code, or we'll migrate the wrong thing.
- `launchctl list | grep com.gam`, `ls ~/Library/LaunchAgents/com.gam.*`, `crontab -l`, `node -v`.
- `~/.cloudflared/config.yml` (or the tunnel's ingress rules in the Cloudflare dashboard) — the full list of hostnames the tunnel serves.
- The model actually served for chat (`LLM_MODEL`, MLX model directory) and embeddings (`EMBEDDINGS_MODEL`) — they stay; needed for the tunnel hostnames.
- Is `apps/property-api` (:4001) running or used anywhere? (A6: delete if not.)

**4. Access**
- Cloudflare account (DNS for `goldassetmanagement.com` and `gam.biz`, tunnel).
- Stripe (platform + Connect webhook endpoints), Resend and Checkr dashboards — to verify webhook URLs and send test events at cutover.
- Vercel team (projects + their env vars, e.g. `VITE_API_URL`).
- GCP: billing account and project owner.

**5. Decisions**
- A cutover evening, and who notifies landlords.

## Critical files

- `apps/api/src/lib/fileServe.ts` (+ new `lib/storage.ts`) — storage seam
- `apps/api/src/index.ts` — scheduler gate, SIGTERM, trust proxy, `/health/ready`
- `apps/api/src/db/index.ts` + `db/propertiesDb.ts` — dotenv path, DATABASE_URL/socket
- `apps/api/src/services/agents/config.ts`, `engine.ts`, `embeddings.ts`, `services/autoFieldPlacement.ts` — hosted-LLM auth + degradation
- `apps/api/src/db/migrate.ts` — reused as the Cloud Run migrate job
- New: root `Dockerfile`, `.github/workflows/deploy.yml`, `deploy/gcp/` scripts
