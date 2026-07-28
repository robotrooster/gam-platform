# SESSION 561 HANDOFF — read this FIRST

Supersedes SESSION_560_HANDOFF.md. Durable detail lives in the memory system
(auto-loads via MEMORY.md); this file is the pointer + the plan for what's next.

## ⚠️ NOTHING IS COMMITTED
Everything from S558/S560/S561 is unstaged in the working tree (~52 modified,
~24 new incl. migrations, ~511 deleted stale docs). Git history is intact.
**Commit happens AFTER the full-platform bug sweep, right before Oak Park upload
(Nic's explicit sequencing).** Do NOT commit before then.

## THE PLAN — Nic's explicit order for what's left (all "getting done today")
1. **THIS fresh session → do ALL the Stripe / payment work** (details below). Nic
   HAS live keys + a live platform account — no N1 gate.
2. **THEN sweep the ENTIRE platform for bugs** — not just touched files / blast
   radius, the WHOLE platform — before Oak Park is uploaded. (Same multi-agent
   adversarial style as the S560 sweep, but full-coverage.)
3. **THEN commit everything + Nic uploads Oak Park.**

## Where the platform stands (verified S561)
**The non-Stripe backlog is EMPTY. The platform is feature-complete for the Oak
Park launch.** S561 verified this against the actual code, item by item (the
backlog notes were badly stale — nearly every "remaining" item was already
built). See **[[gam-s561-backlog-verified-done]]**. TRUST CODE OVER NOTES.

The only remaining build work is the Stripe/payment block below.

## ===== THE STRIPE / PAYMENT BLOCK (this session) =====
Build money code carefully + incrementally with fresh headroom; keep every
payments/webhook/allocation/payout test green (per [[gam-money-flow-platform-holds]]).

1. **Money-flow rebuild, Phase 2+** — spec: `MONEY_FLOW_REBUILD_SPEC.md` +
   [[gam-money-flow-platform-holds]]. Phase 1 done (rent → platform balance,
   held). NEXT: Phase 2 weekly batch to landlords (Friday-delivered → initiate
   mid-week, FREE standard payouts only, holiday gating), pay-only-owed; Phase 3
   chargeback/return netting + 2wk-cap clawback (needs decision D4 — bring Nic 2
   options); Phase 4 PM/manager cuts onto the batch; Phase 5 cleanup + CLAUDE.md
   S113 section.
2. **Connect re-anchor, Stage 2** — [[gam-connect-reanchor]]. Per-user →
   per-landlord-entity Connect. Stage 1 done (additive, deployed). Stage 2 =
   money-caller switch + live membership rechecks. The screening charge's
   destination depends on this.
3. **Live wiring (C3)** — live keys → apps/api/.env; prod webhook endpoint +
   secret + signature verify; Financial Connections live (replaces dev mock
   SetupIntent); Radar on; store RAW webhook payloads append-only.
4. **Screening-payment flow** — the applicant pays at application via a Stripe
   charge with **`on_behalf_of` = the landlord + `application_fee_amount` = the
   full amount** (landlord = merchant of record = the legal shield; nets $0; GAM
   takes 100% inline, no separate transfer). FULL locked model in
   **[[gam-checkr-billing-model]]**: applicant pays $42.94 ($37.94 Checkr
   Essential+IDV + $5 GAM) + card processing on top (~$44.60); NO cap tables
   (landlord owns legality); landlords can NEVER mark up (platform law);
   processing variance nets against GAM's $5, landlord always $0; capped states =
   landlord opt-in reduced-rate only. Also: trim the intake to income/employment
   only (Checkr+IDV verifies identity), + the **property-QR**
   ([[gam-screening-property-qr]], design locked: one signed permanent per-property
   token, server-side binding) + rewrite the screening KB/agent copy to this
   model + re-run the 43-scenario agent eval ([[gam-agent-roster]]).
   NOTE: S561 already shipped the screening decision UI, adverse-action rework,
   trimmed review modal, and IDV pricing constants — only the PAYMENT is unbuilt.
5. **Self-service amenity QR** — [[gam-self-service-qr-pos]] (dump station/water,
   honor-system, auth-free hosted pay page, same rail). Post-launch-ish; build if
   time / with the payment rail.
6. **Live-fire money test (C4)** — one small real ACH + one card → lands in Nic's
   Connect balance, app fee to GAM, then refund. Proof before any tenant pays.
   Then C5 invite→login→pay walkthrough on PROD.

## What S561 built (small, all tests green, uncommitted)
- Move-out meter rollover **typo guard** (utilityBilling.ts) + test (33 green).
- Confirmed the S560 bug sweep is fully resolved (D1/D4/D5/#6 already built; #2/#3
  are this Stripe block). [[gam-bug-sweep-s560]]
- Screening billing model fully re-designed + LOCKED across the session (the
  earlier S561 "landlord-billed, netted from disbursement" code is now an INTERIM
  stub — see the ⚠️ comment in background.ts — superseded by #4 above).
- Adverse-action rework + landlord decision UI + trimmed review modal (shipped).

## Oak Park launch context
Aug 1, tenants log in + pay rent. Nic's manual tasks: N2 real account email, N3
data entry, N4 Connect KYC, N5 Vercel Pro. Prod API = compiled dist under launchd
com.gam.api (rebuild+restart to deploy API changes; [[gam-prod-api-restart]]).
See [[oak-park-launch-sprint]], LAUNCH.md.

## Start-of-session
Read MEMORY.md (auto-loads) + this file. Then start the Stripe block at #1 or #2
(both are prerequisites for #4). Do NOT re-chase the non-Stripe backlog — it's
verified empty.
