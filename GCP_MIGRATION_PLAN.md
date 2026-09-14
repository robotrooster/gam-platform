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
7. **DB:** extensions pgcrypto, uuid-ossp, pgvector — all supported by Cloud SQL. The checksummed migration runner (564 migrations) is solid and should be reused as-is.
8. **LLM coupling:** client is generic OpenAI-compatible `fetch` but sends no `Authorization` header; agent routes 500 (not degrade) when LLM env unset; embeddings locked to 1024-dim `vector(1024)` (provider change at another dim ⇒ re-embed the knowledge store); second independent LLM config path in `services/autoFieldPlacement.ts`.
9. **Deploy/CI:** manual `deploy.sh` from the Mac; CI tests 2 of 16 apps, no lint. `apps/property-api` (:4001) appears orphaned (own lockfile, localhost-only CORS, in no deploy script) — confirm and delete or migrate deliberately.
10. **Webhooks** (Stripe raw-body, Resend/Svix, Checkr HMAC) all land on `api.goldassetmanagement.com` through the tunnel — must be re-pointed at cutover.

## Decisions (confirmed 2026-08-26/27)

- Full prod migration to GCP; Mac decommissioned as prod (kept as dev machine).
- Backend on Cloud Run + Cloud SQL for PostgreSQL.
- LLM + embeddings move to hosted APIs.
- Frontends remain on Vercel.
- **AI privacy rule override:** the documented hard rule "no third-party AI API, no tenant data leaving GAM-controlled hardware" (`apps/api/src/services/agents/config.ts` header) is deliberately overridden. The plan includes updating that documentation, reviewing tenant-facing privacy disclosures, and signing a vendor DPA.

## Target architecture

Cloud Run (`gam-api` + `gam-scheduler` from one image, plus `gam-storefront` and a `gam-migrate` job) + Cloud SQL for PostgreSQL 16 (databases `gam` + `gam_properties` on one instance) + GCS for uploads + Secret Manager, fronted by a Global External ALB for `api.goldassetmanagement.com` and wildcard `*.gam.biz` (Cloud Run domain mappings don't support wildcards). Cloudflare stays as DNS (grey-cloud to the LB IP). LLM/embeddings → **DeepInfra** (OpenAI-compatible; hosts `BAAI/bge-large-en-v1.5` — the exact current embedding model, same 1024-dim vectors, **no re-embedding required**; Hermes-family chat models available. Fallback vendor: Together AI). Frontends stay on Vercel; builds move into GitHub Actions.

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
- Complete env manifest: grep `process.env\.` across `apps/api/src`, document all ~90 missing vars in `.env.example`; expand `validateEnv()` (`index.ts:126`) to hard-fail in production on security-critical vars (ENCRYPTION_KEY, BANK_ENCRYPTION_KEY, JWT_SECRET, DB) and warn on optional ones.
- `trust proxy` → `Number(process.env.TRUST_PROXY_HOPS ?? 1)` (`index.ts:257`); tune during cutover verification.
- Pin Node 22: root `engines` + `.nvmrc`; bump CI from Node 20.

### A4. LLM/embeddings → hosted API (DeepInfra)
- Add `Authorization: Bearer ${LLM_API_KEY}` / `${EMBEDDINGS_API_KEY}` when set, in `services/agents/engine.ts:148-170`, `services/agents/embeddings.ts:35-58`, and the separate `services/autoFieldPlacement.ts:41-50` config path (no header today). Config-only endpoint swap via existing `LLM_ENDPOINTS`/`EMBEDDINGS_ENDPOINTS`.
- Graceful degradation: agent routes currently 500 when `getLlmConfig()` throws (`services/agents/config.ts:26,56`) — catch "not set" at the route layer, return 503 "assistant unavailable".
- Remove `/Users/nicholasrhoades/models` defaults (`services/autoFieldPlacement.ts:43`, `services/agents/agentBattery.ts:54`, `apps/api/package.json:15`).
- **Policy updates in the same PR**: rewrite the config.ts header rule + CLAUDE.md; review `legal/` privacy disclosures re: third-party AI processing of tenant data; sign vendor DPA.
- Verification: run the `agents:eval` battery against DeepInfra; embed known knowledge-store chunks via DeepInfra and confirm cosine ≈ 1.0 vs stored vectors (proves no re-embed). **Recommended: flip the Mac's prod to DeepInfra during Phase A** — decouples LLM risk from infra risk.

### A5. Per-replica in-memory state — accept it, pin `max-instances=1`
express-rate-limit MemoryStore, agent caches, turnGate, endpointPool, metrics ring buffer all stay in-memory. At current scale one instance handles everything; Memorystore Redis (≥$35/mo + VPC connector) buys nothing yet. Add a startup warning when running on Cloud Run (`K_SERVICE` set) without a shared store; revisit only when scaling out.

### A6. Small cleanups
- 12 frontends: make a missing `VITE_API_URL` **fail the production build** instead of silently falling back to `http://localhost:4000` (e.g. `apps/landlord/src/lib/api.ts:5` and equivalents; keep localhost fallback in dev).
- `apps/property-api`: confirm orphaned with the operator → delete (don't migrate a dead app).
- Hardcoded domain suffixes (CORS `index.ts:174-177`, `routes/auth.ts:795`): domains aren't changing; leave (optionally lift to env).

## Phase B — Containerize + CI/CD

### B1. Dockerfile (repo root, multi-stage)
- Base `node:22-bookworm-slim` (glibc required for `@napi-rs/canvas` prebuilts — never alpine). Stage 1: workspace-aware `npm ci` with `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`, build shared then api (`tsc -b`). Stage 2: `npm ci --omit=dev`, copy `apps/api/dist`, `packages/shared/dist`+package.json, **and `apps/api/src/db/migrations/`** (runner reads files from disk). No bundling/pruning tools — `pdfjs-dist` needs intact `node_modules` (`lib/pdfText.ts:71-80`).
- Move `playwright` deps→devDeps in `apps/api/package.json` (only db/ingest scrapers use it; verify with grep).
- Migrations: keep `ts-node` + `typescript` as prod deps, run job as `node -r ts-node/register src/db/migrate.ts` (ship `src/` + tsconfig in image). The `dump-schema.sh` post-migration hook is warn-only — let it warn, or gate with `SKIP_SCHEMA_DUMP=1`.
- Verification: build + run against local docker-compose Postgres; hit `/health/ready`; exercise a PDF-generation route (canvas + pdfjs in-container); apply all 564 migrations to a scratch DB from the image.

### B2. Migration-at-deploy
Cloud Run **Job** `gam-migrate` executed by CD before rollout (clean logs, retries; runner is already transactional + checksummed). Order: build → push → migrate job (fail = abort) → deploy api → deploy scheduler.

### B3. GitHub Actions CI/CD
- `deploy.yml` (push to main): Workload Identity Federation (no key files), build+push to Artifact Registry, run migrate job, `gcloud run deploy` both services. Secrets live in Secret Manager, referenced by services.
- Vercel: **keep the prebuilt flow but move it into CI** — a matrix job over {landlord, tenant, admin, pm-company, marketing}: `npm ci` → build shared → `vercel build` → `vercel deploy --prebuilt --prod`. CI has the full monorepo checkout, which is exactly why local prebuilt works today. This retires `deploy.sh`'s Mac dependency.
- CI expansion (`.github/workflows/ci.yml`): Node 22; typecheck + `vite build` all deployed frontends; run the existing `lint:hooks`; switch the service container to `pgvector/pgvector:pg16`.

## Phase C — GCP infrastructure

IaC: **checked-in gcloud scripts + runbook in `deploy/gcp/`, not Terraform** (~15 set-once resources, solo operator — state management costs more than it buys). Single project, one region (e.g. `us-east4`).

| Resource | Spec |
|---|---|
| Cloud SQL | Postgres 16, `db-custom-2-8192`, 100GB SSD, automated backups + PITR. Databases `gam` + `gam_properties`; extensions pgcrypto, uuid-ossp, vector; read-only role for `gam_properties`. Downsize after observing load. |
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
3. Embeddings: no action (same model hosted).
4. Rehearse the cutover against staging, timed; target < 30 min.

Cutover window (evening, landlords notified):
5. launchd-unload Mac API + scheduler (freezes writes; Postgres stays up).
6. Final `pg_dump -Fc gam` → restore; `migrate --status` from the image must show all-applied, zero checksum mismatches; sanity counts (users, leases, latest invoice) match the Mac.
7. Final uploads rsync.
8. Flip Cloudflare DNS (low TTL pre-set): `api.goldassetmanagement.com` + `*.gam.biz` → LB IP. Enable the scheduler service.
9. Webhooks (Stripe/Resend/Checkr): hostname unchanged, so URLs + signing secrets carry over — **verify, don't re-point**: send test events from each dashboard, confirm 200 + signature pass in Cloud Run logs. Audit the three dashboards beforehand for any tunnel-specific URLs.
10. Smoke: each portal login, a tenant payment, file download, agent chat, a real `*.gam.biz` subdomain, a push notification (VAPID keys carried over).

Rollback (any failure): repoint DNS to the tunnel, launchd-load the Mac stack (DB was frozen at step 5, so no divergence unless traffic reached Cloud SQL — tiny user base makes manual reconciliation feasible). Keep the Mac stack startable 2–4 weeks.

Backups: Cloud SQL automated daily (retain 14) + 7-day PITR; retire the pg_dump→iCloud job; optional weekly `gcloud sql export` to a `gam-db-exports` bucket, 90-day lifecycle.

## Phase E — Decommission + hardening

- After 2–4 quiet weeks, turn off on the Mac: `com.gam.api`, MLX LLM (:8080), embeddings (:8081), marketing fallback, storefront server, cloudflared tunnel (+ delete in Cloudflare), watchdog/start-launch-set jobs, backup cron. Keep local Postgres + repo as the dev box. Archive one final dump + uploads tarball, then **delete prod PII from the Mac** (`uploads/id-documents` especially).
- Admin infra-readiness panel (`routes/admin.ts:516`, `lib/apiMetrics.ts`): `os.loadavg` is meaningless on Cloud Run — strip the host-metrics section, keep the request-latency p95, link out to Cloud Run metrics.
- Rough cost at current scale: Cloud SQL ~$100 (→~$55 downsized), Cloud Run ~$15–30, ALB ~$20, GCS/secrets/registry ~$5, DeepInfra ~$5–20 usage-based ≈ **$120–175/mo**.

## Sequencing & top risks

A1–A6 as parallel PRs (A4 can go live on the Mac immediately) → B → C staging → D rehearsal → D cutover → E after soak.

1. A missed hardcoded uploads path → 404 post-cutover. Mitigation: grep inventory as checklist + staging smoke of every file type.
2. Scheduler double-run during Mac/GCP overlap. Mitigation: "exactly one `RUN_SCHEDULER=1`" runbook rule + advisory locks on notification jobs.
3. LLM behavior drift on hosted Hermes. Mitigation: flip the Mac to DeepInfra in Phase A and run `agents:eval` before any infra work.

## Workstream: money-flow audit & held-balance visibility (added 2026-09-06)

Prompted by rent card payments appearing to "pile up" in the main Stripe account. A full code audit confirmed the S560 platform-holds design is working as intended (rent lands on the platform balance, batched out via `jobs/autoPayouts.ts` on 50%/90% rent-roll triggers + a late-month sweep; cash payments count toward the triggers but are correctly never disbursed). The real gap is **visibility**: the landlord portal's balance reads the live Stripe Connect balance, which is structurally ~$0 under platform-holds, and nothing anywhere shows "GAM is holding $X, next payout ~date".

Work items (branch `money-flow-visibility`):
1. `GET /me/finances` (`apps/api/src/routes/finances.ts`): add `held_balance` (sum of unfired `allocation_owner_share` rows joined to `payments.platform_held=TRUE AND status='settled'` — the same query the RESERVE step uses in `services/landlordPassthrough.ts`) and `next_payout` (earliest unfired `payout_triggers` row for the user).
2. Landlord portal: show "Held by GAM" + next-payout date on the Finances/Disbursements surfaces.
3. Verification runbook for prod (Nic's Mac): job liveness, held totals vs platform balance, Connect readiness per landlord, stuck `platform_transfer_intents`, missed webhooks — shipped as a read-only SQL script under `scripts/`.
4. Follow-ups from the audit (separate): legacy `routes/terminal.ts` creates platform card_present PIs with no disbursement path (verify unreachable, then delete); business payouts unrecorded in `connect_payouts`; missing `application_fee_amount` on public-customer-portal and recurring off-session invoice charges; stale money-flow comments in `lib/stripe.ts`, `routes/bankAccounts.ts`, `services/connectPayouts.ts`.

## Critical files

- `apps/api/src/lib/fileServe.ts` (+ new `lib/storage.ts`) — storage seam
- `apps/api/src/index.ts` — scheduler gate, SIGTERM, trust proxy, `/health/ready`
- `apps/api/src/db/index.ts` + `db/propertiesDb.ts` — dotenv path, DATABASE_URL/socket
- `apps/api/src/services/agents/config.ts`, `engine.ts`, `embeddings.ts`, `services/autoFieldPlacement.ts` — hosted-LLM auth + degradation
- `apps/api/src/db/migrate.ts` — reused as the Cloud Run migrate job
- New: root `Dockerfile`, `.github/workflows/deploy.yml`, `deploy/gcp/` scripts
