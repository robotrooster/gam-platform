# Session 301 — closed

## Theme

Flex product creditor-clarification rework on the split legal
docs from S300. Nic clarified the four-product structure:

- **FlexDeposit** — GAM is the creditor (highest GAM-side
  regulatory exposure)
- **FlexPay** — GAM-operated subscription, no credit
- **FlexCharge** — Landlord is the creditor; GAM provides
  accounting software
- **FlexCredit** — third-party Lender is the creditor; GAM is
  a referral partner with a markup

The S300 documents conflated these (treated all four as
"GAM-facilitated" without naming the actual creditor). Reworked
the Consumer ToS § 9, the Consumer Privacy Policy data flows,
and added a new Business ToS § 11 covering the Landlord's
compliance obligations when extending FlexCharge credit.

## Items shipped

### Consumer ToS § 9 — full rewrite, sub-sectioned per product

Each FlexSuite product now has its own subsection with explicit
creditor identification and the regulatory framework that
applies:

- **§ 9.1 FlexDeposit (GAM-extended credit).** GAM is the
  creditor. Discloses TILA/Reg Z disclosures at enrollment,
  ECOA protections, FCRA framework for the underwriting
  consumer report, adverse-action notices, state lending
  licensing, usury limits.
- **§ 9.2 FlexPay (GAM subscription).** Explicit "not a loan,
  line of credit, or other extension of credit." Subscription
  product only.
- **§ 9.3 FlexCharge (Landlord-extended credit; GAM
  accounting).** Names Landlord as creditor. TILA / ECOA /
  FCRA / state lending law / usury law rights run against the
  Landlord, not GAM. GAM's role is software accounting only.
- **§ 9.4 FlexCredit (third-party Lender; GAM is a referral
  partner).** Names the FlexCredit Lender (identified at
  enrollment) as the creditor. Credit terms governed by
  Lender's terms; TILA/ECOA/FCRA rights run against the
  Lender, not GAM.

§ 1's service-specific-terms list updated to match the
clarified product framing.

### Consumer Privacy Policy — per-product data-flow rewrite

§ 2.1 "FlexSuite enrollment information" rewritten with
explicit creditor-aware data scopes:

- **FlexDeposit**: GAM collects underwriting consumer-report
  data because GAM is the creditor (FCRA-authorized).
- **FlexPay**: subscription data only.
- **FlexCharge**: GAM holds only transaction history; **GAM
  does not collect credit-underwriting data** — that lives
  with the Landlord.
- **FlexCredit**: GAM passes the application to the FlexCredit
  Lender, who holds the underwriting data; **GAM does not
  perform credit underwriting on FlexCredit**.

§ 4.2 service-provider list rewritten:

- Checkr now noted as performing consumer-report retrieval
  for FlexDeposit underwriting (since GAM is the creditor)
- "FlexCredit Lender" added as a discrete category of service
  provider (identified at enrollment)
- Footnote clarifying: Landlord (creditor on FlexCharge) is
  not a service provider, they're a counterparty already
  disclosed under § 4.1; FlexPay has no external partner.

### Business ToS — new § 11 Landlord-Extended Credit (FlexCharge)

48-line new section covering:

- **§ 11.1 You Are the Creditor.** Names the Landlord as the
  credit-extending party; GAM's role is accounting software
  only.
- **§ 11.2 Your Compliance Obligations.** Lists the legal
  frameworks the Landlord must comply with: TILA / Reg Z;
  ECOA / Reg B; FCRA (both as a user of consumer reports
  and as a data furnisher under § 623); state consumer-credit
  and lending laws; state usury statutes; FDCPA; state
  debt-collection laws. Explicit "consult counsel licensed in
  each state."
- **§ 11.3 GAM's Role and Disclaimers.** What GAM provides
  (accounting software, statements, payment-collection
  integration) and what GAM does NOT do (underwriting,
  credit limits, finance-charge calculation, furnishing data
  to CRAs, legal compliance review).
- **§ 11.4 Indemnification for FlexCharge.** Landlord
  indemnifies GAM for any claim that the Landlord's
  FlexCharge terms violate TILA / ECOA / FCRA / FDCPA /
  state lending / usury / consumer-credit / debt-collection
  law. Stacks on the general indemnification.

All later Business ToS sections renumbered (former 11–23
become 12–24), and all internal cross-references updated:

- Termination § 19.1 references "Section 22 below" (was
  Section 21)
- Class waiver § 20.3 references "this Section 20" (was 19)
- Opt-out § 20.5 references "this Section 20" (was 19)
- Governing Law § 21 references "Subject to Section 20" (was
  19)
- Surviving Provisions § 22 lists all section references in
  new numbering, adds § 11 to the list

## Files touched (S301)

```
legal/
  BUSINESS_TERMS_OF_SERVICE.md       (+~75 lines new § 11;
                                      renumbering of 13 later
                                      sections; 5 cross-reference
                                      updates)
  CONSUMER_TERMS_OF_SERVICE.md       (§ 1 list + § 9 entire
                                      rewrite — 4 sub-sections)
  CONSUMER_PRIVACY_POLICY.md         (§ 2.1 Flex bullet rewrite
                                      + § 4.2 service-provider
                                      rewrite)

SESSION_301_HANDOFF.md                (this file)
```

No business-side privacy policy changes (FlexCharge accounting
data flows were already covered correctly there).

## Decisions made during build

| Question | Decision |
|---|---|
| Where does FlexCharge live in Business ToS — new section or sub-section of existing? | **New Section 11**, between Lease Generation and Prohibited Conduct. Required renumbering all later sections + 5 cross-reference updates. The regulatory framework (TILA / ECOA / FCRA / state lending law) is substantial enough to warrant its own top-level section, not a sub-section of an existing topic. |
| Renumber or use 10A / 9.5 to avoid touching cross-references? | **Renumber.** For a real legal document, internal numbering consistency matters. The renumbering touches 13 headers + 5 cross-refs but produces a clean document. Skipping the renumber would leave a non-standard numbering pattern that flags as sloppy. |
| Treat FlexCharge as part of the Tenant Deposits section since both relate to Landlord financial flows? | **No — separate.** Deposits are operational money custody; FlexCharge is consumer credit extension. Different regulatory frameworks. Treating them together would conflate two distinct legal concepts. |
| FlexCredit Lender disclosure detail in the ToS, or defer to enrollment surface? | **Defer to enrollment surface.** ToS says "FlexCredit Lender, identified at enrollment" — the actual lender name lives in the product-specific terms, which is correct since the lender could change over time without ToS revision. ToS just names the legal structure. |
| Should the Business ToS § 11.4 stack indemnification with § 18, or replace it for FlexCharge? | **Stack.** § 11.4 says "in addition to, and not in limitation of, the general indemnification in Section 18." Landlord-as-creditor risk on FlexCharge is substantial enough that GAM wants a specifically-named FlexCharge indemnity in addition to the general indemnity. Both can apply to the same conduct without double-recovery (a single claim, single recovery). |
| Detail level on FlexDeposit's TILA / state lending discussion in the consumer ToS — high or low? | **Moderate.** Listed the protective frameworks (TILA disclosures, ECOA, FCRA, state lending and usury) but pointed to the FlexDeposit credit agreement at enrollment for the specifics (APR, fee schedule, payment terms). The ToS shouldn't try to be a credit agreement; it should set expectations and route to the actual agreement at the right moment. |

## Verification

- All four legal documents typecheck visually (section numbers
  in sequence; cross-references match destinations; no
  orphan section references).
- `grep -nE "^## [0-9]+\." BUSINESS_TERMS_OF_SERVICE.md`
  confirms 1 through 24, no gaps.
- Cross-references checked: Section 18 (Indemnification)
  reference, Section 20 (Dispute Resolution), Section 22
  (Surviving Provisions) all point to existing sections.

## Items deferred

- **Product-specific terms still need to be drafted as
  standalone documents.** The ToS now correctly names them as
  incorporated-by-reference but the actual:
  - **FlexDeposit credit agreement + TILA disclosure** — must
    include APR, finance charge, amount financed, total of
    payments, payment schedule, default consequences, FCRA
    adverse-action language. State-specific licensing
    disclosures.
  - **FlexCharge Landlord-account agreement** — drafted by GAM
    for the Landlord to use with their Tenants OR a template
    the Landlord can fill in. Landlord-side TILA/ECOA/FCRA/
    state disclosures still belong to the Landlord regardless
    of whether GAM provides the template.
  - **FlexCredit third-party Lender disclosure** — the
    Lender's own terms, served by GAM at the enrollment
    surface. GAM also needs to draft the **referral-fee
    disclosure** to comply with state consumer-financial-
    services rules (broker disclosure / referral fee
    transparency).
  - **FlexPay subscription terms** — pricing tiers, auto-
    renewal compliance (already noted in ToS § 9.5), monthly
    fee structure.
- **State licensing audit for FlexDeposit.** GAM needs to be
  licensed as a consumer lender in each state where it
  offers FlexDeposit. Some states require a residential
  rental-deposit-financing-specific license; most use
  general consumer-installment-loan licensing. Pre-launch
  research needed: which states GAM will offer FlexDeposit
  in; which require licensing; which exempt small-dollar
  short-term credit; usury caps per state.
- **TILA applicability for FlexCharge** — Landlords may or
  may not trigger TILA depending on credit frequency,
  payment installments, and finance-charge presence. The
  Business ToS § 11.2 puts the responsibility on the
  Landlord but GAM could helpfully publish guidance on when
  TILA likely applies. Not in scope for this session.
- **Frontend integration of split docs** (carryover from
  S300). Registration flows still need to be updated.

## Items deferred (cross-session docket, unchanged)

- Frontend integration of split ToS / Privacy Policy
- Service-specific terms drafts (now expanded above)
- Campground Master import path
- 2FA fan-out
- Yardi GL-export columns, Rentec template
- Stats tile on admin Overview
- PII redaction in admin list
- Per-platform notes display
- Email notification deep links
- Privacy Policy retention-language softening question
  (S300)

## Nic-pending (unchanged + new)

Pre-existing + carried forward:
- Stripe live keys.
- Resend domain verification.
- Plaid production keys.
- Stripe Terminal hardware.
- Checkr Partner credentials.
- Engagement with qualified counsel pre-launch.
- Consumer-side retention framing decision (S300).
- Frontend integration of split docs (S300).

**New from S301:**
- **State-licensing audit for FlexDeposit before launching the
  product in any state.** GAM-as-creditor on FlexDeposit means
  state consumer-lending licensing applies. Each target state
  needs a separate licensing-status check.
- **TILA-applicability guidance for FlexCharge Landlords** —
  optional but worth considering as a Landlord-onboarding
  helpdesk article.

## What S302 should target

1. **Frontend integration of split docs** (carried forward
   from S300). Quick session: update RegisterPage on both
   portals, marketing-site footer.
2. **Draft the four service-specific terms** (FlexDeposit
   credit agreement + TILA, FlexCharge Landlord agreement
   template, FlexCredit referral disclosure, FlexPay
   subscription terms). Probably its own focused session.
3. **State licensing audit for FlexDeposit** as a research
   pass, similar to the S299 ToS legal review. Outputs a
   per-state matrix of licensing requirements, usury caps,
   and any state-specific consumer-rental-deposit-financing
   rules.
4. **Wait for customer signal** if nothing above is
   immediately needed.

---

End of S301 handoff. Closed clean.
