# Session 306 — closed

## Theme

Drafted the two service-specific terms referenced from Consumer
ToS § 9 — FlexDeposit SLA template and FlexPay Subscription
Terms. Both follow the S305 bulletproof-drafting style: maximum
express-intent language, explicit no-credit/no-debt
characterization, incorporation of Consumer ToS by reference,
state-statute compliance baked in (auto-renewal disclosures
satisfying CA/NY/MA/OR/NJ ARL statutes on the FlexPay side).

Templates are populated with `{{Variable_Name}}` placeholders
the Platform fills in at enrollment.

## Items shipped

### `legal/FLEXDEPOSIT_SLA_TEMPLATE.md` — 14 KB

Customer-facing SLA signed at FlexDeposit enrollment. Ten
sections:

- **§ 1 Parties and Effective Date** — Tenant + GAM, signature-
  triggered effective date.
- **§ 2 Express Characterization and Intent** — full statute-
  precise list of what the SLA is NOT (TILA, ECOA, CFPA, FDCPA,
  state usury/lender statutes). Parties' express intent: SLA
  only.
- **§ 3 The Advance** — amount, date, destination (Landlord's
  pooled-custody account); explicit "not a loan", "no finance
  charge", "no security interest".
- **§ 4 Service-Fee Installments** — 12-row schedule table with
  placeholders for dates + amounts. Express note: total may
  equal, exceed, or fall below the Advance; that relationship
  doesn't transform the SLA into a credit transaction.
- **§ 5 ACH-Pull Authorization** — bank info placeholders;
  revocation right with 3-business-day notice; revocation does
  not create debt, only triggers Consumer ToS § 9.1.4
  service-tier consequences.
- **§ 6 Payment Routing Acknowledgment** — explicit
  acknowledgment + authorization of GAM-first routing (Consumer
  ToS § 5.5); explicit "GAM is not liable for rent shortfall."
- **§ 7 No Debt / No Recourse Acknowledgment** — repeats the
  no-recourse list from Consumer ToS § 9.1.2; explicit negative
  reference to the Collections Partner (§ 5.6) — "no role in
  this SLA."
- **§ 8 Term and Termination** — three termination triggers;
  bankruptcy forgiveness cross-ref to § 9.1.5.
- **§ 9 Incorporation of Consumer ToS** — by reference;
  conflict-resolution clause.
- **§ 10 Electronic Signature** — ESIGN Act + state UETA;
  audit trail (IP, user-agent, timestamp) is evidence.

Plus signature block with affirmative consent recitation
(read SLA, read Consumer ToS, authorized ACH, acknowledged
routing).

### `legal/FLEXPAY_SUBSCRIPTION_TERMS.md` — 15 KB

Subscriber-facing terms signed at FlexPay enrollment. Thirteen
sections:

- **§ 1 Parties and Effective Date.**
- **§ 2 Service Description** — payment-date coordination only;
  explicit "FlexPay does not modify any Landlord remedy for
  unpaid or late rent" disclaimer (covers the case where a
  Subscriber picks a later Scheduled Pull Date and tries to
  argue that defeats the lease's late-fee clock).
- **§ 3 Subscription Tiers and Fees** — three subscription
  tiers, names + monthly fees + features all as placeholders
  for the enrollment surface to populate (S307 correction:
  earlier draft inlined a "$3 / $7 / $12" reference which was
  inaccurate; pricing is set on the enrollment surface, not in
  the template); 30-day notice + continued-use for price
  changes.
- **§ 4 Subscription Fee Authorization** — separate ACH
  authorization from rent / FlexDeposit; failed pulls roll
  into GAM-side balance subject to GAM-first routing.
- **§ 5 GAM-First Payment Routing** — same acknowledgment
  pattern as FlexDeposit SLA § 6.
- **§ 6 Auto-Renewal Disclosure** — bold all-caps clear-and-
  conspicuous block citing each of the five state ARL statutes
  (CA Bus & Prof § 17600, NY GBL § 527-a, MA c. 93 § 113, OR §
  646A.295, NJ N.J.S.A. 56:12-14.1). Affirmative consent
  recitation. Acknowledgment-of-receipt note for CA § 17602(a)(3)
  compliance.
- **§ 7 Cancellation** — three methods: in-platform (primary),
  email, phone/mail. End-of-cycle cancellation. State-specific
  pro-rated refund carve-out in § 8 below.
- **§ 8 Refunds** — non-refundable default; state-specific
  pro-rated refund carve-out (CA ARL, NJ TCCWNA) on request.
- **§ 9 No Credit Extension; No Debt** — same statute-precise
  list as FlexDeposit SLA § 2; explicit non-payment remedies
  (rolling balance into GAM-first routing, scheduling-feature
  suspension, GAM cancellation) — no collections, no CRA
  furnishing, no court action.
- **§ 10 Term and Renewal.**
- **§ 11 Termination** — Subscriber via § 7; GAM with notice
  for failed pulls / bankruptcy / account closure / Consumer
  ToS § 18.2 events / discontinuation (with pro-rated refund
  in discontinuation case).
- **§ 12 Incorporation of Consumer ToS** — by reference;
  conflict-resolution.
- **§ 13 Electronic Signature.**

Plus affirmative consent block enumerating each item being
consented to (terms, tier, ACH, auto-renewal, GAM-first
routing, incorporation of Consumer ToS).

## Files touched (S306)

```
legal/
  FLEXDEPOSIT_SLA_TEMPLATE.md       (new — 14 KB)
  FLEXPAY_SUBSCRIPTION_TERMS.md     (new — 15 KB)

SESSION_306_HANDOFF.md              (this file)
```

No code changes. No migrations. No edits to existing legal
docs — the new templates are purely additive, referenced from
the existing ToS § 9.1 and § 9.2.

## Decisions made during build

| Question | Decision |
|---|---|
| Should the SLA template repeat Consumer ToS § 9.1's substantive language, or just incorporate by reference? | **Incorporate by reference; repeat only the load-bearing characterization.** The SLA repeats the express-intent paragraph (§ 2) and the no-debt/no-recourse acknowledgment (§ 7) because those are the load-bearing structural claims; the rest of § 9.1 is incorporated by reference under § 9 of the SLA. Repeating everything would create inconsistency risk on future edits. |
| Twelve-installment schedule, or variable? | **Twelve fixed.** Standard 12-month FlexDeposit term per the platform default. If a different term is offered (6-month, 24-month), the table can be regenerated; the rest of the SLA template doesn't change. |
| Include scheduled pull-date variable per installment, or implicit (monthly on Effective Date day)? | **Explicit per installment.** The Platform fills in each Due Date and amount. Explicit table maximizes Subscriber-side clarity and the audit-trail completeness; avoids ambiguity if the Effective Date is the 31st of a month. |
| FlexPay refund framing — strict no-refund or state-aware? | **State-aware.** Default non-refundable per Consumer ToS § 10, with explicit state-law pro-rated refund carve-out in § 8. Pro-rated refund is on request, not automatic; this avoids leaking refunds to subscribers in states that don't actually require it while being responsive when state law does. |
| FlexPay non-payment remedies — describe the consequences in the Subscription Terms, or leave to Consumer ToS? | **Describe explicitly in § 9.** The Subscription Terms are signed independently; making the consequences visible at signature is operationally cleaner than burying them in a ToS cross-reference. Same drafting style as FlexDeposit SLA § 7. |
| "FlexPay does not modify any Landlord remedy" — necessary? | **Yes.** Without this, a Subscriber who picks a Scheduled Pull Date AFTER their lease's rent due date could argue (a) GAM endorsed the date as the new rent-payment deadline, or (b) GAM is a party to the lease and consented to the rent-payment shift. Section 2 disclaims both. The Landlord retains all lease remedies regardless of the FlexPay schedule. |
| Phone / mail cancellation channels alongside in-platform — required? | **Yes for CA, advisable everywhere.** Cal. Bus. & Prof. Code § 17602(c) requires online-signup subscriptions to provide "exclusively online" cancellation; offering additional phone/mail channels exceeds that floor and satisfies the more onerous NY GBL § 527-a "in the manner the subscriber wishes to terminate" standard. |

## Verification

- File sizes — both templates land between 13–15 KB,
  substantively complete without padding.
- Cross-reference integrity — both templates reference Consumer
  ToS sections by their current numbering (§ 5.5, § 5.6,
  § 9.1.x, § 9.2, § 9.5, § 10, § 16, § 17, § 18.2, § 19, § 20).
  All target sections exist in the live Consumer ToS.
- No "Checkr" reference in either template (consistent with
  S305 strip).
- No "loan" / "credit" / "debt" / "owed" language outside the
  express disclaimer paragraphs (consistent with the SLA-not-
  loan drafting principle in `project_sla_not_loan_principle.md`).
- Placeholder format `{{Variable_Name}}` consistent across both
  templates; the Platform's template engine fills in real
  values at enrollment time.

## Items deferred

- **FlexCharge Landlord-Account Agreement template** (S301
  carryover) — the third service-specific term referenced
  from Business ToS § 11 and Consumer ToS § 9.3. Landlord is
  the creditor on FlexCharge; the template is between
  Landlord and Tenant with GAM providing the accounting
  infrastructure. Smaller than FlexDeposit SLA since the
  legal weight is on the Landlord, not GAM. Probably one
  half-session.
- **FlexCredit referral disclosure** (S301 carryover) —
  blocked on third-party Lender partner selection. The
  disclosure names the specific Lender, its terms, and the
  referral-fee structure.
- **OTP exclusion enforcement** (S304 carryover) — backend
  gating tied to FlexDeposit SLA delinquency. Code work,
  not legal drafting.
- **FlexDeposit eligibility-check workflow** (S304 carryover)
  — algorithm + UI for the Platform-account-data eligibility
  determination referenced in Consumer ToS § 9.1.6.
- **Platform integration of placeholder substitution** — the
  Platform's template engine needs to render the
  `{{Variable_Name}}` placeholders with real values at
  enrollment time, then store the resulting PDF / signed
  record alongside the audit-trail (IP, user-agent,
  timestamp). The legal templates are complete; the
  rendering pipeline is the code-side counterpart.

## Items deferred (cross-session docket, unchanged)

- Consumer-side retention framing decision (S300).
- Campground Master import path (Nic-blocked on sample).
- 2FA fan-out (walkthrough-blocked).
- Yardi GL-export columns, Rentec template (S293).
- Stats tile on admin Overview (S295/S296).
- PII redaction in admin list (S295).
- Per-platform notes / review history display (S296).
- Email notification deep links (S298).

## Nic-pending (unchanged)

- Stripe live keys.
- Resend domain verification.
- Plaid production keys.
- Stripe Terminal hardware.
- Checkr Partner credentials.
- Consumer-side retention framing decision (S300).

## What S307 should target

1. **FlexCharge Landlord-Account Agreement template** —
   completes the legal-doc system for the three GAM-defined
   FlexSuite products (Deposit, Pay, Charge). FlexCredit
   waits for partner selection.
2. **OTP exclusion enforcement** — backend gating to make
   the SLA's § 9.1.4(i) service-tier consequence real. Code
   work.
3. **FlexDeposit eligibility-check workflow** — product +
   code work, defines what "qualified for FlexDeposit" means
   in Platform-account-data terms.
4. **Platform integration** of the new template's placeholder
   substitution and signature flow — code work, tied to the
   existing e-signature infrastructure.
5. **Wait for customer signal** if none of the above is
   urgent.

---

End of S306 handoff. Closed clean.
