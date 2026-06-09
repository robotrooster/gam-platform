# Session 302 — closed

## Theme

Frontend integration for the S300 split legal docs. Marketing
server now serves four audience-scoped legal pages and an
audience-picker at the bare `/terms` and `/privacy` paths.
Four registration surfaces (landlord, PM-company, tenant
accept-invite, tenant background-check) deep-link to the
correct variant for their audience. Closes the S300 carryover.

## Items shipped

### Marketing server — audience-scoped legal routes

`apps/marketing/server.js` rewritten:

- **New routes** for each audience-scoped doc:
  - `/business/terms`   → `BUSINESS_TERMS_OF_SERVICE.md`
  - `/business/privacy` → `BUSINESS_PRIVACY_POLICY.md`
  - `/consumer/terms`   → `CONSUMER_TERMS_OF_SERVICE.md`
  - `/consumer/privacy` → `CONSUMER_PRIVACY_POLICY.md`
- **Bare `/terms` and `/privacy`** now serve an audience-picker
  with two cards ("For Landlords & PM Companies" / "For
  Tenants"). External links and unattributed traffic land
  here and self-route.
- **Inter-doc reference rewrites** updated for the four new
  doc filenames (was 2 regex rules for the originals; now 4
  for the audience-scoped files).
- **Audience-banner** at the top of each rendered legal page
  shows the current audience and a link to the other version
  ("Looking for the other version? For Tenants →").
- **Footer rewritten** to surface all four documents in three
  columns: Landlords/PM, Tenants, Contact.

Originals are gone from `legal/` — the server would have
errored on the old paths. Verified by smoke test that the new
routes render and the picker pages include their "Which
version" copy.

### Registration surfaces deep-link to the right variant

Four surfaces updated:

- **`apps/landlord/src/pages/RegisterPage.tsx`** → `/business/*`
- **`apps/pm-company/src/pages/RegisterPage.tsx`** → `/business/*`
- **`apps/tenant/src/pages/AcceptInvitePage.tsx`** → `/consumer/*`
- **`apps/tenant/src/pages/BackgroundCheckPage.tsx`** → `/consumer/*`

The change in each is a one-line edit per link (terms + privacy
= two links per surface = 8 link edits total). The
`acceptedTerms` flag in the DB stays unchanged; the user is
stamping acceptance of whichever audience-variant they were
shown at the time.

### Verification

- `node -c apps/marketing/server.js` → syntax OK.
- Smoke test against running marketing server:
  - `/business/terms` returns HTML with audience-scoped
    content.
  - `/consumer/terms` returns HTML.
  - `/terms` returns audience-picker (verified via grep for
    "Which version" sentinel).
  - `/privacy` same.
- `cd apps/landlord && npx tsc --noEmit` → clean.
- `cd apps/tenant && npx tsc --noEmit` → clean.
- `cd apps/pm-company && npx tsc --noEmit` → clean.
- No code changes in `apps/admin` (admin users register
  via super-admin invite, not a public Register page —
  no ToS-acceptance step in the admin flow today).

## Files touched (S302)

```
apps/marketing/
  server.js                                       (rewrite —
                                                   audience-scoped
                                                   routes +
                                                   picker page +
                                                   four-link
                                                   footer)

apps/landlord/src/pages/
  RegisterPage.tsx                                (2 link edits)

apps/pm-company/src/pages/
  RegisterPage.tsx                                (2 link edits)

apps/tenant/src/pages/
  AcceptInvitePage.tsx                            (2 link edits)
  BackgroundCheckPage.tsx                         (2 link edits)

SESSION_302_HANDOFF.md                            (this file)
```

No API changes. No migrations. No schema work. Database
acceptance tracking unchanged.

## Decisions made during build

| Question | Decision |
|---|---|
| Audience scoping pattern — query param vs URL segment? | **URL segment** (`/business/terms`, `/consumer/terms`). Cleaner, cacheable, self-documenting in browser history. Query-param approach would make picker logic fuzzier (is `?audience=unknown` the picker or an error?). |
| Bare `/terms` and `/privacy` — redirect to picker, redirect to default, or render picker inline? | **Render picker inline.** External / unattributed traffic lands here. Redirect-to-business or redirect-to-consumer would silently pick the wrong doc for the other audience. The picker is two cards on a clean page — fast to scan, zero ambiguity. |
| Audience banner on rendered legal page — top of page or footer? | **Top, above the title.** Visitors who landed via the right route should still see a "Showing: For Landlords & PM Companies" banner so they know which version they're reading and can switch if they came from the wrong link. |
| Footer on legal pages — show all four docs or just the two for the current audience? | **All four, columnar.** Visitor might be reading Business Terms and realize they actually need Consumer Privacy. Three-column footer (Landlords/PM, Tenants, Contact) handles this without sprawl. |
| Update `accepted_tos_at` / `accepted_privacy_at` DB columns to track which variant was accepted? | **No** — defer to a future session if version-tracking becomes needed for compliance. Current columns just stamp a timestamp; the variant accepted is implied by the user's role at registration time, which is unambiguous because each registration page serves a single variant. Per-variant version tracking is a separate audit-trail concern from the integration. |
| Add a /terms /privacy redirect from the legacy paths the originals served at? | **N/A — same URLs reused.** The bare `/terms` and `/privacy` paths now serve the picker. External backlinks to those URLs still resolve to a useful page. Old archive paths (`legal/TERMS_OF_SERVICE.md`) are filesystem-only — never served. |

## Items deferred

- **Per-document-version acceptance tracking.** Current model
  stamps `users.accepted_tos_at` / `accepted_privacy_at`
  timestamps. If the ToS or Privacy Policy is materially
  revised, the existing acceptance becomes ambiguous (which
  version did the user accept?). Migrating to a separate
  `user_legal_acceptances` table (user_id, doc_type,
  doc_version, accepted_at) is the eventual fix. Not needed
  for launch but worth doing before the first material
  revision lands.
- **Marketing landing page footer.** The current
  `apps/marketing/src/index.html` (the landing page) may also
  have hard-coded `/terms` and `/privacy` footer links — those
  now hit the picker page, which is acceptable but could be
  upgraded to surface both variants directly on the landing.
  Smoke-checked the server renders, didn't audit the index
  HTML this session.
- **Admin portal registration.** Admin users register via
  super-admin invite, not a public Register page; no
  ToS-acceptance gate exists in that flow today. If a
  ToS-acceptance step ever gets added to admin onboarding,
  point it to `/business/*`.

## Items deferred (cross-session docket, unchanged)

- **Service-specific terms drafts** (S301): FlexDeposit credit
  agreement + TILA, FlexCharge landlord template, FlexCredit
  referral disclosure, FlexPay subscription terms.
- **State licensing audit for FlexDeposit** (S301).
- **Consumer-side retention framing decision** (S300).
- **Campground Master import path.**
- **2FA fan-out** when admin walkthrough lands.
- **Yardi GL-export columns / Rentec template** (S293).
- **Stats tile on admin Overview** (S295/S296).
- **PII redaction in admin list** (S295).
- **Per-platform notes display** (S296).
- **Email notification deep links** (S298).
- **Lawyer review pre-launch** (carryover from S299).

## Nic-pending (unchanged)

- Stripe live keys.
- Resend domain verification.
- Plaid production keys.
- Stripe Terminal hardware.
- Checkr Partner credentials.
- Engagement with qualified counsel pre-launch.
- Consumer-side retention framing decision (S300).
- State-licensing audit for FlexDeposit (S301).

## What S303 should target

1. **Service-specific terms drafts** (S301 carryover) —
   FlexDeposit credit agreement + TILA disclosure is the
   highest-priority since GAM-as-creditor needs proper
   regulatory disclosure documents. FlexPay subscription terms
   is the simplest. FlexCharge landlord-template + FlexCredit
   referral disclosure round out the set.
2. **State licensing audit for FlexDeposit** — research pass
   similar to S299. Per-state matrix of consumer-lender
   licensing requirement, usury cap, small-dollar exemptions.
3. **Campground Master import path** if Nic has the sample.
4. **Wait for customer signal.**

---

End of S302 handoff. Closed clean.
