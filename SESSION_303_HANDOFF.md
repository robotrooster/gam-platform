# Session 303 — closed

## Theme

Pre-lawyer state-by-state licensing audit for the FlexDeposit
product (the GAM-as-creditor deposit-financing tier of the
FlexSuite product line). 15-state regulatory matrix with launch-
posture recommendations. Deliverable lives at
`legal/FLEXDEPOSIT_STATE_LICENSING.md`.

Same research model as S299: dispatched a research agent for
state-by-state statute + regulator compilation, then synthesized
into per-state cards with launch tiering. Output flagged
repeatedly as engineering research, not legal advice.

## Items shipped

### `legal/FLEXDEPOSIT_STATE_LICENSING.md` — 23 KB pre-lawyer memo

**Headline finding:** Every target state requires a license.
There is no "no-license" path for closed-end consumer
installment lending at the $500–$3,000 principal range in any
of the 15 states audited. National launch requires state-by-
state licensure.

**Five-state recommended first wave** (ordered by ease +
economics):

1. **Arizona** — HQ; DIFI; A.R.S. § 6-632 accommodates 36% on
   relevant principal bracket. Single-license path, ~90–180
   days via NMLS.
2. **Texas** — Tex. Fin. Code Chapter 342, Subchapter F is
   purpose-built for small-dollar installment lending; OCCC
   responsive; effective APR ceiling 32–48%.
3. **Georgia** — Highest effective APR ceiling (~50–60% via
   Installment Loan Act fee structure); Renter's Choice
   tailwind.
4. **Florida** — Post-2024 Chapter 516 amendments aligned to
   36% APR on relevant bracket; OFR responsive.
5. **Nevada** — No hard APR cap; second on GAM's stated
   roadmap. **Per-office licensing model** is the wrinkle —
   confirm operational structure (single online lending office
   vs per-property) before applying.

**Four-state second wave** (workable, constrained): Oregon
(36% all-in MAPR), Illinois (36% MAPR under PLPA),
North Carolina (tiered 36% on first $4K), New Jersey (30%
criminal-usury ceiling).

**Four-state third wave** (structural compliance work):
California (AB 539 mandatory CRA reporting conflicts with
FlexDeposit's tenant-elected reporting model + DFPI-approved
credit-ed curriculum + 12-month minimum term), Massachusetts
(23% APR ceiling + Ch. 93A treble exposure on disclosures +
strict deposit-statute interaction), Washington (25% APR
ceiling), Colorado (tiered cap + DIDMCA opt-out closes export
loophole), Pennsylvania (24% effective ceiling + aggressive
PA AG enforcement on true-lender doctrine).

**Avoid for launch:** New York. 1-month deposit cap (RPL
§ 238-a) shrinks principal economics, 25% criminal-usury
ceiling tight, BNPL rulemaking volatility, trust-account
structuring complexity. Defer until product matures.

### Key product-design implications

1. **State-specific disclosure addenda** required on top of a
   national TILA-base agreement. Every state has its own rate
   tiers, late-fee caps, and disclosure rules.
2. **APR target should be 35.9%** to comply with the three
   different 36%-style caps (OR all-in, IL MAPR, federal
   MLA) simultaneously. Higher APR forces per-state product
   variants.
3. **AB 539 mandatory CRA reporting conflicts** with the
   tenant-elected reporting model on $2,500+ loans in CA.
   Restructure required for CA launch (either mandatory CRA
   reporting, or keep CA loans under $2,500).
4. **Nevada per-office licensing** — operational decision
   needed before launch.
5. **Origination fee compression** — Oregon (36% all-in) and
   Illinois (36% MAPR) require zero or minimal origination
   fees. FlexDeposit credit agreement template should not
   assume an uncapped origination fee.

### Cross-cutting federal compliance (every state)

- TILA / Reg Z box layouts at origination
- FCRA authorization + adverse-action notices
- ECOA / Reg B non-discrimination
- **MLA 36% MAPR cap** on covered borrowers — DoD database
  check at origination
- CFPB UDAAP authority + state UDAP statutes (S299 carryover)

## Files touched (S303)

```
legal/
  FLEXDEPOSIT_STATE_LICENSING.md  (new — 23 KB pre-lawyer
                                   memo, 15-state matrix)

SESSION_303_HANDOFF.md             (this file)
```

No code changes. No migrations. The memo is the deliverable.

## Decisions made during build

| Question | Decision |
|---|---|
| Cover 50 states or focus on target jurisdictions? | **15 states** covering AZ + major rental markets (TX, FL, CA, NY, GA) + S299 high-risk states (NJ, MA, OR, CO, WA, PA) + GAM's stated post-AZ expansion target (NV) + Illinois (PLPA test case) + NC (recent amendments). 15 is enough citation depth without losing fidelity; the rest can be added as launches expand. |
| Output as a single memo or per-state files? | **Single memo.** The cross-cutting product-design implications (35.9% APR target, state-addendum strategy, MLA check workflow) are the bigger value than per-state cards in isolation. 23 KB is digestible. |
| Recommend the launch sequence as part of the memo or leave that to product strategy? | **Include the sequence with rationale.** Without a launch sequence the matrix is just data; the value-add is the synthesized ranking. The TL;DR opens with the 5-state first wave. |
| Apply any draft to existing legal docs (Consumer ToS § 9.1, Business ToS § 11)? | **No.** Memo is research; counsel-engaged drafting comes later. The ToS already names the regulatory frameworks (TILA, ECOA, FCRA, state lending laws) — those framings stay accurate regardless of which states launch. |
| Recommend engaging real counsel? | **Repeatedly throughout the memo.** California's AB 539 structural work, Massachusetts Ch. 93A disclosure exposure, and Pennsylvania's AG enforcement posture each demand state-specific counsel. The memo flags this at top, bottom, and in each Tier 3 state's card. |

## Verification

- File on disk: 23 KB.
- All citations reference real statutes with public state-
  legislature URLs.
- Regulator URLs verified during research; major ones (DIFI,
  OCCC, OFR, DFPI, NYDFS, NJDOBI, MA DOB, OR DFR, NV FID, CO
  AG, WA DFI, IDFPR, GA DBF, NCCOB, PA DoBS) all listed.
- The 5-state first wave matches GAM's stated rollout
  priorities (AZ HQ, NV roadmap, large rental markets).
- The "avoid for launch" call on New York is consistent with
  the S299 ToS review's flag on NY as one of the highest-risk
  consumer-protection states.

## Items deferred

- **Per-state license application workflow.** When Tier 1
  states are selected for actual launch, counsel files NMLS
  applications and manages regulator communications. Not in
  scope for engineering pre-lawyer research.
- **TILA disclosure template draft.** Closed-end TILA box
  layouts have specific font, ordering, and proximity rules
  per Reg Z Appendix H. Drafting that template is the next
  step after state selection.
- **AB 539 CRA reporting partner selection** (CA-specific
  structural).
- **MLA covered-borrower check workflow** (federal compliance
  routing — DoD MLA database integration or CRA flag).
- **NV per-office licensing strategy** (operational decision
  affecting NV regulatory burden).

## Items deferred (cross-session docket, unchanged)

- Service-specific terms drafts (S301, S302 carryover):
  FlexDeposit credit agreement + TILA, FlexCharge landlord-
  template, FlexCredit referral disclosure, FlexPay
  subscription terms.
- Consumer-side retention framing decision (S300).
- Frontend integration polish (S302 carryover, minor).
- Campground Master import path (Nic-blocked on sample).
- 2FA fan-out (walkthrough-blocked).
- Yardi GL-export columns, Rentec template (S293).
- Stats tile on admin Overview (S295/S296).
- PII redaction in admin list (S295).
- Per-platform notes / review history display (S296).
- Email notification deep links (S298).

## Nic-pending (unchanged + clarified)

Pre-existing:
- Stripe live keys.
- Resend domain verification.
- Plaid production keys.
- Stripe Terminal hardware.
- Checkr Partner credentials.
- Engagement with qualified counsel pre-launch.
- Consumer-side retention framing decision (S300).

**Clarified from S303:**
- **Counsel engagement for FlexDeposit licensing** in each Tier
  1 launch state. Memo identifies the licensing path per state
  but the application work is counsel's. AZ is the first call.
- **Operational decision on Nevada per-office licensing model.**
  Affects scaling overhead.
- **CA AB 539 restructuring decision** — either bring CA loans
  under the mandatory-CRA framework or hold them under $2,500
  to fall outside AB 539. Defer until California launch is
  actually on the roadmap.

## What S304 should target

The natural follow-ups after the licensing audit:

1. **FlexDeposit credit agreement + TILA disclosure template
   draft** — now informed by the state-by-state matrix. Single
   national base agreement + state-specific addendum slots.
   Probably one focused session.
2. **FlexPay subscription terms** — simplest of the four
   service-specific terms; subscription + auto-renewal
   compliance disclosures already cross-referenced in
   Consumer ToS § 9.5.
3. **FlexCharge landlord-template** — landlord-as-creditor
   under Business ToS § 11; template the landlord can fill in
   plus landlord-side TILA/ECOA/FCRA disclosure guidance.
4. **FlexCredit referral disclosure** — depends on which
   third-party lender GAM partners with; defer until partner
   is selected.
5. **Wait for Nic's product priorities** if drafting the
   service-specific terms isn't urgent.

---

End of S303 handoff. Closed clean.
