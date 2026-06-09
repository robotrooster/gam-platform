# Session 300 — closed

## Theme

Split the combined-audience ToS + Privacy Policy into two
audience-tracked documents each. The S299 memo's top
structural recommendation — Business Terms vs Consumer Terms
— is now in place, with the S299 per-clause fixes baked into
the consumer-side documents.

Product separation enforced: tenant-facing Flex products
(FlexDeposit / FlexPay / FlexCharge / FlexCredit) appear ONLY
on the consumer side; landlord-paid OTP reporting appears ONLY
on the business side. Matches the existing UI strict portal-
separation principle (memory: `project_flexsuite_otp_hidden`).

## Items shipped

### Four new legal documents

1. **`legal/BUSINESS_TERMS_OF_SERVICE.md`** (35 KB) —
   landlord / PM Company / staff. References OTP, business
   fees, Connect onboarding. No Flex tenant-product mentions.
   Keeps aggressive original liability cap, Delaware/Wilmington
   venue, AAA Commercial Rules arbitration, class waiver,
   broad indemnification — those clauses survive scrutiny
   against business users. Adds the S299 fixes that
   strengthen the document without weakening platform
   position: data-disclaimer rewritten as good-faith caveat,
   material-change re-acceptance gate.

2. **`legal/CONSUMER_TERMS_OF_SERVICE.md`** (33 KB) — tenants.
   Section 9 lists each FlexSuite product. Section 5.2
   discloses pass-through processing fees + FlexPay
   subscription fees. No OTP references anywhere.
   **All seven S299 fixes baked in:**
   - **Risk 1 — Liability floor.** Section 16: cap is
     greater of $100 or 12 months of tenant-paid fees;
     explicit carveouts for GAM's own fraud / willful /
     gross negligence / FCRA / Fair Housing / state UDAP
     statutes / deposit-return obligation / indemnification
     to consumer / any non-limitable liability under state
     law.
   - **Risk 2 — McGill carve-out.** Section 19.4 preserves
     CA public injunctive relief under UCL / CLRA / FAL.
     The S299 blow-up trigger from § 19.4 in the old doc
     replaced with "only that claim severed" wording.
   - **Risk 3 — Atalese plain-English recital.** Section 19
     opens with a bold-caps recital of jury-trial waiver
     and what arbitration means for the consumer.
   - **Risk 4 — Narrowed indemnification.** Section 17:
     tenant indemnifies only for own User Content, own
     breach, own violation of law, own IP/privacy
     infringement. Explicit "not obligated to indemnify
     GAM for GAM's own acts or omissions" or for other
     Users' acts.
   - **Risk 5 — Consumer choice-of-law savings clause.**
     Section 20: Delaware law governs except non-waivable
     state protections apply; consumer can bring non-
     arbitration disputes in Wilmington or home state at
     election; arbitration seated in home state at
     consumer election.
   - **Risk 6 — Good-faith data caveat.** Section 15
     rewritten (mirrors the business-side fix). Preserves
     non-waivable state rights language.
   - **Risk 7 — Click-through re-acceptance for material
     changes.** Section 22 splits material vs non-material;
     material changes require affirmative re-acceptance, not
     just continued use.

3. **`legal/BUSINESS_PRIVACY_POLICY.md`** (24 KB) — same
   audience split. Section 2 lists business-user data
   categories (KYC, beneficial owner, business entity,
   payroll, OTP enrollment-on-behalf-of-tenant). Section 4
   identifies OTP reporting partner as a service provider.
   Retains the indefinite-retention posture from the
   original Privacy Policy (still legally defensible per
   the broad statutory exceptions in every applicable state
   privacy law).

4. **`legal/CONSUMER_PRIVACY_POLICY.md`** (25 KB) — tenants.
   Section 2 covers FlexSuite enrollment data, rental
   application, screening consent, lease signature.
   Section 4 identifies FlexSuite product partners as
   service providers. Section 5 still notes retention but
   provides clearer language on deletion-request handling
   and the FCRA retention requirements that genuinely
   compel retention.

### Originals archived

```
legal/archive/
  TERMS_OF_SERVICE_PRE_SPLIT.md
  PRIVACY_POLICY_PRE_SPLIT.md
```

Moved (not deleted) for audit trail. The TOS_LEGAL_REVIEW.md
S299 memo stays in `legal/` as the historical record of why
the split happened.

## Files touched (S300)

```
legal/
  BUSINESS_TERMS_OF_SERVICE.md       (new)
  CONSUMER_TERMS_OF_SERVICE.md       (new)
  BUSINESS_PRIVACY_POLICY.md         (new)
  CONSUMER_PRIVACY_POLICY.md         (new)
  archive/
    TERMS_OF_SERVICE_PRE_SPLIT.md    (moved from legal/TERMS_OF_SERVICE.md)
    PRIVACY_POLICY_PRE_SPLIT.md      (moved from legal/PRIVACY_POLICY.md)

SESSION_300_HANDOFF.md                (this file)
```

No code or schema changes. The acceptance-tracking surface
(`users.accepted_tos_at` + `users.accepted_privacy_at`) still
works post-split since the document accepted is determined by
the user's role at registration time.

## Decisions made during build

| Question | Decision |
|---|---|
| Where do Flex products live? | **Consumer side only.** Each FlexSuite product (FlexDeposit, FlexPay, FlexCharge, FlexCredit) is enumerated in CONSUMER_TERMS_OF_SERVICE § 9. The business-side ToS has zero Flex references. Matches the existing UI portal-separation principle. |
| Where does OTP live? | **Business side only.** BUSINESS_TERMS § 3 + § 6.2 reference OTP as a landlord-paid Tenant-enrollment product. The consumer-side ToS has zero OTP references — the tenant doesn't see OTP exists. |
| Apply all 7 S299 fixes to consumer side or only some? | **All 7.** They're the consumer-side fixes; without them the consumer ToS is no better than what existed. The fixes have been refined and applied verbatim. |
| Apply any S299 fixes to business side? | **Two.** Risk 6 (data-disclaimer rewrite as good-faith caveat) and Risk 7 (material-change re-acceptance gate). Both strengthen enforceability without weakening platform position. The aggressive Risk 1 (liability cap), Risk 2 (arbitration scope), Risk 4 (broad indemnification), Risk 5 (Delaware venue) all stay aggressive on the business side because business users are the audience those clauses were designed for. |
| Arbitration administering rules — Consumer vs Commercial? | **Consumer Arbitration Rules on tenant side, Commercial Arbitration Rules on business side.** AAA distinguishes these rule sets specifically for this purpose: Consumer Rules limit consumer arbitration filing fees to $200 and shift the rest to the business; Commercial Rules treat the parties as sophisticated. Matches the audience. |
| Arbitration seat — Wilmington vs home state? | **Wilmington for business; home-state-at-claimant-election for consumer.** Consumer seat in home state defuses the Brower-style distance/cost unconscionability argument and aligns with AAA Consumer Rule recommendations. |
| Migrate `user_legal_acceptance` to track document type + version? | **Defer.** Current 2-column model works post-split since the document accepted is determined by user role at registration. Per-document-version tracking is a separate audit-trail enhancement for when re-acceptance happens (S300+ work). |
| Lease document references — both sides? | **Yes, with different framing.** Business side: § 10 puts compliance responsibility on the Landlord. Consumer side: § 8 makes clear GAM doesn't draft or advise on the lease and explicitly recommends consulting a tenant-rights attorney. |
| Inactivity timeout for account termination — keep 24 months? | **24 months business; 36 months consumer.** Tenants may go between leases; consumer side gets a slightly longer inactivity window. |
| Auto-renewal disclosure compliance for FlexPay? | **In-place in CONSUMER_TERMS § 9.** Lists each state's applicable auto-renewal statute (CA Bus. & Prof. § 17600 et seq., NY GBL § 527-a, MA Ch 93 § 113, OR § 646A.295, NJ N.J.S.A. 56:12-14.1) and confirms in-platform cancellation. |

## Verification

- All four new files on disk; verified with `ls -la`.
- Originals archived to `legal/archive/`.
- File sizes (33–35 KB per ToS, 24–25 KB per Privacy Policy)
  reflect substantive content, not boilerplate.
- All S299-flagged statute and case citations preserved in
  the consumer-side fixes (Cal. Civ. Code § 1668; CLRA;
  UCL; FAA; FCRA; state tenant-protection statutes).

## Items deferred

- **Apply the originals' indefinite-retention posture
  re-read.** Consumer-side Privacy Policy softened the
  language slightly (emphasizing per-request deletion
  evaluation against statutory exceptions). This is more
  defensible against state-AG scrutiny than a hard "we
  never delete" framing, but it's a softer position than
  the business-side and the original. If Nic wants the
  aggressive original retention posture restored on the
  consumer side, it's a 10-line edit.
- **Migration of `user_legal_acceptance` to per-document
  tracking.** Per decision above — deferred. Current
  registration-time stamping still works post-split.
- **Frontend integration.** The registration flows in
  `apps/landlord/src/pages/RegisterPage.tsx`,
  `apps/tenant/src/...` (tenant registration surface) need
  to be updated to display the appropriate ToS + Privacy
  Policy variant based on the user's role selection. Not
  done this session — code change for a future session.
- **Marketing site references.** `apps/marketing/`
  probably has footer links to /terms and /privacy that
  currently point to the combined-audience versions. Need
  to update to dispatch to business vs consumer variant
  based on user context or surface both options.
- **The S299 memo (`TOS_LEGAL_REVIEW.md`) referenced the
  old TERMS_OF_SERVICE.md** — references now point to an
  archived file. Memo is historical; not updating, but
  flagging.
- **Privacy Policy for the consumer side — softer retention
  framing** — see deferred-1 above. Open product question.

## Items deferred (cross-session docket, unchanged)

- **Campground Master import path** when sample is handy.
- **2FA fan-out** when admin walkthrough lands.
- **Yardi GL-export columns** (S293).
- **Rentec blank import template** (S293).
- **Stats tile on admin Overview page** (S295/S296).
- **PII redaction in admin list** (S295).
- **Per-platform notes / review history display** (S296).
- **Email notification deep links to attempt detail page**
  (S298).
- **Service-specific terms drafts** — the FlexDeposit
  disclosure, FlexPay enrollment terms, FlexCharge credit
  agreement, FlexCredit disclosure, lease e-sign consent,
  background-check authorization are each referenced by
  the new ToS but exist only as references — none have
  been drafted as standalone documents yet. Each is
  surface-specific copy that gets shown to the user at
  the enrollment / activation point.

## Nic-pending (unchanged + new)

Pre-existing:
- Stripe live keys.
- Resend domain verification.
- Plaid production keys.
- Stripe Terminal hardware.
- Checkr Partner credentials.
- Engagement with qualified counsel pre-launch.

**New from S300:**
- **Decision on consumer-side retention framing.** Softer
  per-request evaluation (current) vs aggressive indefinite-
  retention (original). Defaulted to softer for state-AG
  defensibility but flagged as a product choice.
- **Frontend integration of the split docs** in the
  registration flows and marketing-site footer links.

## What S301 should target

Discretionary — depends on Nic's choice:

1. **Frontend integration of split ToS / Privacy Policy.**
   Update RegisterPage components on landlord + tenant
   portals to display the appropriate variant. Update
   marketing-site footer. Probably one short session.
2. **Draft the service-specific terms** referenced in the
   new ToS (FlexDeposit disclosure, FlexPay enrollment
   terms, FlexCharge credit agreement, lease e-sign
   consent, background-check authorization). Each is its
   own copy artifact.
3. **Campground Master import path** if sample is handy.
4. **2FA fan-out** if admin walkthrough has landed.
5. **Wait for real customer signal.**

---

End of S300 handoff. Closed clean.
