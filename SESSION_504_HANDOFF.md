# SESSION 504 HANDOFF

## Theme
CS-agent **action tools** + the **inspection walkthrough** + a new in-house
**unit video lifecycle** ("mini-YouTube"), backend through both portals.

> PARALLEL-WINDOW NOTE: a second window ran concurrently on **GAM-for-Business**
> (discounts, reports, customer portal) + the **booking-guest agent / Track A**
> and authored S499–S503. This handoff (S504) covers ONLY this window's
> agent/inspection/video work. Shared files (`services/agents/profiles.ts`,
> `services/agents/tools/index.ts`) were edited by BOTH windows — always re-read
> before editing. `DEFERRED.md` intentionally NOT touched here to avoid
> clobbering the other window's concurrent edits; reconcile shipped items below.

## Shipped

### Agent action tools (the read-vs-act gaps)
- **`flag_applicant_decision`** (landlord) — RECORD-INTENT-ONLY. Recon flipped
  the handoff framing: `unit_applications` has no decision lifecycle; the real
  applicant decision is on `background_checks` (`PATCH /background/:id/decision`,
  which auto-fires the FCRA §615(a) adverse-action notice). Nic's call: the
  agent must NOT execute it. The tool resolves the landlord's screening check
  (scoped, decidable-status check), records the intent as a durable notification
  + routes them to /screening. Never writes background_checks. Un-gated.
- **`draft_tenant_notice`** (landlord) — two-phase like send_bulk_message: phase
  1 (no `confirmed`) echoes the agent-drafted notice for approval; phase 2
  (`confirmed:true`) delivers via createNotification (`landlord_notice`).
  Informational only; never changes the lease. Un-gated.

### Inspection walkthrough (agent-guided)
- **B1**: shared single-source `buildInspectionChecklist({unitType,bedrooms})`
  in `packages/shared` (`INSPECTION_TYPES`, `MAX_INSPECTION_BEDROOMS=4`).
  Residential base + Bedroom 1..N (N = unit's `bedrooms`, cap 4); rv_spot → RV
  site list; storage/commercial → no bedrooms.
- **`get_inspection_checklist`** (tenant) + **`get_inspection_progress`**
  (landlord) — guide the walkthrough; per-area photo progress via
  photo→item→area. Shared logic in `tools/inspectionChecklistShared.ts`.
- **Seeding**: `POST /api/inspections` now seeds `unit_inspection_items` from
  the checklist at create (condition `na`, transactional, idempotent).

### Track C — in-house unit video lifecycle ("mini-YouTube")
- New **`turnover`** inspection type (clean/repair between tenancies).
- **`unit_inspection_videos`** table. **IMMUTABLE — no party can delete**: FK
  `ON DELETE RESTRICT` + BEFORE DELETE trigger + BEFORE UPDATE trigger blocking
  `video_url` repoint. **`captured_live`** added to videos AND photos.
- Endpoints: `POST/GET /:id/videos`, `GET /video-files/:filename` (per-row
  authz: admin / unit landlord / uploader), `GET /unit/:unitId/lifecycle`,
  `GET /videos/mine` (tenant self-scoped).
- **Visibility (Nic)**: landlords see ALL video of their units; tenants may
  upload + see ONLY their own uploads across units/years; in-house only (NOT
  YouTube — quota + privacy + in-house principle).
- **Frontend**:
  - Landlord: `InspectionDetailPage` video section + camera capture; new
    `UnitLifecyclePage` (route `inspections/unit/:unitId/lifecycle`) timeline;
    turnover plumbed through detail + NewInspectionPage.
  - Tenant: camera capture + photo "live" badge on `TenantInspectionDetailPage`;
    new **My walkthroughs** page (route `/walkthroughs`, `GET /videos/mine`).
  - **B3 camera-fresh capture**: `CameraCapture.tsx` (getUserMedia, NO
    file-picker; photo→JPEG, video→MediaRecorder WebM; cancel-on-close guard)
    in BOTH apps (duplicated — no shared UI pkg). Camera uploads tagged
    `capturedLive=true`; plain "Upload" kept as non-fresh fallback.

### Fixes
- 3 pre-existing STALE agent tests (predated both windows, from S498 behavior
  changes): escalation copy `specialist`→`senior agent`; curated-FAQ test now
  sets `AGENT_CURATED_FAQ=1` (flag default-off); `logInteraction` test add the
  `MAX(turn_index)+1` mock + bump call index. (The 4 guest-profile failures were
  the OTHER window's; it fixed them.)
- 2 camelize bugs in my OWN new UI: responses pass through
  `applyCamelizeInterceptor` (recursive snake→camel) — fixed video/lifecycle UI
  to read camelCase (`videoUrl`, `inspectionType`, `capturedLive`). tsc can't
  catch this class of mismatch.

## Migrations applied (this window)
- `20260618120000_inspection_type_add_turnover.sql`
- `20260618120100_unit_inspection_videos.sql`
- `20260618140000_inspection_videos_immutable.sql`
- `20260618150000_inspection_photo_captured_live.sql`
(plus S498-era `20260616120000` property_agent_permissions + `20260616130000`
lease_renewal_requests, already applied; the agent action tools build on them.)

## Validation
- API `tsc --noEmit` clean. Landlord + tenant `tsc` AND `vite build` clean.
- Tests: inspections route 49, agent tools 111, profiles 14 — all green.
- **Full suite MUST run from `apps/api`** (its vitest config is `singleFork` /
  `fileParallelism:false`). Running `npx vitest run` from the repo root uses the
  parallel default → workers clobber the shared `gam_test` DB → false mass
  failure. Serial full run earlier was green except the (now-fixed) stragglers.

## Key decisions (Nic)
- Applicant decision = record-intent-only (FCRA / fair-housing; agent never
  fires an adverse-action notice).
- Walkthrough videos: in-house "mini-YouTube", NOT YouTube. **Immutable** — no
  party can delete a video. Landlord-all / tenant-own visibility.
- Camera-fresh = in-app web getUserMedia capture now (defeats casual gallery
  re-use; NOT tamper-proof on web). Strong guarantee waits for a native app —
  **no native app exists in this repo** (all React+Vite).

## Deferred / next
- **Property-settings UI toggle** for the agent revenue permissions (still open
  from S498 — today: in-chat toggle + service only, no settings UI).
- Track C polish: client-side thumbnail + duration capture; prod video WORM
  storage/CDN (dev-team lane); native-app capture for the strong guarantee.
- AI-seed KB (~40 articles) product-accuracy review (S498 carryover).
- Tenant-facing unit lifecycle (currently landlord-internal + tenant-own-only).

## Memory updated
`project_agent_revenue_permissions`, `project_agent_guest_and_inspection_tracks`
(Tracks A/B/C state), MEMORY.md index. The guest/Track-A entry reflects the
other window's S501 work.
