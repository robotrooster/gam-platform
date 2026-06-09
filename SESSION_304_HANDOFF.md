# Session 304 — closed

## Theme

Structural pivot. Nic clarified that GAM is **not a consumer
lender on any product** — the platform is deliberately
designed to avoid consumer-lending regulation (TILA / Reg Z,
ECOA, FCRA furnisher, state consumer-installment-lender
licensing, usury caps).

Reworked the Consumer ToS § 9.1 (FlexDeposit) and § 9.2
(FlexPay) to reflect the actual product structure:

- **FlexDeposit** is a **Service-Level Agreement**, not credit.
  GAM voluntarily advances the deposit; tenant agrees to a
  service-fee installment schedule; **GAM has no legal recourse
  if tenant doesn't pay**. Enforcement = service-tier exclusion
  (OTP gate, restricted FlexSuite enrollment, offset against
  deposit refund).
- **FlexPay** is a **payment-date coordination subscription**.
  GAM does not advance funds; the tiers (pricing TBD per
  enrollment surface — original "$3 / $7 / $12" reference was
  inaccurate per S307 correction) buy
  scheduling features (later ACH-pull date, split pulls, payday
  alignment).

The S303 licensing audit was based on a GAM-as-creditor
assumption that is wrong for the active product. Marked it as
**archival** with a clear status header.

Saved the SLA-not-loan principle to auto-memory + CLAUDE.md so
future sessions don't drift back to lender framing.

## Items shipped

### Consumer ToS § 9.1 — FlexDeposit rewritten as SLA

Drops the entire creditor / TILA / FCRA / ECOA / state-lending
framing. New copy:

- Names the structure explicitly: "**FlexDeposit is a service-
  level agreement between you and GAM. It is not a loan or
  extension of credit, and GAM is not your creditor.**"
- Enumerates the four features that make it a service agreement,
  not credit:
  - **No legal recourse** for non-payment (no collections, no
    suing, no garnishment, no judgment, no liens, no CRA
    furnishing)
  - **No TILA** disclosures apply
  - **No FCRA underwriting** — eligibility check is service-
    tier qualification, not credit decision
  - **No state lender licensing** — GAM is not in the business
    of extending consumer credit
- Lists the limited non-payment consequences (service-tier, not
  debt collection): OTP suspension, restricted FlexSuite
  enrollment, offset against any deposit refund at lease end.

### Consumer ToS § 9.2 — FlexPay tightened as scheduling, not credit

- Explicit: "FlexPay is a payment-scheduling service. It is not
  a loan or extension of credit."
- Explicit: "**GAM does not advance any funds on your behalf for
  FlexPay.**"
- Tier-based subscription buys access to scheduling features
  (date selection, split pulls, payday alignment). If the
  scheduled ACH pull fails, account reflects unpaid rent.
- No TILA / FCRA / state lending-law framework applies.

### Consumer ToS § 1 — service-specific-terms list updated

"FlexDeposit credit agreement and Truth-in-Lending disclosure"
→ "FlexDeposit Service-Level Agreement".

### Consumer Privacy Policy § 2.1 + § 4.2 — FlexDeposit + FlexPay data flows rewritten

- FlexDeposit bullet: drops underwriting consumer-report data,
  credit decision, adverse-action notice. Replaces with:
  service-tier eligibility check, SLA, scheduled installments,
  payment history used internally for service-tier decisions
  only — **not furnished to any CRA**.
- FlexPay bullet: clarifies scheduling-data and subscription
  data only; GAM does not advance funds; no CRA data flows.
- § 4.2: Checkr re-scoped to Landlord-initiated rental-
  application screening only; **explicit "FlexDeposit is
  structured as a Service-Level Agreement, not as credit, so
  GAM does NOT engage the screening provider to pull a consumer
  report for FlexDeposit eligibility."**

### S303 licensing audit marked archival

Added a prominent status header to
`legal/FLEXDEPOSIT_STATE_LICENSING.md`:

> ⚠ STATUS: ARCHIVAL — NOT THE ACTIVE PRODUCT MODEL

Notes that the memo was produced under the GAM-as-creditor
assumption (which is wrong for the actual product), but is
preserved for two purposes:

1. **Reference if GAM ever pivots** to a creditor model.
2. **Recharacterization risk** — counsel should validate the
   SLA structure pre-launch against CFPB EWA advisory activity
   and BNPL regulatory creep. If a court or regulator
   recharacterizes FlexDeposit as credit in some state, the
   licensing path in that state's card is the fallback.

### CLAUDE.md — SLA-not-loan structural principle persisted

Rewrote the "Flex Suite product line" section with:

- **Load-bearing structural principle** prefacing the four
  products: GAM is intentionally not a consumer lender; future
  sessions must never imply credit extension by GAM.
- Per-product accurate structures (FlexDeposit SLA, FlexPay
  subscription, FlexCharge landlord-credit, FlexCredit third-
  party).
- Cross-product principle on OTP qualification gates.
- Recharacterization risk note for counsel pre-launch review.
- References to the live legal docs + archival licensing audit.

### Cross-session memory persisted

`/Users/gold/.claude/projects/-Users-gold-Downloads-gam/memory/`:

- **New:** `project_sla_not_loan_principle.md` — full
  description of the SLA-not-loan principle + per-product
  structures + recharacterization risk.
- **Updated:** `MEMORY.md` — added pointer to the new entry.

## Files touched (S304)

```
legal/
  CONSUMER_TERMS_OF_SERVICE.md         (§ 1 list + § 9.1 full
                                        rewrite + § 9.2 tighten)
  CONSUMER_PRIVACY_POLICY.md           (§ 2.1 + § 4.2 Flex flows)
  FLEXDEPOSIT_STATE_LICENSING.md       (archival header added)

CLAUDE.md                              (Flex Suite section
                                        rewritten with structural
                                        principle)

~/.claude/projects/.../memory/
  project_sla_not_loan_principle.md    (new)
  MEMORY.md                            (entry added)

SESSION_304_HANDOFF.md                 (this file)
```

No code changes. No migrations. No schema work.

## Decisions made during build

| Question | Decision |
|---|---|
| Delete the S303 licensing audit or archive it? | **Archive with a prominent status header.** Two reasons: (a) reference value if Nic ever pivots to a creditor model; (b) the matrix is the fallback if recharacterization risk materializes in any state. Deletion would lose the research value. |
| Rewrite Business ToS § 11 (FlexCharge) too? | **No — already correct.** FlexCharge has always been framed as Landlord-as-creditor (not GAM); the S301 rewrite already had the structural separation right. Only FlexDeposit needed the pivot. |
| Add a separate "no GAM lending" disclaimer to Consumer ToS at a high level? | **No — embedded in § 9.1 and § 9.2.** A separate top-level disclaimer would look defensive. The product-level framing in § 9 carries the message accurately. |
| Flag recharacterization risk to Nic prominently? | **Yes — in the CLAUDE.md memo + the archival header + this handoff.** Substance-over-form doctrine is real; CFPB EWA + BNPL trajectory matters. The "no recourse" piece is load-bearing; if any future session adds collection / CRA furnishing / court-action levers, the structural defense collapses. Worth making explicit so it doesn't drift. |
| Update other Flex products beyond FlexDeposit and FlexPay? | **FlexCharge stays unchanged (already landlord-credit, not GAM); FlexCredit stays unchanged (already third-party lender, not GAM); FlexDeposit + FlexPay were the only ones I had wrong.** Verified by re-reading Consumer ToS § 9 for residual lender framing. |

## Verification

- File sizes — `CONSUMER_TERMS_OF_SERVICE.md` and
  `CONSUMER_PRIVACY_POLICY.md` reflect substantive rewrites
  (multi-paragraph replacements, not single-line edits).
- Visual scan for residual "GAM is the creditor" / "TILA" /
  "FCRA underwriting" framing on FlexDeposit + FlexPay —
  clean. Other Flex products (FlexCharge, FlexCredit) retain
  their existing creditor identification (landlord, third-
  party) as intended.
- CLAUDE.md Flex Suite section rewritten with structural
  principle + per-product accurate structures.
- Cross-session memory file landed; MEMORY.md index updated.

## Items deferred

- **Counsel red-team of the SLA structure pre-launch.** This is
  the single most important pre-launch legal review item.
  Specifically: does the "no recourse" framing actually hold
  against substance-over-form recharacterization in each target
  state? CFPB EWA advisory (2023/2024) and BNPL regulatory
  creep are the relevant analogs. Texas, Massachusetts, and
  California are the most likely recharacterization-active
  states.
- **Eligibility-check workflow design** — for FlexDeposit, GAM
  needs to qualify tenants without doing FCRA-regulated credit
  underwriting. Likely: a soft-data / internal-history check
  that doesn't pull a consumer report. Design + product copy.
- **FlexDeposit Service-Level Agreement template draft.** The
  ToS now correctly names it; the actual SLA document still
  needs drafting. Different from the previous "credit agreement
  + TILA disclosure" framing — no TILA box, no APR, just
  service-fee schedule and the no-recourse / service-tier-
  consequence language.
- **FlexPay subscription terms draft.** Smaller scope post-
  pivot since FlexPay is purely a scheduling subscription.
- **OTP exclusion enforcement implementation.** The SLA names
  service-tier exclusion as the consequence of non-payment;
  the platform needs to actually gate OTP enrollment for
  tenants with delinquent FlexDeposit SLAs. Backend wiring
  + UI gating.

## Items deferred (cross-session docket, unchanged)

- FlexCharge landlord-template draft (S301).
- FlexCredit referral disclosure draft (S301).
- Consumer-side retention framing decision (S300).
- Campground Master import path.
- 2FA fan-out.
- Yardi GL-export columns, Rentec template (S293).
- Stats tile on admin Overview (S295/S296).
- PII redaction in admin list (S295).
- Per-platform notes / review history display (S296).
- Email notification deep links (S298).

## Nic-pending (unchanged + new)

Pre-existing:
- Stripe live keys.
- Resend domain verification.
- Plaid production keys.
- Stripe Terminal hardware.
- Checkr Partner credentials.
- Engagement with qualified counsel pre-launch.
- Consumer-side retention framing decision (S300).

**New from S304:**
- **Counsel red-team of the SLA-not-loan structure pre-launch
  is the highest-priority unaddressed legal review.** All
  other state-by-state work (licensing, TILA template, FCRA
  furnisher workflow) becomes irrelevant if the structure
  holds; becomes urgent if it doesn't.
- **Eligibility-check design** — what data sources GAM uses to
  qualify FlexDeposit applicants without triggering FCRA. May
  require product/UX work.

## What S305 should target

1. **Draft the FlexDeposit Service-Level Agreement template** —
   now informed by the structural rewrite. Cleaner than the
   prior credit-agreement-plus-TILA framing: just service-fee
   schedule, no-recourse provision, service-tier-consequence
   list, eligibility-disclaimer ("not a credit decision under
   FCRA"). Probably one focused session.
2. **Draft FlexPay subscription terms** — smaller scope post-
   pivot. Subscription + auto-renewal + cancellation
   mechanics.
3. **OTP exclusion enforcement wiring** — backend gating that
   ties FlexDeposit-SLA-delinquent tenants out of OTP
   enrollment. Code work.
4. **Engage counsel for SLA structure red-team** — Nic-blocked
   on actual counsel engagement; no Claude work needed until
   that lands.
5. **Wait for customer signal** if none of the above is urgent.

---

End of S304 handoff. Closed clean.
