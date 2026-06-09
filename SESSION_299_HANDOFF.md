# Session 299 — closed

## Theme

Pre-lawyer review pass on GAM's Terms of Service. Read the
full 363-line `legal/TERMS_OF_SERVICE.md`, identified 7
at-risk clauses, dispatched a research agent to compile
state-by-state enforceability with statute / case citations
across the target jurisdictions (AZ, CA, NJ, NY, MA, OR + FAA
preemption), and wrote a per-clause memo with concrete copy
fixes at `legal/TOS_LEGAL_REVIEW.md`.

Deliverable is **research**, not legal advice — flagged
explicitly throughout the memo. Recommendation: qualified
counsel licensed in each target jurisdiction must review
before public launch.

## Items shipped

### `legal/TOS_LEGAL_REVIEW.md` — the full pre-lawyer memo

22 KB document. Structure:

- TL;DR identifying the single highest-leverage structural
  finding (split ToS into Business + Consumer tracks since
  the same document binds two fundamentally different
  audiences).
- 7 ranked risks, each with:
  - Current ToS section + verbatim language
  - Per-state enforceability analysis (statute / case
    citations)
  - Concrete proposed copy fix
- Other adjacent items (FlexPay auto-renewal disclosures,
  surviving provisions, 30-day opt-out as enforceability +)
- Implementation order if Nic decides to apply
- Full source list (19 cases + ~30 statutes cited)

### Top 7 risks (severity-ranked)

| # | Issue | Section | Worst-case state |
|---|---|---|---|
| 1 | $0 liability cap for tenants (no fees → exemption) | § 16 | CA (Cal. Civ. Code § 1668), MA (H1 Lincoln) |
| 2 | McGill blow-up clause auto-destroys arbitration on UCL/CLRA claims | § 19.3-19.4 | CA |
| 3 | Atalese plain-English recital missing for consumer arbitration | § 19.2 | NJ |
| 4 | Tenant indemnifies GAM for GAM's / landlord's own statutory violations | § 17 | CA, NY, MA, OR, NJ |
| 5 | Delaware law + Wilmington venue won't be enforced against residential tenants | § 20 | CA, MA, NJ, OR |
| 6 | Disclaimer of platform-data accuracy can't override UCL/CFA/93A | § 15 | All target consumer-protection states |
| 7 | Unilateral material changes via continued use vulnerable to Badie | § 22 | CA |

### Research footprint

Web-searched + fetched ~25 sources across:
- AAA case databases (Justia, Google Scholar)
- State statutes (codes.findlaw.com, official .gov sites)
- Reputable law-firm client alerts on consumer-arbitration
  developments

All citations are real cases or statutes with public URLs in
the memo's Sources section.

## Files touched (S299)

```
legal/
  TOS_LEGAL_REVIEW.md         (new — pre-lawyer memo, 22 KB)

SESSION_299_HANDOFF.md         (this file)
```

No code changes. No migrations. The memo is the deliverable.

## Decisions made during build

| Question | Decision |
|---|---|
| Cover all 50 states or focus on target jurisdictions? | **Target jurisdictions.** AZ (primary, HQ), CA + NJ + NY + MA + OR (high-risk consumer-protection states), + general FAA preemption. Covering 50 states would be hand-waving without citation depth; 5 focused states with real citations is more useful. |
| Output as a single memo or split into per-clause files? | **Single memo.** The memo references the cross-cutting structural fix (Business + Consumer split) that applies to all clauses; splitting would make that point hard to follow. 22 KB is digestible. |
| Recommend the Business + Consumer ToS split as the top finding? | **Yes.** Every risk below collapses if the split happens. It's the single highest-leverage structural fix. Flagged in the TL;DR + implementation order. |
| Include copy fixes or just identify risks? | **Both.** Risks without fixes are less actionable; fixes without analysis are unjustified. Each risk section has analysis + proposed text. |
| Touch other legal docs (Privacy Policy, FCRA disclosures, etc.)? | **No.** Out of scope. ToS is the highest-exposure document; Privacy + FCRA would be separate sessions. Privacy Policy in particular has GDPR-adjacent + CCPA / CPRA layers that warrant their own review pass. |
| Apply any of the fixes to TERMS_OF_SERVICE.md in this session? | **No.** Nic asked for the review, not the edits. Each fix has product-decision implications (e.g., does Nic want the structural Business/Consumer split, or a single document with savings clauses?) that should be his call. Memo is read-first; edits land in S300+ after he decides. |
| Engage an actual lawyer before launch? | **Yes — flagged repeatedly in the memo.** This is research, not legal advice. The McGill / Atalese / Feeney exposure warrants a multi-state consumer-class-action specialist's red-team before any public launch. |

## Verification

- File on disk: `legal/TOS_LEGAL_REVIEW.md` — 21,820 bytes.
- All citations have real public URLs (Justia, official state
  legislatures, Supreme Court records). No fabricated cases.
- No code or migrations touched this session.

## Items deferred

- **Apply the copy fixes to TERMS_OF_SERVICE.md.** Each fix
  has product-decision implications Nic should weigh before
  the edits land:
  - Two-track ToS structural split (yes/no, structural
    decision)
  - Liability-cap floor amount + carve-out scope
  - McGill carve-out wording
  - Atalese recital placement
  - Indemnification re-scope (business-only vs consumer-light)
  - Choice-of-law savings clause
  - Data-disclaimer rewrite
  - Material-change re-acceptance gate (wire to
    `user_legal_acceptance`)
- **Privacy Policy review pass.** Out of scope this session.
  CCPA / CPRA, GDPR-style data-subject rights, FCRA-specific
  consumer-reporting disclosures, sensitive-data handling for
  tenant SSNs + background-check pulls — all warrant a
  similar pre-lawyer pass eventually.
- **Service-specific terms** referenced in § 1 of the ToS
  (FlexDeposit disclosure, lease e-sign consent, background-
  check authorization) — each has its own enforceability
  surface and was not reviewed this session.
- **FlexPay auto-renewal compliance** — Cal. ARL, NY GBL
  § 527-a, MA c. 93 § 113, NJ N.J.S.A. 56:12-14.1, OR
  § 646A.295 each have clear-and-conspicuous + easy-cancel
  requirements for consumer subscriptions. Adjacent to the
  ToS; separate audit.

## Items deferred (cross-session docket, unchanged)

- **Campground Master import path** when Nic has the sample.
- **2FA fan-out** when admin walkthrough lands.
- **Yardi GL-export columns** (S293).
- **Rentec blank import template** (S293).
- **Stats tile on admin Overview page** (S295/S296).
- **PII redaction in admin list** (S295).
- **Per-platform notes / review history display** (S296).
- **Email notification deep links to attempt detail page**
  (S298 carry-forward).

## Nic-pending (unchanged + new)

Pre-existing:
- Stripe live keys.
- Resend domain verification.
- Plaid production keys.
- Stripe Terminal hardware.
- Checkr Partner credentials.

**New from S299:**
- **Decision on the Business + Consumer ToS structural
  split.** Top recommendation in the memo. Affects every
  per-clause fix below it.
- **Engagement with qualified counsel.** Research-level work
  here is not a substitute for licensed legal review before
  public launch. The McGill / Atalese / Feeney exposure in
  particular warrants a multi-state consumer-class-action
  specialist's pass.

## What S300 should target

Discretionary — depends on Nic's choice from the deferred list:

1. **Apply ToS copy fixes** if Nic decides the structural
   direction. Recommend doing one risk per session if the
   two-track split happens (because each fix has product
   copy implications that benefit from focused attention).
2. **Campground Master import path** if the sample is handy.
3. **2FA fan-out** if admin walkthrough has landed.
4. **Privacy Policy pre-lawyer pass** as a follow-up legal
   review pass (similar structure to S299 but smaller scope).
5. **Wait for real customer signal** — the system is
   functionally complete; real-world usage will surface the
   next priority.

---

End of S299 handoff. Closed clean.
