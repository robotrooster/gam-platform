# SESSION 560 HANDOFF — read this FIRST

This supersedes SESSION_558_HANDOFF.md (which is now stale/pre-today). The
durable state lives in the memory system (auto-loads via MEMORY.md) + two spec
docs; this file is the pointer.

## ⚠️ NOTHING IS COMMITTED
Every change from this whole session — the metering feature, the doc cleanup,
the full bug sweep, and money-flow rebuild Phase 1 — is **unstaged** in the
working tree (~64 changed code files + deleted handoffs). Git history is intact.
Nic reviews + commits when he wants. Do NOT commit unless Nic says so.

## What happened this session (newest first)
1. **Money-flow rebuild — Phase 1 DONE (7/27).** Rent now always charges to the
   PLATFORM balance and is held (both pay routes); destination-charge path
   bypassed. 59 payment/webhook tests green, tsc clean, API healthy.
   → CONTINUE at **Phase 2** per the spec.
2. **Full-platform bug sweep (S560).** Multi-agent sweep found 21 verified bugs;
   11 obvious fixes applied+tested overnight (incl. a CRITICAL 2FA bypass) + 6
   of 7 "morning decisions" fixed with Nic (the 7th, chargebacks, became the
   money-flow rebuild). Report: `BUG_SWEEP_S560.md`.
3. **Doc consolidation.** Deleted 500 stale SESSION handoffs + old audits;
   merged DEFERRED.md + OAK_PARK_LAUNCH.md → `LAUNCH.md`. Root went ~530 → ~9 md.
4. **Utility turnover reads + front-desk metering (S559).** Feature-complete
   earlier this session — see memory [[gam-utility-turnover-reads]].

## To CONTINUE the money-flow rebuild (the main open work)
Read **`MONEY_FLOW_REBUILD_SPEC.md`** (full plan, recon map, build order) and
memory **[[gam-money-flow-platform-holds]]** (decisions verbatim).
- Model: platform HOLDS all payments → weekly batch to landlords (Friday-
  delivered, so INITIATE mid-week; FREE standard payouts only, never Instant).
- Decisions D1–D3 locked; **D4 (clawback mechanism) deferred — bring Nic 2
  options w/ plain-terms context at Phase 3.**
- Phase 1 done. NEXT: Phase 2 (weekly batch = net receivables, transfer
  platform→landlord Connect, standard payout; pay-only-owed; reuse autoPayouts
  holiday gating + generalize landlordPassthrough), Phase 3 (chargeback/return
  netting + 2wk-cap clawback — NET-NEW, needs D4), Phase 4 (PM/manager cuts onto
  the batch), Phase 5 (cleanup + update CLAUDE.md S113 section).
- STRIPE-SIDE (live keys/Connect) verify LATER via the C4 live-fire test — Nic
  will likely do that in its own fresh context after the code rebuild.
- Build money code carefully/incrementally with fresh context headroom; keep
  every payments/webhook/allocation/payout test green.

## Other current pointers
- `LAUNCH.md` — consolidated launch + backlog (replaces DEFERRED/OAK_PARK).
- `BUG_SWEEP_S560.md` — the sweep report + verification.
- Launch is Oak Park Aug 1 (tenants log in + pay rent); longest pole = Nic's
  Stripe live-account/sales-rep call (N1). See [[oak-park-launch-sprint]].
