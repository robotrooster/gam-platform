# Session 305 — closed

## Theme

Three corrections + a directive shift from Nic:

1. **GAM-supersedence ACH routing** wasn't disclosed in the
   consumer-facing legal docs. Added explicit disclosure.
2. **Checkr / FlexDeposit verbal association** — even saying
   "GAM does NOT use Checkr for FlexDeposit" creates the wrong
   association. Stripped the linkage entirely.
3. **Collections partnership** applies to landlord-owed unpaid
   rent ONLY, never to FlexDeposit or any GAM-side balance.
   Disclosed accordingly.

**Directive shift:** Nic confirmed no attorney review will
happen pre-launch. The live legal docs need to be defensively
self-sufficient ("bulletproof"). Applied maximum defensive
drafting to the SLA structure on FlexDeposit; "engage counsel
pre-launch" framing dropped from Nic-pending list going forward.

## Items shipped

### Privacy Policy — Checkr-FlexDeposit linkage stripped

- **§ 4.2** rewritten: Checkr described only as the screening
  provider for Landlord-initiated rental-application screening.
  Removed the "FlexDeposit does NOT use Checkr" sentence
  entirely — even disclaiming was creating verbal association.
- **§ 2.1 FlexDeposit bullet** rewritten: removed "service-tier
  eligibility check" framing that could be confused with
  consumer-report retrieval; replaced with "FlexDeposit
  eligibility is determined from your existing Platform account
  data … does not involve any consumer report obtained from a
  third-party consumer reporting agency." Clean separation.
- **§ 4.2 service-provider list** adds the Collections Partner
  as a discrete service provider for landlord-engaged
  rent-collection only.

### Consumer ToS — new § 5.5 Payment Routing (GAM-First Application)

Bold "PLEASE READ THIS SECTION CAREFULLY" disclosure block:

- When a Tenant authorizes any ACH/card payment through the
  Platform, the Platform applies the payment **first to any
  outstanding GAM balance** (FlexDeposit SLA installments,
  FlexPay subscription, processing fees) on a first-in,
  first-out basis. Remainder settles to Landlord's Connect.
- Tenant authorizes the routing at payment-method setup and
  at FlexDeposit enrollment.
- **"Effect on your Landlord-owed balance"** sub-paragraph
  explicitly disclaims GAM liability for any rent shortfall:
  the Tenant remains responsible to the Landlord for unpaid
  rent that results.
- **"Avoiding the routing"** sub-paragraph: Tenant can pay
  Landlord through a non-Platform channel to avoid routing.

§ 5.1 (How Payments Work) updated to cross-reference § 5.5
and § 5.6 so the routing disclosure is visible at the first
mention of payments.

### Consumer ToS — new § 5.6 Unpaid Rent and Collections

- Discloses Landlords may engage GAM's third-party Collections
  Partner for **landlord-owed unpaid rent only**.
- Collections subject to FDCPA + state debt-collection law.
- Tenant's right to dispute under FDCPA / FCRA preserved.
- **Explicit negative carve-out:** "This Section 5.6 has no
  application to GAM Service-Level Agreement amounts. Per
  Section 9.1, GAM does not engage any collections partner …
  Section 5.6 applies only to landlord-owed unpaid rent."

### Consumer ToS § 9.1 — bulletproof SLA drafting

Rewritten as six numbered sub-sections:

- **§ 9.1.1 Express Characterization and Intent.** Statutorily
  precise: not a "loan", not "consumer credit" under TILA /
  Reg Z, not under ECOA / Reg B, not a "consumer financial
  product or service" under the CFPA, not a "debt" under
  FDCPA, not a "loan" under any state consumer-finance or
  usury statute. Express intent: the parties construe it as
  a service-level agreement only.
- **§ 9.1.2 No Debt Created; No Recourse.** Enumerated
  no-recourse list: no suing, no collections, no garnishment,
  no liens, no security interest, no CRA furnishing, no
  threats. Explicit negative reference to § 5.6 Collections
  Partner: "the Collections Partner has no role in FlexDeposit,
  and GAM does not refer FlexDeposit SLA balances to the
  Collections Partner or any other collector."
- **§ 9.1.3 Payment Routing Authorization.** Cross-references
  § 5.5 GAM-first routing as the operational mechanism for
  installment satisfaction. Explicit ACH-revocation right.
- **§ 9.1.4 Consequences of Non-Payment (Service-Tier, Not
  Debt-Collection).** Three enumerated consequences only:
  (i) OTP suspension; (ii) FlexSuite enrollment restriction;
  (iii) **contractual offset at lease end** (not a secured
  claim; shortfall absorbed by GAM, not pursued under any
  theory).
- **§ 9.1.5 Bankruptcy and Recharacterization.** Bankruptcy:
  SLA terminable on filing, unpaid installments forgiven, no
  claim against estate. Recharacterization severability:
  preserves SLA structure on partial recharacterization;
  GAM's no-recourse election remains operative; if
  recharacterization triggers unsatisfied regulatory
  requirement, GAM's sole remedy is terminate + refund
  service-fee installments paid in excess of advance.
- **§ 9.1.6 No Eligibility-Decision Consumer Report.** GAM
  determines eligibility from existing Platform account data
  only; no third-party consumer report; not a "credit
  decision" under ECOA; no FCRA adverse-action notice; manual
  explanation available on request within 30 days.

### Business ToS — new § 6.6 Payment Routing + § 6.7 Collections

Mirror disclosures for landlord-side awareness:

- **§ 6.6 Payment Routing — GAM-First Application** —
  Landlord-side ledger shows actual received (PARTIAL when
  supersedence diverted). Tenant remains responsible to
  Landlord for any rent shortfall; GAM not liable for shortfall;
  Landlord's lease remedies preserved.
- **§ 6.7 Unpaid Rent and Collections Partner** — Landlord is
  the original creditor; Collections Partner is engagement
  agent; Landlord responsible for accuracy of amounts; FCRA
  furnisher obligations attach to Landlord/Collections Partner,
  not GAM. Explicit "Collections Partner is engaged solely for
  landlord-owed unpaid rent. It is not engaged for any
  FlexDeposit, FlexPay, or other GAM Service-Level Agreement
  amount."

### CLAUDE.md updated

- Removed the "recharacterization risk to flag to counsel
  pre-launch" framing (counsel pass not happening).
- Added GAM-supersedence-routing structural note + cross-ref
  to the live disclosures (Consumer ToS § 5.5 + § 9.1.3;
  Business ToS § 6.6).
- Added Collections-partnership-is-rent-only note + cross-ref
  to disclosures (Consumer ToS § 5.6 + § 9.1.2; Business ToS
  § 6.7).
- Updated "Recharacterization risk" framing to reflect
  residual risk + the bulletproof drafting that addresses it.

### Cross-session memory updated

- **`project_gam_supersedence_routing.md`** — added "Legal
  characterization (S305 reinforcement)" note explaining
  GAM-supersedence is routing, not collection. Drafting
  guidance for future sessions: "routing" / "application of
  authorized payment" — never "collection" / "recovery" /
  "satisfaction of debt".
- **`project_sla_not_loan_principle.md`** — added "Bulletproof
  drafting (S305)" + "Collections partnership is rent-only"
  notes. Drafting guidance: always "service-fee installment",
  never "repayment" / "debt" / "owed" / "collection".

## Files touched (S305)

```
legal/
  CONSUMER_TERMS_OF_SERVICE.md     (§ 5.1 cross-ref update +
                                    new § 5.5 + new § 5.6 +
                                    full § 9.1 rewrite into 6
                                    numbered sub-sections)
  CONSUMER_PRIVACY_POLICY.md       (§ 2.1 FlexDeposit bullet
                                    rewrite + § 4.2 Checkr +
                                    Collections Partner adds)
  BUSINESS_TERMS_OF_SERVICE.md     (new § 6.6 Payment Routing +
                                    new § 6.7 Collections
                                    Partner)

CLAUDE.md                          (Flex Suite section: counsel
                                    framing dropped; supersedence
                                    + collections-rent-only notes
                                    added)

~/.claude/projects/.../memory/
  project_gam_supersedence_routing.md  (legal-characterization
                                        addendum)
  project_sla_not_loan_principle.md    (bulletproof drafting +
                                        collections-rent-only)

SESSION_305_HANDOFF.md             (this file)
```

No code changes. No migrations.

## Decisions made during build

| Question | Decision |
|---|---|
| Add GAM-supersedence as a new sub-section or fold into existing § 5.1? | **New § 5.5.** Boldface "PLEASE READ" disclosure block calls attention to a non-obvious routing behavior the Tenant authorizes. Folding into § 5.1 would bury it. Also lets § 9.1.3 (FlexDeposit Authorization) cross-reference it cleanly. |
| Numbering for the new sub-sections in § 5? | **5.5 and 5.6** — kept the existing § 6 (Tenant Deposits) and following sections at their current numbering. No renumbering churn. |
| Strip the Checkr-FlexDeposit verbal association or just clarify? | **Strip entirely.** Nic's correct that even "we don't use Checkr for FlexDeposit" creates the association. Checkr now appears only in tenant-screening context; FlexDeposit eligibility section says "from your existing Platform account data" without invoking any third-party screening provider. |
| Apply the bulletproof drafting only to FlexDeposit, or also rework other Flex products? | **FlexDeposit only this session.** It's the highest-risk product (only one where GAM advances funds + tenant has scheduled installments). FlexPay, FlexCharge, FlexCredit have clean structures already. If counsel were reviewing, they'd focus 80%+ on FlexDeposit; same with the bulletproof pass. |
| § 9.1.5 Bankruptcy clause — assert non-claim, or stay silent? | **Assert non-claim.** "GAM will not assert any claim, secured or unsecured, against your bankruptcy estate for the unpaid FlexDeposit SLA balance." Strengthens the no-debt characterization in bankruptcy context. Bankruptcy courts have been the principal forum for recharacterization disputes on similar products; foreclosing a claim against the estate is a defensible signal that no debt exists. |
| § 9.1.5 Recharacterization severability — preserve no-recourse or fall to underlying credit terms? | **Preserve no-recourse + give-up-amounts-collected option.** § 9.1.5(c) keeps GAM's no-recourse election operative regardless of recharacterization. § 9.1.5(d) gives GAM the option to refund installments-in-excess-of-advance if recharacterization triggers an unsatisfied regulatory requirement (e.g., a state license GAM doesn't hold). That's the cleaner remedy than scrambling to license retroactively. |
| Mirror § 5.5 / § 5.6 into Business ToS? | **Yes.** Landlords need to understand the supersedence routing affects their settlement amounts. Landlord-side liability disclaimer (GAM not liable for rent shortfall) belongs squarely in Business ToS, not Consumer ToS. Same for Collections Partner — landlord-side awareness of FDCPA / FCRA furnisher obligations. |
| Strip "engage counsel" framing from Nic-pending in handoffs going forward? | **Yes — Nic explicitly affirmatively declined counsel pass.** Continuing to flag it would be ignoring a direct directive. Residual recharacterization risk noted in CLAUDE.md but not framed as "needs counsel." |
| Drop the "this is research, not legal advice" hedges from handoffs? | **No.** Handoffs are internal context, not customer-facing legal docs. Hedging in handoffs is appropriate — it tells future-Claude / Nic that the work is drafting, not licensed legal advice. Hedges stripped only from the live customer-facing legal docs. |

## Verification

- All four legal documents typecheck visually (section numbers
  in sequence; cross-references match destinations; no orphan
  section references).
- `grep -nE "^## [0-9]+\." CONSUMER_TERMS_OF_SERVICE.md`
  confirms 1 through 23, no gaps.
- Internal cross-references verified: § 5.1 → § 5.5/5.6 ✓;
  § 5.5 → § 5.2, § 9.1, § 9.2 ✓; § 5.6 → § 9.1 ✓; § 9.1.2 →
  § 5.6 ✓; § 9.1.3 → § 5.5 ✓; § 9.1.4 → various ✓; § 9.1.5 →
  § 9.1.1, § 9.1.2 ✓; § 9.1.6 (no cross-refs) ✓.
- No "Checkr" reference within 100 lines of any FlexDeposit
  reference in Consumer Privacy Policy — clean.
- No counsel-review language in live legal docs.

## Items deferred

- **FlexDeposit Service-Level Agreement template draft** —
  Consumer ToS § 9.1 now references the "FlexDeposit SLA you
  accept at enrollment." The actual SLA document still needs
  drafting. Different from the prior "credit agreement + TILA
  disclosure" framing; structure is: cover page + parties +
  schedule of service-fee installments + explicit reference
  to ToS § 9.1.1–9.1.6 for the substantive terms. Signed
  electronically at enrollment.
- **FlexPay subscription terms draft** — smaller scope.
- **OTP exclusion enforcement implementation** (S304 carryover)
  — backend gating for tenants with delinquent FlexDeposit SLAs.
- **Eligibility-check workflow design** (S304 carryover) —
  the "from your existing Platform account data" framing in
  § 9.1.6 / Privacy Policy § 2.1 needs an actual eligibility
  algorithm. Tenancy length, payment history on Platform,
  active-lease status, and any negative-events flags from the
  Platform's internal records. No third-party data sources.

## Items deferred (cross-session docket, unchanged)

- FlexCharge landlord-template draft (S301).
- FlexCredit referral disclosure draft (S301).
- Consumer-side retention framing decision (S300).
- Campground Master import path (Nic-blocked on sample).
- 2FA fan-out (walkthrough-blocked).
- Yardi GL-export columns, Rentec template (S293).
- Stats tile on admin Overview (S295/S296).
- PII redaction in admin list (S295).
- Per-platform notes / review history display (S296).
- Email notification deep links (S298).

## Nic-pending (counsel item removed)

Pre-existing:
- Stripe live keys.
- Resend domain verification.
- Plaid production keys.
- Stripe Terminal hardware.
- Checkr Partner credentials.
- Consumer-side retention framing decision (S300).

**Removed from Nic-pending (S305):**
- ~~Engagement with qualified counsel pre-launch~~ — Nic
  affirmatively declined; bulletproof drafting in live docs
  is the substitute. Item will not resurface.

## What S306 should target

1. **FlexDeposit Service-Level Agreement template** — small
   standalone document signed at enrollment. Lists the parties,
   the deposit amount advanced, the schedule of service-fee
   installments, the ACH-pull authorization, and incorporates
   Consumer ToS § 9.1 by reference for the substantive terms.
2. **FlexPay subscription terms** — auto-renewal compliance
   disclosure + cancellation mechanics. Probably one focused
   session.
3. **FlexDeposit eligibility-check workflow design** — Platform
   account-data inputs, threshold rules, decline-handling UX.
   Could be code or product-design work depending on what Nic
   wants first.
4. **OTP exclusion enforcement** — backend gating tied to
   FlexDeposit SLA delinquency.
5. **Wait for customer signal** if none of the above is urgent.

---

End of S305 handoff. Closed clean.
