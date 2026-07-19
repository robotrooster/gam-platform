# SESSION 542 HANDOFF

## Theme
Two Nic directives on top of S541's FlexPay demand-test launch:
(1) the CONFIRMED FlexPay loss/recourse model, (2) platform-originated
tenant questionnaires (landlord-invisible) that find fixed-income
tenants and funnel them into the FlexPay inquiry queue.

## 1. FlexPay loss/recourse model — CANONICAL (Nic, this session)
- FlexPay = payment coordination, NOT lending.
- Failed pull + failed ACH retry → advance written off, tenant REMOVED
  from FlexPay (90-day lockout), landlord's normal eviction path
  proceeds next cycle when the tenant doesn't pay.
- **The ONE recourse: GAM-First supersedence interception.** The
  tenant's next landlord-bound payment routes to outstanding GAM
  balances first (authorized in each Flex product's signed terms);
  the landlord receives any surplus. Nothing else — no collections,
  no suits, no credit reporting.
- **False start, same session:** I briefly removed defaulted
  flexpay_advances from the supersedence FIFO after Nic's first
  "no recourse" phrasing; he then clarified the interception IS the
  designed recourse. REVERTED — supersedence.ts now carries the
  confirmed-model comment block. supersedence suite 13/13. Do not
  remove flexpay_advance from the FIFO again.
- Memory updated: flexpay-demand-test-rollout.md item 5.

## 2. Tenant questionnaires (S542 build — landlord-invisible)
- **HARD RULE: no landlord route may ever select from or join
  tenant_questionnaires.** Tenant + (future) admin surfaces only.
- Migration 20260714223000 (applied): tenant_questionnaires — UNIQUE
  (tenant_id, trigger_type) one-shot per signal; status
  pending/answered/dismissed; answers jsonb
  {incomeSource: ssi|ssdi|other_fixed|none, interested: bool}.
- shared: QUESTIONNAIRE_TRIGGER/_STATUS/_INCOME value arrays.
- services/tenantQuestionnaires.ts:
  - maybeCreateQuestionnaire(tenant, trigger) — guards: flexpay flag
    on, not enrolled, no existing inquiry, one-shot; never throws
    (callers are billing/cron paths).
  - sweepSsiSsdiQuestionnaires() — daily 5:30am PHX cron
    (scheduler.ts): tenants.ssi_ssdi=TRUE + active lease + no FlexPay
    engagement → 'ssi_ssdi_signal' ask. Idempotent.
  - answerQuestionnaire — positive fit (SSI/SSDI + interested) auto-
    files flexpay_inquiries (ON CONFLICT DO NOTHING; tenant_note
    "Via <trigger> questionnaire") + admin notification.
- Trigger hooks:
  - jobs/lateFees.ts insertLateFeeRow: RETURNING id; on a FRESH fee
    row → maybeCreateQuestionnaire('late_fee_fixed_income').
  - Daily sweep cron for the ssi_ssdi signal (above).
- Tenant routes: GET /tenants/questionnaires (pending),
  POST /:id/answer, POST /:id/dismiss (all tenant-only).
- Tenant UI (main.tsx): QuestionnairePrompt banner on Home ("🔒 …
  Private — your landlord never sees this", Answer / No thanks) →
  modal with per-trigger copy (late-fee: "was this because your money
  arrives on a fixed day… want rent to come out AFTER it arrives?";
  ssi signal variant), two-question flow, confirmation screen states
  whether a FlexPay request was filed + the "proof of income where
  permitted" disclosure.
- Copy is deliberately neutral/national (no state-specific legal
  language); verification itself stays in the S541 admin review.

## Verification
- Suites: s542-questionnaires 5/5 (guards, sweep scope+idempotency,
  positive/negative funnel, dismiss, landlord 403), s541 3/3,
  s537-late-fee-consistency 20/20, supersedence 13/13. api+tenant tsc
  clean.
- Live: seeded a display-test questionnaire for alice → banner +
  modal rendered on Home, dismissed via the real UI (row hit
  'dismissed'), then deleted the test row. Alice's pending FlexPay
  inquiry (S541) remains the only live row for Nic to approve.

## Decisions
- Nic: FlexPay recourse = supersedence interception only; landlord
  gets surplus; removal + eviction otherwise.
- Claude (flag if wrong): questionnaires are one-shot per trigger
  type (no re-ask after dismissal); positive fit requires SSI or SSDI
  specifically (other_fixed/none answers don't file an inquiry);
  late-fee hook fires only on newly-inserted fee rows.

## Files touched
api: migrations/20260714223000 (applied),
services/tenantQuestionnaires.ts (new), services/supersedence.ts
(comment block; behavior net-unchanged), jobs/lateFees.ts (hook),
jobs/scheduler.ts (5:30am sweep), routes/tenants.ts (3 routes),
routes/s542-questionnaires.test.ts (new).
shared: index.ts (questionnaire enums). tenant: main.tsx
(QuestionnairePrompt + Home wiring).

## Next session targets
1. Nic: approve alice's pending FlexPay request (Admin → FlexPay
   Requests, needs TOTP) — still the first live queue run.
2. Additional demand indicators when Nic names them (candidates
   surfaced: repeated partial payments via is_remainder rows,
   payment dates clustering late in month, NSF history) — each is a
   new trigger_type CHECK extension + hook.
3. Admin visibility polish: questionnaire answer stats / demand
   funnel counts on admin Overview.
4. Unchanged: Stripe live keys → S520 flip; Checkr; DoorLoop export;
   fee blessings; storefront subdomains.

## ADDENDUM — S542b (same chat): hard gate, FCFS queue, state holds, proof upload

Nic-locked additions after the questionnaire build:
- **FlexPay is hard-gated to PROVEN SSI/SSDI** until bankroll supports
  wider rollout (W-2 expansion is a future Nic call, flag-style).
- **Proof to the PLATFORM, never the landlord** (Nic: imported tenants
  have no income data; nothing is landlord-facing): tenant uploads an
  SSA award letter / benefit verification letter on their pending
  inquiry. Migration 20260714234500 adds proof_file_path/
  original_name/uploaded_at to flexpay_inquiries. POST
  /tenants/flexpay/inquiry/proof (multer, PDF/JPEG/PNG/WEBP 10MB,
  S409 MIME-normalized ext, replace semantics) + tenant GET
  proof-file + admin GET /admin/flexpay/inquiries/:id/proof-file —
  all authed streams (S535), Content-Type pinned. Tenant UI: "🪪
  Proof of income" card on the Flex hub while pending (Needed/On file
  badge, upload/replace). Admin queue: Proof column with authed-blob
  View button (camelize interceptor passes Blobs untouched —
  constructor===Object guard).
- **FCFS queue**: created_at IS the order. Tenant card shows "You're
  #N in line — first come, first served" (GET /tenants/flexpay
  returns queuePosition + stateHold); admin queue shows # column
  (ROW_NUMBER over pending, ::int cast — bigint string bug fixed).
- **State holds**: flexpay_blocked_states (migration 20260714233000,
  EMPTY — mechanism only per S177 posture). Superadmin PUT/DELETE
  /admin/flexpay/blocked-states/:state (+GET, requireAdmin). Held
  tenants keep their queue place; approval 422s with the state
  reason; tenant copy: "not yet available in your state; you keep
  your place". Admin row shows STATE HOLD badge + property state.
- **Follow-up vigilance**: daily 5:45am PHX cron — pending inquiries
  older than 7 days → flexpay_queue_aging admin notification (stale
  queue head blocks everyone behind it).
- Tests: s541 suite extended (4 cases now) — FCFS positions across
  two tenants, PDF proof round-trip tenant→admin, AZ block → hold
  visible + approve 422 + place preserved → unblock → approve OK.
  9/9 across s541+s542. api/tenant/admin tsc clean. Verified live:
  alice shows "#1 in line" + proof card on /services.
- NOTE: proof-upload TESTS aside, admin queue page not walked live
  (TOTP). Alice's row now also awaits her proof doc — the approve
  flow works without it (admin may verify by reach-out), but the
  upload path is there.

## ADDENDUM 2 — S542c (same chat): float-need queue ordering, no tenant numbers

Nic corrections to S542b:
- **Tenants NEVER see a queue number** (no promises). queuePosition
  REMOVED from GET /tenants/flexpay; tenant copy is now "You're in
  line — we'll reach out when it's your turn" (state-hold variant
  unchanged). Verified live on alice's card.
- **Queue orders by FLOAT NEED, not FIFO** — shortest float first,
  created_at as tiebreak. Rationale (Nic): 3 tenants × 1-week float
  beats 1 tenant × 3-week float on the same bankroll, and longer
  floats earn less per dollar-day. est_float_days =
  GREATEST(0, desired_pull_day − COALESCE(lease.late_fee_grace_days,5)).
  Unknown day sorts LAST until captured.
- Migration 20260715001500 (applied): flexpay_inquiries.
  desired_pull_day (1-28, NULL=unknown). Captured by: inquiry modal
  (required slider "what day does your money arrive?"), questionnaire
  modal (slider appears when SSI/SSDI selected → answerQuestionnaire
  passes benefitDay into the funneled inquiry).
- Admin queue: ordered by float; # column reflects new order; new
  Float column (~Nd green ≤5 / amber ≤12 / red, benefit day beneath;
  "?" badge = unknown, sorts last). Aging-cron copy updated.
- Tests: s541 S542b case rewritten — long-float-first-inquirer sorts
  BEHIND short-float-second-inquirer (positions + est_float_days +
  full ordering asserted); tenant queuePosition asserted ABSENT;
  state-hold place-preservation now asserted via admin list. 9/9;
  api/tenant/admin tsc clean.
- NOTE: alice's existing inquiry has desired_pull_day NULL (created
  pre-column) → she sorts last with "?" until she re-tells us her day
  (or admin captures it during reach-out; a small admin edit-day
  control is a possible polish item).

## Watchouts
- gam_test now has flexpay_rollout_visible=TRUE permanently (S541/2
  fixtures upsert it). Suites asserting invisible-FlexPay behavior
  must set it FALSE themselves (tenants-flex.test.ts mocks the
  service, so unaffected).
- tenant_questionnaires cleanup: cleanupAllSchema doesn't list it,
  but tenants FK cascade wipes it; s542 suite also deletes directly.
- The late-fee hook runs inside the fee-generation loop but on the
  POOL (not the tx client) and swallows errors — fee writes can
  never fail on questionnaire problems.
