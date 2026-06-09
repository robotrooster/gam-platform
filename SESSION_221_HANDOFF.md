# Session 221 — closed

## Theme

state_tax_forms catalog phase 9 — verification round for the
form-code-uncertain pile (OK, IA, ID, NM, WV) explicitly
flagged in S215 phase 8 carry-forward. Closes a sweep that
started at S203 with the federal + AZ/CA/TX seed.

## What S221 shipped

### Phase 9 catalog rows (10 forms, 5 states)

`apps/api/src/db/migrations/20260509110951_state_tax_forms_phase9.sql`:

| State | W/H reconciliation | UI quarterly |
|---|---|---|
| OK | OK W-2 Reconciliation (online_portal, Jan 31) | OES-3 (paper_form) |
| IA | IA W-2 Submission (online_portal, **Feb 15**) | 65-5300 (paper_form) |
| ID | Form 967 (paper_form, Jan 31) | TAX-020 (paper_form) |
| NM | RPD-41072 (paper_form, **Feb 28**) | ES-903A (paper_form) |
| WV | WV/IT-103 (paper_form, Jan 31) | WVUC-A-154 (paper_form) |

### State-level oddities surfaced + encoded

- **IA W/H**: Form 44-007 VSP retired starting TY2022; Iowa now
  uses W-2 electronic submission to IDR with a **Feb 15** deadline.
  Encoded as 'IA W-2 Submission' / online_portal so a landlord
  with property in Iowa doesn't think the only Jan-Feb deadline
  is the federal Jan 31. Distinct filing event from the federal
  W-2/W-3 to SSA. Iowa is the only state with a Feb 15 deadline.
- **NM W/H**: RPD-41072 due **Feb 28** per N.M. Stat. Ann. § 7-3-7
  ("on or before the last day of February of the year following").
  Mirrors AR AR3MAR / MI Form 5081 Feb 28 pattern.
- **OK W/H**: no standalone state W-3 paper form. Annual
  reconciliation is the W-2/W-3 transmittal filed electronically
  through OkTAP. Encoded as 'OK W-2 Reconciliation' / online_portal
  with a descriptive label, parallel to the MN/SD/WY/AK/NH/MA UI
  online-portal pattern from S207/S208.
- **ID Form 967**: Online-only via TAP starting TY2025. Encoded
  as paper_form because the form code is stable (not retired like
  AK TQ01 was). Note documents the TAP mandate. Same posture as
  AR DWS-ARK-209B and KS K-CNS 100 (mandatory e-file but stable
  code → paper_form).
- **WV UI**: Split across WVUC-A-154 (contribution) +
  WVUC-A-154-A (per-employee wage detail). Encoded as one row on
  the contribution form, wage detail mentioned in notes — same
  pattern as PA UC-2 / PA UC-2A from S208.

### Files touched (S221)

```
apps/api/src/db/migrations/20260509110951_state_tax_forms_phase9.sql  (NEW — 10 INSERT rows)
```

### Verification

- `npm run db:migrate` → 1 migration applied
- `psql gam -c "SELECT state_code, form_code, frequency, filing_method FROM state_tax_forms WHERE state_code IN ('OK','IA','ID','NM','WV') AND effective_year=2026 ORDER BY state_code, frequency DESC, form_code;"` → 10 rows (2 per state, all categories present)
- `psql gam -c "SELECT COUNT(DISTINCT state_code) AS states, COUNT(*) AS forms FROM state_tax_forms WHERE effective_year=2026;"` → **38 states / 69 forms** total catalog (up from the CLAUDE.md S205-era 11/22 figure — that note has drifted, current count is 38/69)
- No app code changed; consumed via existing books-portal annual summary surface

## Decisions made (S221)

| Question | Decision |
|---|---|
| Encode IA W/H or skip the row? | Encode. Iowa's Feb 15 W-2 submission deadline is exactly the kind of state-specific compliance gap the catalog exists for. Skipping would leave a landlord with Iowa property thinking the only Jan-Feb federal-or-state deadline is Jan 31. |
| OK W/H form code: descriptive label or skip? | Descriptive label 'OK W-2 Reconciliation' / online_portal. Same posture as the S207 MN UI / SD UI / WY UI / AK UI rows — when there's no paper code, encode with a clear descriptive label so the row's notes can document the actual filing event. |
| ID Form 967 — paper_form or online_portal given the TAP mandate? | paper_form. Pattern from S208 phase 6 + S215 phase 8: code-stable (even if e-file mandatory) → paper_form; code-retired (like AK TQ01) → online_portal. ID Form 967's code is the official designation — TAP is just the channel. |
| WV UI — one row or two for the contribution + wage split? | One row (WVUC-A-154). Same posture as PA UC-2 (phase 6) — the wage detail is always filed alongside the contribution form, so the canonical row is the contribution form with the wage form mentioned in notes. |
| OK UI — paper_form or online_portal given mandatory EZ Tax Express e-filing? | paper_form. OES-3 form code is stable. Same logic as ID Form 967 above. |
| Add cadence-variable W/H deposit forms (OK OW-9, IA IA W-1 monthly, etc.)? | No, deferred. Continues the established pattern from phases 6-8 (skipped OH IT-501, AR AR-941, KS KW-5, MS 89-105, MT MW-1) — annual W/H reconciliations cover the year-end picture; cadence-variable deposit forms are filing-frequency-specific and would clutter the catalog. |
| Update CLAUDE.md S177 note to reflect 38/69 instead of 11/22? | No, deferred. CLAUDE.md is checked-in (gitignored locally per the file header); the drift is incidental and will get refreshed organically next time S177 gets touched. Not blocking. |

## Carry-forward — S222+

### State tax form catalog

The phase-by-phase sweep is essentially complete. 38 states /
69 forms covers nearly all property-state-employer combinations
a US landlord would hit. Remaining gaps are intentional:

- **DC** — not a state, not in scope yet. Add when a landlord
  asks (or when DC property comes up in product).
- **HI, RI, ME, VT, ND, NE, UT, OR, KY, AL, IN, MO, OK
  cadence-variable W/H deposits** — same skipped-by-pattern
  reason as past phases (annual recon covers the year-end
  picture).
- **2027 effective_year refresh** — the annual-refresh discipline
  per CLAUDE.md S177 means a `*_state_tax_forms_year_2027.sql`
  migration in Nov/Dec 2026 to extend rows for next-year
  filings. Not blocking.

### Other already-known carry-forward

- POS thread polish — `pos_items.category → FK to pos_categories.id`
  refactor + `(landlord_id, name)` UNIQUE on pos_categories
  (S220 carry, low-priority pre-launch)
- Wire `pos_tax_rates` → cart math (S217 carry — substantive
  product call: stacking vs single rate)
- Sublease phase 3 (sub-tenant billing + invite-by-email)
- POS Terminal hardware
- A3 polish (mostly diminishing returns)
- Primary manager urgency tier (S185 — needs Nic input)
- Owner-financial-escalation pattern (S186 — needs Nic input)
- B3 hard-gate check-in (product fork)
- D2 Flex tenant suite (launch-flag gated)
- CSV imports (vendor format specs)
- E2 npm upgrades (risky)
- F1 Marketing rebuild

---

End of S221 handoff.
