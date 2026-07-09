# SESSION 532 HANDOFF

## Theme
NIC'S CORRECTION PASS, item 1: W-36 utilities. The S531 manual
record-reading/generate-bills page was NOT the designed workflow — Nic's
end-of-month READING RUN replaced it, iterated live to his spec three
times this session (base flow → blind walk → no-giveaway flagging).
S90 billing engine + S178 invoice-line-item rails were kept as the
foundation ("the right start" — Nic). Uncommitted (Nic commits).

## THE WORKFLOW (as Nic specified it — treat as the standard)
1. **Run opens automatically** per property on the **last business day
   of the month** — walk BACKWARD past weekends AND US federal holidays
   (Nic's rule verbatim: last business day; if federal holiday, one day
   earlier; if that's a weekend, keep going back to a business day).
   Daily 7am Phoenix scheduler tick, self-gating.
2. **Prompt** (notification + email, deep-link /utilities?propertyId=)
   to the landlord + every staff member whose scope covers the property
   AND whose permission toggles include properties.edit.
3. **Guided walk, BLIND + LINEAR** (Nic): one step per UNIT with a
   typed input per applicable utility (RV 01 electric, RV 01 water…).
   RUBS/multi-unit meters get property-level steps at the end.
   - NO prior reading shown ANYWHERE (bias prevention) — not in the UI,
     not in the API payload (getRunMeters returns is_read flag only),
     not in error copy.
   - Input is type=text inputMode=decimal (no mouse-wheel increments),
     regex-filtered numeric.
   - ONLY button is "Next" (no Skip, no Finish early, no "Save" word).
     Next saves the step's readings and advances.
4. **NO GIVEAWAYS for bad readings** (Nic): below-previous value gets
   the same 201 as a good entry — response carries no value/flag — and
   is silently flagged (needs_review + review_note). Engine refuses
   negative usage so a flagged row can't mis-bill.
5. **Auto-complete**: when the last meter is read, the run completes —
   bills generate (S90) + auto-finalize to 'billed' → S178 invoice cron
   folds each into the tenant's next monthly invoice. Zero manual steps.
6. **Double-check queue** (landlord surface on /utilities): flagged
   rows show entered vs previous (the REVIEWER sees both; the reader
   never does) → Review modal: "Save correction" or "Reading is
   correct" (meter swap/rollover). If the run had already completed,
   resolving re-bills that meter's cycle automatically.

## SHIPPED
- Migration 20260706120000 utility_reading_runs (one run per
  property+cycle UNIQUE; progress DERIVED from readings, no drift).
- Migration 20260706140000 needs_review + review_note on
  utility_meter_readings (+ partial index).
- services/utilityReadingRuns.ts — lastBusinessDayOfMonth (reuses
  US_FEDERAL_HOLIDAYS from jobs/autoPayouts — refresh that set
  annually!), openReadingRun (idempotent), openDueReadingRuns
  (scheduler entry), getRunMeters (blind payload), completeReadingRun,
  isRunFullyRead.
- routes/utility.ts — 7 new endpoints: GET/POST reading-runs, GET
  :id/meters, POST :id/meters/:meterId/reading (run-stamped cycle,
  upsert-while-open, silent flagging, auto-complete), POST :id/complete
  (backend-only now — see gaps), GET readings/flagged, POST
  readings/:id/resolve-review (re-bills completed cycles).
- scheduler.ts — daily 7am Phoenix tick.
- notifications — utility_reading_run_opened type (free-form, no CHECK).
- UtilityMetersPage.tsx rebuilt: run banner ("Meter readings due — July
  2026 · 0 of 10") / ReadingWalkModal (blind, unit-grouped, Next-only) /
  double-check card + ReviewReadingModal / meter setup kept / Record
  Reading + Generate Bills + Send to Tenant + cycle picker REMOVED.
  Bills table read-only ('billed' renders as "on next invoice").
- Fixed in passing: seedDemo readings INSERT was missing
  created_by_user_id (NOT NULL — every reseed would have crashed);
  pg-Date-vs-string coercion in completeReadingRun (same class S531 hit).

## NIC DECISIONS THIS SESSION (recorded in FINAL_WALKTHROUGH W-36 🔁)
- Run timing: last business day, holiday/weekend walk-back (his words).
- Prompt audience: property staff + landlord.
- S531 manual workflow: should not exist — removed, not coexisting.
- Meter setup stays but needs READ-ONLY vs EDIT permission split —
  "we will adjust details later" (DEFER to staff-permissions pass).
- Blind walk: no prior values, typeable-only input, Next-only, no
  skip/finish-early, auto-save without the word "Save".
- Bad readings: zero feedback to the reader; silent flag; landlord
  double-checks. (Bias-prevention is the principle — likely applies to
  any future staff field-entry surface.)

## DEMO STATE (Sunset Palms, james@demo.dev / landlord1234)
- 10 RV spots (RV 09/10 added this session), each on its OWN pedestal
  submeter ($0.14/kWh; Grace's keeps the "Pedestal Row A" label). The
  old shared Row A→RV 02 assignment removed (submeter with 2 units
  double-bills — engine convention is 1:1).
- June 30 baselines on all 10 (Row A=1000, RV 01=4210, RV 02=2840,
  RV 03=1520, RV 04=3105, RV 05=5230, RV 06=980, RV 07=2444, RV 09=0,
  RV 10=0). July cycle UNREAD.
- July run OPEN 0/10; run-opened notification in james's bell.
- Grace's walk moment: enter 1250 on Row A → 250 kWh → $35.00 to her
  next invoice. Grace's old S531 $35 'billed' bill was deleted (the run
  recreates it live; it was never invoice-linked).
- All mirrored into seedDemo.ts (baselines + open run; reseed-safe).

## TESTS / STATE
- utilityReadingRuns.test.ts 12/12 (holiday walk-back incl. the
  Memorial-Day-Monday→Friday chain; open idempotency; blind payload;
  silent-flag indistinguishability — response string asserted to
  contain no flag/value; auto-complete $35 integration with REAL
  engine; flagged-skip→resolve→re-bill loop; 409s; cross-landlord).
- utility.test.ts 35/35 still green. tsc clean: api, landlord.
- Verified live end-to-end in the landlord portal (banner → blind walk
  → silent flag → double-check card → correction → flag cleared), then
  demo state RESET to pristine 0/10.

## KNOWN GAPS / WATCH
- **Stuck-run gap**: with Skip/Finish-early removed from the UI, a
  physically unreadable meter (smashed pedestal) blocks run completion
  → NO bills generate for that property/cycle. POST /reading-runs/:id/
  complete still exists backend-side as the escape hatch but has no UI.
  Surface to Nic when it bites or at the permissions detail pass.
- Meter-setup read-only permission split deferred (Nic: adjust later).
- US_FEDERAL_HOLIDAYS covers 2026-2027 only — annual refresh cadence
  (same discipline as the deposit-interest/tax-form catalogs).
- Run timezone is America/Phoenix platform-wide (matches other crons),
  not per-property.

## NEXT SESSION (in order — carried from S531 + this session)
1. **NIC'S CORRECTION LIST continues** — W-36 was item 1; expect more
   re-opened items. His words beat the tracker's ✅ marks.
2. **W-56 continue** — work-trade walk resumes.
3. **W-49/W-50 Checkr** — blocked on Nic opening the account.
4. **W-42 agents LAST** — scope with Nic, re-ingest post-fix world.
5. Then: other portals' walkthrough passes + launch infra (Vercel Pro,
   Resend, Stripe webhook, host migration off the Mac).

## SERVICES
Launch set only: API :4000, landlord :3001 (Claude preview), tenant
:3002, admin :3003, marketing :3004, POS :3005, admin-ops :3009,
Hermes :8080, embeddings :8081, Postgres :5432.
