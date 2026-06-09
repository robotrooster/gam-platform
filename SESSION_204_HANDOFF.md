# Session 204 — closed

## Theme

C1 phase 2 — expand the state_tax_forms catalog (S203) to four
more states + book frontend polish to surface the rich catalog
fields (agency_url, statute citation, notes) that were on the new
schema but not yet rendered.

## What S204 shipped

### Catalog expansion — 5 new forms across 4 states

Migration `20260508190000_state_tax_forms_expand.sql`:

- **NY** — NYS-45 (Quarterly Combined Withholding, Wage Reporting,
  and Unemployment Insurance Return)
- **IL** — IL-941 (Quarterly Withholding) + UI-3/40 (Quarterly
  Contribution and Wage Report)
- **FL** — RT-6 (Employer's Quarterly Reemployment Tax Return)
- **WA** — 5208 (Quarterly Tax and Wage Report)

Catalog total post-S204: 15 forms across 8 jurisdictions (US +
AZ, CA, TX from S203, plus NY, IL, FL, WA from S204).

Conservative posture maintained: only forms with clear statutory
basis, well-known form codes, and quarterly-or-simpler cadence
that fits the catalog's `due_dates` jsonb shape. Variable-cadence
forms (NY NYS-1 deposit returns, IL IL-501 semi-weekly schedule)
deferred — they require a per-employer cadence lookup that
doesn't fit the static catalog model. WA B&O tax (Combined
Excise Tax Return) deferred — typically exempt for residential
rentals per WAC 458-20-118; surfacing it without that nuance
would mislead.

### Books frontend — Filing Deadlines card rewrite

`apps/books/src/main.tsx` Tax Center:

- Renders the new S203 shape (`state_code`, `form_code`,
  `form_name`, `agency`, `agency_url`, `category`, `frequency`,
  `due_dates: [{label, due}]`, `statute`, `notes`) instead of the
  pre-S203 shape (`form`, `description`, `q1`/`q2`/...).
- Each row shows: form code (gold) + state badge + category
  badge / form name / per-due-date badges (one per `due_dates`
  entry) / agency · file-online link · statute citation / notes
  in italic.
- Empty state: "No filing deadlines apply to your current setup.
  Add employees, contractors, or properties to surface relevant
  forms."

The render is shape-agnostic to the number of due_dates entries
— quarterly forms render 4 badges, annual forms render 1.

### Files touched (S204)

```
apps/api/src/db/migrations/20260508190000_state_tax_forms_expand.sql  (NEW — 5 form rows)
apps/api/src/db/schema.sql                                            (regenerated)
apps/books/src/main.tsx                                               (Tax Center Filing Deadlines card — rewrite to handle S203 shape + render agency / agency_url / statute / notes)
```

### Verification

- `npm run db:migrate` → applied; schema.sql regenerated
- `psql gam -c "SELECT COUNT(*), COUNT(DISTINCT state_code) FROM state_tax_forms;"` → 15 / 8
- `cd apps/books && npx tsc --noEmit` → 0
- Books frontend renders new shape; old `q1`/`q2`/... fields gone

## Decisions made (S204)

| Question | Decision |
|---|---|
| Add WA B&O tax to the catalog? | No. Residential rentals are typically exempt per WAC 458-20-118 ("rentals of real estate" exemption). Adding it without the exemption nuance would mislead landlords. Phase 3 could add it with a more detailed `applies_to` predicate (e.g. `with_property_in_wa_AND_commercial`). |
| NY NYS-1 deposit returns? | No. Cadence varies per employer based on prior-year withholding (semi-weekly / monthly / quarterly). Static catalog can't represent that without a cadence lookup. Quarterly NYS-45 covers the headline. |
| OH / PA forms this session? | Skipped. Less confident in the form codes and cadences without verification. Phase 3 expansion (each state takes ~30 min of careful research; cumulative risk of getting one wrong on a tax surface is real). |
| Books frontend — backwards compatibility with the old shape? | No. The backend exclusively returns the new shape from `services/taxForms.ts`. Old shape no longer reachable. |
| Empty-state copy — what to say when no forms apply? | "No filing deadlines apply to your current setup. Add employees, contractors, or properties to surface relevant forms." Tells the user what triggers the catalog without overwhelming them. |
| Render `agency_url` as button vs inline link? | Inline link with ↗ symbol. Modest visual weight; matches the row's information density. Buttons would dominate the card. |

## Carry-forward — phase 3

### State catalog further expansion

After this session: covered ~80% of US population by landlord-
state. Remaining gaps for major-population-density states:

- **OH** — IT-941 (annual recon), IT-3 (transmittal), Ohio Job
  Family Services UI quarterly. Need to verify form codes.
- **PA** — PA-W3 (annual reconciliation), UC-2A/2B (UI), local
  EIT taxes (Act 32 LST/EIT). Per-locality complexity.
- **NC** — NC-3 (annual recon), NC-5 (quarterly withholding),
  NCUI-101 (quarterly UI).
- **GA** — G-7 (quarterly withholding), DOL-4 (UI quarterly).
- **VA** — VA-15/VA-16 (withholding), FC-20/21 (UI quarterly).
- **MA** — M-941 (quarterly withholding), 0500 (UI quarterly).
- **MI** — UIA 1028 (quarterly).
- **NJ** — NJ-927 / WR-30 (combined quarterly withholding + UI +
  wage reporting).

Each is half-an-hour of research + one INSERT. Cumulatively a
half-session for 5-8 states.

### Annual-refresh discipline doc

When 2027 starts, a migration extends every catalog row with
`effective_year = 2027`. Document the cadence in CLAUDE.md or
a dedicated DEPOSIT_INTEREST_PLAYBOOK.md alongside the deposit-
interest carve-out from S188.

### Already-known carry-forward (unchanged)

- B1+B2 phase 2B (PDF addendum auto-generation, multi-session)
- Sublease phase 3 (sub-tenant billing + invite-by-email)
- POS Terminal hardware
- Tenant-side LeasePage addendum-history section (S202 carry)
- A3 polish (mostly diminishing returns)
- Primary manager urgency tier (S185 — needs Nic input)
- Owner-financial-escalation pattern (S186 — needs Nic input)
- Other POS tables for property scoping (S192 carry)
- B3 hard-gate check-in (product fork)
- D2 Flex tenant suite (launch-flag gated)
- CSV imports (vendor format specs)
- E2 npm upgrades (risky)
- F1 Marketing rebuild

---

End of S204 handoff.
