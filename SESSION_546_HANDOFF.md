# SESSION 546 HANDOFF

## Theme
Automated FlexPay verification (Nic: "take the manual process out" —
no attestation checkboxes), backend-only pre-qualification, power-
outage recovery, and the test-suite completion that followed.

## 1. S546 — automated document verification (checkboxes REMOVED)
- Migration 20260718190000 (applied): flexpay_inquiries.
  auto_verification jsonb + tenants.flexpay_prequal jsonb.
- **services/flexpayAutoVerify.ts** (new):
  - verifyProofDocument(inquiryId) — runs on every proof upload
    (routes/tenants.ts hook): extracts PDF text via lib/pdfText (the
    UNTOUCHED lease-parser stack — Nic: never modify it, it works),
    requires a lease holder's name in the document (first+last,
    normalized), scans for SSA/SSI/SSDI benefit language
    (informational). Outcomes → auto_verification jsonb:
    'matched' (+matchedName) / 'no_match' / 'unreadable' (non-PDF,
    e.g. phone photos — no OCR yet).
  - no_match/unreadable → SILENT hold (S545c mechanism) with
    '[auto-verify]' reason prefix; a matching RE-UPLOAD self-heals
    (clears only holds this service placed — never birthdate/manual
    holds).
  - sweepFlexpayPrequal() — daily 5:30am PHX (scheduler, chained
    after the questionnaire sweep): BACKEND-ONLY readiness per
    tenant-with-active-lease → tenants.flexpay_prequal {status:
    prequalified|near|not, reasons[], computedAt}. NEVER shown to
    tenants; admin queue shows a gold PRE-QUALIFIED chip.
- **Approve is now automated**: requires proof on file AND
  auto_verification.nameMatch IN ('matched','manual_ok'). The old
  incomeVerified/nameMatchConfirmed body fields are accepted-but-
  IGNORED. 'manual_ok' is the one exception path: releasing a hold
  records the human resolution (release-hold sets it unless the
  machine already matched). ssi_ssdi still set only on tier-1
  approvals.
- Admin modal: checkbox block replaced by an "Automated checks"
  panel (proof on file / name match+who / benefit language /
  hold state) + the manual-hold escape hatch. Proof column shows
  ✓auto / ✓manual / check chips.

## 2. Power-outage recovery (2026-07-18)
- Postgres wouldn't start: STALE postmaster.pid (pre-crash PID
  reused by a macOS process post-reboot). Verified PID dead → removed
  lock → kickstart → clean WAL recovery, zero data loss, no pending
  migrations. **Playbook: check /opt/homebrew/var/postgresql@16/
  postmaster.pid vs `ps -p <pid>` after any hard crash.**
- start-launch-set.sh brought the rest up; marketing KeepAlive had
  survived on its own. Safari tabs reopened via `open -a Safari`;
  admin preview re-logged (TOTP from dev DB secret — first code
  expired mid-flight, regenerate and submit fast).

## 3. Test-suite completion (Nic: fix WITHOUT touching the PDF parser)
- vite-node cannot load pdfjs-dist's legacy build (ESM interop throws
  InvalidPDFException at import) even though the REAL pipeline works
  (verified with a direct tsx run: pdf-lib doc → extractPositionedText
  → text out). Per Nic the parser stays untouched → the suite MOCKS
  the extraction seam (vi.mock '../lib/pdfText' → latin1 passthrough)
  and uploads plain-text buffers as proofs (no real PDFs needed once
  the seam is mocked).
- **The 5-failure cascade was ONE bug**: S542b still had a raw inline
  upload ('%PDF-1.4 fake award letter', no name) → the auto-verifier
  correctly SILENT-HELD it → S542b's state-hold assert got the
  verification-hold message and aborted → its AZ block never got
  cleaned → every later approval 422'd on state hold. Fixed the
  upload (named helper), added beforeEach leak insurance
  (DELETE flexpay_blocked_states + tenant_questionnaires).
- Final: **14/14** across s541+s542 suites; api/admin/tenant tsc
  clean. Stale test titles updated.

## Decisions
- Nic: no manual verification clicks — machine reads the document;
  pre-approve silently in the backend; NEVER edit lib/pdfText.
- Claude (flag if wrong): photo (non-PDF) proofs auto-hold as
  'unreadable' until an OCR path exists (candidate: in-house agents);
  release-hold = the manual override ('manual_ok'); prequal statuses
  prequalified/near/not with reason codes.

## Files touched
api: migration 20260718190000, services/flexpayAutoVerify.ts (new),
routes/tenants.ts (verify hook), routes/admin.ts (auto gate, release
sets manual_ok, queue exposes auto_verification+prequal),
jobs/scheduler.ts (prequal sweep), s541 test suite (mock seam, plain
buffers, leak insurance). admin: main.tsx (Automated checks panel,
chips, PRE-QUALIFIED). NO changes to lib/pdfText.ts.

## Next session targets
1. **Storefront walkthrough for Nic** (parked three times): landlord
   BookingSitesPage config → subdomain URL onto Oak Park's Google
   Business profile → reservation/inquiry landing in the landlord
   portal. Oak Park needs a booking_slug set to demo.
2. OCR path for photo proofs (in-house agent candidate) so
   'unreadable' holds shrink.
3. Storefront prod wiring (wildcard DNS, captcha, Stripe-return
   confirmation page, landlord inquiry inbox).
4. Nic-gated: Stripe live keys → S520 + flexpay_enrollment_open;
   Checkr; DoorLoop export; fee blessings.

## Watchouts
- lib/pdfText.ts is OFF-LIMITS (Nic) — integrate around it.
- vitest CANNOT exercise real pdf extraction — any suite touching
  flexpayAutoVerify must mock '../lib/pdfText' (see s541 header).
- The auto-hold prefix '[auto-verify]' is LOAD-BEARING: self-heal
  only clears holds carrying it. Don't reword without updating
  AUTO_HOLD_PREFIX.
- Approve gate order (tests assert messages): held → proof →
  nameMatch → income-tier → state hold.
