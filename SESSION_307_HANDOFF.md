# Session 307 — closed

## Theme

Two-part session:

**Part 1 — FlexPay pricing reset.** The "$3 / $7 / $12 tiered
pricing" I'd been propagating since S304 was inherited from a
stale line in CLAUDE.md and was wrong. Replaced with the actual
pricing model Nic confirmed: **date-based formula. Monthly Fee
= $5 + ($1 × Scheduled Pull Date), capped at pull date 28
(range $6–$33).** Hunted down and corrected every instance.

**Part 2 — Failed-ACH retry framework + Stripe pass-through.**
Added the policy across all four legal docs + memory. Key
mechanics, refined through two Nic corrections during the
session:

- **ACH is all-or-nothing** (Nacha rule) — banks reject the
  entire pull on insufficient funds; no partial collection.
  Now disclosed explicitly so tenants understand why retries
  exist.
- **Retry amount splits by product type:**
  - **FlexPay (date-based formula):** retry pull amount is
    **recalculated** at the retry day under the formula.
    Originally-collected fee credits toward recalculated fee;
    only the increment is added to retry. Example: original
    11th = $16. Retry on 15th = $20. Tenant pays $4 increment
    + Stripe pass-through.
  - **FlexDeposit (fixed installment schedule):** retry pull
    amount is the **same Installment** as originally scheduled
    (the SLA's schedule is locked at enrollment). Stripe
    pass-through fee added on top.
- **Stripe pass-through fees apply universally** — every
  failed ACH across every product. At GAM's actual cost, no
  markup. Pre-authorized by Subscriber/Tenant at enrollment.
  Not a finance charge under Reg Z.

## Items shipped

### Pricing reset

- **`CLAUDE.md`** — Flex Suite section rewritten with the
  actual formula + worked example (pull on 11th = $16) +
  cap reasoning (days 29–31 unavailable due to variable
  month length).
- **`legal/FLEXPAY_SUBSCRIPTION_TERMS.md` § 3** — full rewrite
  from "Basic / Standard / Premium" tier table to date-based
  formula table with worked examples (1st = $6, 11th = $16,
  28th = $33). Placeholders for tenant's selected
  `{{Scheduled_Pull_Day}}` + computed `{{Selected_Monthly_Fee}}`.
- **`legal/CONSUMER_TERMS_OF_SERVICE.md` § 9.2** — formula +
  range + example + change-pull-date provision.
- **`legal/CONSUMER_TERMS_OF_SERVICE.md` § 5.2** — cross-ref
  updated to "calculated per the date-based formula in
  Section 9.2."
- **`legal/CONSUMER_PRIVACY_POLICY.md` § 2.1** — "Scheduled
  Pull Date you select (a calendar day from the 1st through
  the 28th); the calculated monthly subscription fee under
  the date-based formula" replaces "subscription tier
  selection."
- **`SESSION_304_HANDOFF.md` + `SESSION_306_HANDOFF.md`** —
  audit-trail notes inserted flagging the original (stale)
  numbers as "S307 correction."
- **`~/.claude/projects/.../memory/project_sla_not_loan_principle
  .md`** — formula + worked example.

### Retry framework + Stripe pass-through

- **`legal/CONSUMER_TERMS_OF_SERVICE.md` § 5.4** — section
  retitled "Failed ACH Pulls, Retries, Chargebacks, and
  Pass-Through Fees." Adds:
  - ACH all-or-nothing disclosure (Nacha R-codes).
  - Automatic retry policy (typical cadence ~3 business days,
    then ~5 if needed).
  - Retry-amount split by product type: date-based products
    (FlexPay) recalculate; fixed-schedule products (FlexDeposit
    installments) keep the same underlying amount.
  - Universal Stripe pass-through provision (actual cost, no
    markup, not a Reg Z finance charge, links to Stripe's
    public fee schedule).
- **`legal/CONSUMER_TERMS_OF_SERVICE.md` § 9.2** — added
  bullet: "Failed pulls re-price" (FlexPay-specific) with
  worked example and cross-ref to FlexPay Subscription
  Terms § 4.1 / § 4.2.
- **`legal/FLEXPAY_SUBSCRIPTION_TERMS.md` § 4** — restructured
  into 4.1 (Failed ACH Pull — Retry on a Later Day at a
  Recalculated Amount, with full worked example showing how
  the credit-toward-recalculated-fee mechanics work) and 4.2
  (Stripe Pass-Through Fees).
- **`legal/FLEXDEPOSIT_SLA_TEMPLATE.md` § 5** — split into
  5.1 (Failed ACH Pull — Retry at the Same Installment
  Amount, Plus Pass-Through Fees, with worked example showing
  fixed installment + accumulated Stripe fees) and 5.2
  (Revocation).
- **`CLAUDE.md`** — Flex Suite section gained per-product
  retry notes: FlexPay recalculates, FlexDeposit fixed-amount
  installment + pass-through.
- **`~/.claude/projects/.../memory/project_sla_not_loan_principle.md`**
  — same.

## Files touched (S307)

```
legal/
  CONSUMER_TERMS_OF_SERVICE.md           (§ 5.2, § 5.4, § 9.2)
  CONSUMER_PRIVACY_POLICY.md             (§ 2.1 FlexPay bullet)
  FLEXPAY_SUBSCRIPTION_TERMS.md          (§ 3 pricing reset,
                                          § 4.1 + § 4.2 retry +
                                          pass-through, signature
                                          placeholders updated)
  FLEXDEPOSIT_SLA_TEMPLATE.md            (§ 5.1 + § 5.2 split,
                                          retry behavior added)

CLAUDE.md                                (Flex Suite — formula +
                                          retry rules for both
                                          products)

~/.claude/projects/.../memory/
  project_sla_not_loan_principle.md      (formula + retry rules)

SESSION_304_HANDOFF.md                   (S307 audit note)
SESSION_306_HANDOFF.md                   (S307 audit note)
SESSION_307_HANDOFF.md                   (this file)
```

No code changes. No migrations. No schema work.

## Decisions made during build

| Question | Decision |
|---|---|
| Where did the wrong $3 / $7 / $12 pricing come from? | **Original CLAUDE.md project instructions.** That line had been there from before S289. Propagated forward into S304's Flex Suite rewrite, S306's FlexPay subscription terms template, and the memory file. Deleted from all locations; replaced with the actual formula. |
| Retry pull amount — same as original, or recalculated based on retry day? | **Depends on product structure.** Initially drafted as "same amount" for all products (Nic corrected). FlexPay's date-based formula re-prices on retry day; FlexDeposit's fixed installment schedule keeps the same underlying amount. Stripe pass-through applies universally. |
| FlexPay credit-toward-recalculated-fee mechanics — full re-charge or just the increment? | **Just the increment.** If the original $16 was already collected, only the $4 difference is added to the retry pull. Avoids double-charging. The recalculated $20 becomes the cycle's "actual" Monthly Fee. |
| FlexDeposit installment amounts — re-price on retry, or stay fixed? | **Stay fixed; pass-through fees added on top.** Initial Nic correction. The SLA schedule is locked at enrollment; retry just attempts the same installment. Stripe pass-through stacks on each failed-pull cycle. |
| ACH all-or-nothing — disclose explicitly, or assume tenants understand? | **Disclose explicitly.** Cited Nacha rules with example R-codes (R01 insufficient funds, R09 uncollected funds, R02 account closed). Helps tenants understand why retries exist at all — banks don't do partial settlements. |
| Stripe pass-through framing — service fee, GAM markup, or actual cost no markup? | **Actual cost, no markup.** Helps the not-a-finance-charge characterization under Reg Z (12 C.F.R. § 1026.4 excludes actual processing costs from the finance-charge definition). Linked to Stripe's public fee schedule rather than inlining a specific dollar amount — the schedule may change. |
| Document the audit-trail correction in historical handoffs S304 / S306? | **Yes, briefly.** A future session reading those handoffs would pull the wrong $3 / $7 / $12 numbers; the inline correction note prevents that without rewriting the historical record. |

## Verification

- `grep -E "\\\$3 / \\\$7 / \\\$12"` across all four legal docs,
  CLAUDE.md, and memory — no live instances; only the
  audit-trail correction notes in S304 + S306 handoffs (which
  explicitly flag the original numbers as inaccurate).
- `grep -i "tier-based\|tiered"` for FlexPay — no tier framing
  remains.
- Cross-references verified: Consumer ToS § 5.4 → FlexPay § 4.1
  + FlexDeposit SLA § 5.1; Consumer ToS § 9.2 → FlexPay § 4.1 +
  § 4.2; FlexPay § 4.1 → Consumer ToS § 5.4; FlexDeposit SLA
  § 5.1 → Consumer ToS § 5.4. All targets exist.
- No "loan" / "credit" / "debt" language outside the
  express-disclaimer paragraphs.

## Items deferred

- **FlexCharge Landlord-Account Agreement template** (S301
  carryover, was the S307 target until pricing-correction
  work consumed the session). Same pattern as the FlexDeposit
  SLA but landlord-as-creditor. Smaller drafting job since
  the legal weight is on the Landlord, not GAM. Probably one
  focused session.
- **FlexCredit referral disclosure** — blocked on third-party
  Lender partner selection.
- **OTP exclusion enforcement** (S304 carryover) — backend
  gating code to make the SLA's service-tier consequences
  real.
- **FlexDeposit eligibility-check workflow** (S304 carryover)
  — product + code work.
- **Platform integration of placeholder substitution** (S306
  carryover) — template engine renders `{{Variable_Name}}`
  placeholders at enrollment + stores signed PDF.

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

## What S308 should target

1. **FlexCharge Landlord-Account Agreement template** —
   originally the S307 target. Now the natural next legal-doc
   work; rounds out three of the four FlexSuite product
   templates (Deposit, Pay, Charge; Credit waits on partner
   selection).
2. **OTP exclusion enforcement** — code work to make the SLA's
   § 9.1.4(i) service-tier consequence operational. Backend
   gating + UI lockout.
3. **FlexDeposit eligibility-check workflow** — product +
   code work. Algorithm + UI for the "from your existing
   Platform account data" eligibility determination.
4. **Wait for customer signal** if none of the above is
   urgent.

---

End of S307 handoff. Closed clean. Context at handoff point per
CLAUDE.md guidance — start S308 fresh.
