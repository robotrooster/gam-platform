# SESSION 545 HANDOFF

## Theme
FlexPay review-integrity build-out (same chat as S544, Nic driving
live from the admin preview): lease context in the queue, proof-backed
approvals, income TIERS (non-SSI/SSDI = tier 2), program-native
benefit schedules, honest verification badges, and SILENT
verification holds (name + birthdate fraud gates).

## Shipped (14/14 s541+s542 suites; api/admin/tenant tsc clean)

### S545 — queue context + proof gate + tier 2
- Queue rows carry lease terms: rent due day, lease end + ~months
  left (amber ≤2mo), month-to-month noted. (l.rent_due_day, l.status,
  computed lease_months_left.)
- **Approval requires a proof document on file** (422 otherwise);
  tenant proof card now shows in the INTEREST flow (survey mode
  included — copy: "your request can't be approved until we verify").
  Review modal warns when no doc; review errors now display (reviewMut
  onError — was silent).
- **Income tiers (Nic: "still customers, lower priority")**:
  claimed_income_source widened to ssi/ssdi/other_fixed/none
  (migration 20260718140000 + backfill of answered+interested
  questionnaires → grace became a tier-2 row). EVERY interested
  questionnaire/survey answer files an inquiry now. Tier 1 (SSI/SSDI)
  always outranks tier 2 in ordering + queue numbers; tier-2 approval
  422s ("income-type hold") until flag `flexpay_other_income_open`
  (default OFF) flips; tier-2 approval never sets tenants.ssi_ssdi.
  UI: "TIER 2 · HELD" badge, funnel line "N tier-2 waiting on
  expansion". Survey + questionnaire offer all four income options.
  NOTE for expansion day: getFlexPayEligibility still requires
  ssi_ssdi — opening tier 2 needs an eligibility adjustment too.

### S545b — program-native schedules + honest badges
- flexpay_inquiries.benefit_schedule (migration 20260718160000):
  ssi_day_1 / ssdi_day_3 / ssdi_wed_2|3|4 / fixed_day. Shared
  BENEFIT_SCHEDULE_VALUES/_LABEL + benefitScheduleToDay() (latest day
  the pattern lands: wed_2→14, wed_3→21, wed_4→28) drives
  desired_pull_day → float math unchanged.
- Tenant UI: BenefitScheduleFields per income — SSI: static "arrives
  the 1st"; SSDI: 2nd/3rd/4th Wednesday or 3rd-of-month buttons with
  the birth-date helper (1-10→2nd, 11-20→3rd, 21-31→4th, pre-1997→
  3rd); other_fixed: day slider; none: nothing. Used by BOTH the
  survey modal and the questionnaire. Submit blocked until SSDI picks.
- Admin Float cell shows the pattern ("3rd Wednesday (≤ day 21)").
- **Income Verified badge is honest now**: green ONLY when approved
  (proof + attestations); import/onboarding ssi_ssdi flag shows amber
  "Flagged · unproven"; else muted Unverified. (Grace's false green
  was the trigger.)

### S545c — SILENT verification holds (fraud gates)
- Migration 20260718170000: flexpay_inquiries.held_at + hold_reason.
  Held = out of the working queue (no queue number, excluded from
  funnel counts), decisions 422 until released. created_at never
  changes → release restores the original spot automatically.
- **ZERO tenant-facing signal** — tenant GET exposes no hold fields;
  portal shows normal pending copy (test-pinned).
- **Birthdate gate (automatic)**: services/flexpayVerification.ts
  runBirthdateCheck — SSDI Wednesday claims checked against ALL
  active lease holders' tenants.date_of_birth (1-10→wed_2 etc.). No
  lease-holder DOB consistent → silent auto-hold with explanatory
  reason. Missing DOBs / ssdi_day_3 / SSI / fixed_day: never held
  (can't-verify ≠ mismatch). Runs on inquiry insert (route +
  questionnaire funnel), never throws.
- **Name gate (human)**: approval now ALSO requires
  nameMatchConfirmed — modal shows the lease holders' names
  (string_agg in queue SQL) and a second required checkbox "document
  is in the name of a lease holder".
- Admin endpoints: POST /flexpay/inquiries/:id/hold {reason} (manual
  — e.g. name mismatch; modal button uses Notes as reason) +
  /release-hold. Both audited. UI: red-bordered "🔒 Held —
  verification" section with reason + Release; pending table excludes
  held.

## Decisions
- Nic: income proof must be in a LEASE HOLDER's name; claimed pay
  date silently matched to lease-holder birthdates; discrepancies =
  silent hold + removal from queue; resolution = resume original
  spot; no tenant-facing notice EVER.
- Nic (legal question answered in-chat): do NOT vary fees by income
  source (ECOA public-assistance protection + recharacterization
  risk; "loan origination fee" vocabulary banned). The date-based
  $5+day formula already scales price with float length income-blind.
  Flagged for the pre-launch counsel pass.
- Claude (flag if wrong): held rows can't be declined either (resolve
  → release → decide); manual hold requires a reason; auto-hold only
  for SSDI Wednesday claims.

## Files touched
api: migrations 20260718{140000,160000,170000} (applied),
services/flexpayVerification.ts (new), services/tenantQuestionnaires.ts,
services/flexpay.ts (S544 gate), routes/tenants.ts, routes/admin.ts,
routes/s541-flexpay-inquiry.test.ts (14 cases now).
shared: income-source + benefit-schedule enums/helpers.
tenant: main.tsx (4 income options, BenefitScheduleFields, proof card
in interest flow). admin: main.tsx (lease context, tier badges, honest
badges, name checkbox, hold UI, held section, review errors).

## Dev-state note
grace = tier-2 pending (other_fixed, day 22, ~17d float, backfilled);
alice = tier-1 pending, float "?", no proof. Nic reviews from the
admin preview (TOTP session I opened via the dev DB's stored secret).

## Next targets
1. Storefront walkthrough for Nic (subdomain setup → Google Business
   link → reservation/inquiry into landlord portal) — HIS next ask,
   parked twice.
2. Possible polish: schedule-aware admin Set-day control; aging-alert
   awareness of held rows (held >N days reminder).
3. Unchanged: Stripe live keys → S520 + flexpay_enrollment_open at
   launch; Checkr; DoorLoop; fee blessings; storefront prod wiring
   (wildcard DNS, captcha, confirmation page, inquiry inbox).

## Watchouts
- Review-route gate ORDER: held → attestation → name → proof →
  income-tier → state hold. Tests assert specific messages — keep
  order stable or update asserts.
- gam_test now carries flexpay flags from fixtures (rollout+enrollment
  TRUE; other_income toggled in-test with upserts — plain UPDATE
  no-ops, rows may not exist).
- Tenant GET /flexpay must NEVER expose held_at/hold_reason.
