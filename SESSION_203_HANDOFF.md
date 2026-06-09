# Session 203 — closed

## Theme

C1 — 50-state property tax form catalog phase 1. Per CLAUDE.md
S177 carve-out: "State tax form catalog — each state has its own
quarterly/annual withholding + unemployment forms with state-
specific due dates. Per-property (LLCs file by state). GAM
surfaces the deadlines; we do NOT file forms on anyone's behalf."

S91 had previously stripped state-specific tax forms from the
hardcoded list in `routes/books.ts:1269` with a comment that said
"becomes landlord-configurable in a follow-up." S203 is that
follow-up — but instead of landlord-configurable, it's a hardcoded
catalog with annual-refresh migration cadence (matching the S188
deposit-interest model).

## What S203 shipped

### Schema — `state_tax_forms` table

Migration `20260508180000_state_tax_forms.sql`:

- Columns: state_code (US for federal, 2-letter for state),
  form_code, form_name, agency, agency_url, category, frequency,
  due_dates jsonb, applies_to, statute, notes, effective_year.
- CHECK constraints on state_code, year range, category enum,
  frequency enum, applies_to enum.
- UNIQUE(state_code, form_code, effective_year) for idempotency.

`applies_to` values:
- `all_landlords` — every landlord
- `with_employees_in_state` — landlord has any active books_employee
- `with_contractors_paid_600` — any books_contractor with ytd_paid ≥ $600
- `with_property_in_state` — landlord owns property in this state

### Initial seed — 10 forms across 4 jurisdictions

**Federal (US):** 941 (quarterly withholding), 940 (annual FUTA),
W-2/W-3 (annual wage statements), 1099-NEC (annual contractor).

**Arizona:** A1-QRT (quarterly withholding), A1-R (annual recon),
UC-018 (quarterly unemployment).

**California:** DE-9 (quarterly contribution + wages), DE-9C
(quarterly wage adjustment).

**Texas:** C-3/C-4 (quarterly UI; no state income tax).

Each row includes statute citation + agency URL + notes. NY, IL,
FL, others to follow in phase 2 once the surface is verified.

### Service — `services/taxForms.ts`

`getApplicableTaxForms(landlordId, year)` returns the deadlines
applicable to this landlord:

1. Pulls landlord context: has_employees, has_contractors_paid_600,
   property_states (DISTINCT from properties.state).
2. Federal forms with applies_to matching the landlord's context.
3. State forms (state_code = property's state) with applies_to=
   'with_property_in_state'.
4. Sorted: federal first, then state alpha, then category, then
   form_code.

Returns shape `{ state_code, form_code, form_name, agency, agency_url,
category, frequency, due_dates: [{label, due}], statute, notes }[]`.

### Backend integration — `routes/books.ts` tax summary

Replaced the federal-only hardcoded `filingDeadlines` array
(S91 era) with a call to `getApplicableTaxForms`. Books portal's
annual tax summary now picks up state-specific forms automatically
based on the landlord's property states. No frontend changes
needed — the existing render iterates whatever array comes back.

### Files touched (S203)

```
apps/api/src/db/migrations/20260508180000_state_tax_forms.sql       (NEW — schema + 10-form seed)
apps/api/src/db/schema.sql                                          (regenerated)
apps/api/src/services/taxForms.ts                                   (NEW — getApplicableTaxForms helper)
apps/api/src/routes/books.ts                                        (filingDeadlines from helper, not hardcoded)
```

### Verification

- `npm run db:migrate` → applied; schema.sql regenerated
- `psql gam -c "SELECT ... FROM state_tax_forms"` → 10 rows confirmed
- `cd apps/api && npx tsc --noEmit` → 0
- No frontend changes (books portal renders whatever filingDeadlines
  comes back; new shape is a superset of the old)

## Decisions made (S203)

| Question | Decision |
|---|---|
| Hardcoded catalog or landlord-configurable? | Hardcoded with annual-refresh migration cadence per CLAUDE.md S177 carve-out. Landlord-configurable would let landlords set their own deadlines, which defeats the compliance-protection purpose — landlords don't always know what they're supposed to file. |
| Initial seed size — all 50 states or starter? | Starter (AZ, CA, TX + federal). The schema is the bigger commitment; expanding the seed is a single INSERT migration per state. Phase 2 adds NY, IL, FL, OH, PA, WA, etc. as those landlords come online. |
| `due_dates` shape — fixed columns (q1, q2, q3, q4) or jsonb? | jsonb. Some states have monthly returns (NY NYS-1 reconciliation), some have unique cadences (biennial filings). jsonb keeps the schema flat. Each row's frequency tells the consumer what to expect. |
| Federal forms in same table or separate? | Same table, state_code='US'. Simplifies the consumer query (one SELECT, one ORDER BY). Federal forms are still distinguished via state_code at render time if needed. |
| `applies_to='with_contractors_paid_600'` — exact threshold logic? | Sums ytd_paid from books_contractors. The federal threshold is $600 in a calendar year for 1099-NEC. ytd_paid resets per-year via the books accounting flow. |
| Books portal frontend changes? | None. The existing render loops `filingDeadlines` agnostic of shape. The new helper returns a richer shape (statute, agency_url, notes, jsonb due_dates) but the books frontend just shows form name + due date — extra fields are forward-compat. Polish to surface statute citation + URL is phase 2. |

## Carry-forward — phase 2

### State catalog expansion

- **NY** — NYS-45 (quarterly combined W/H + UI + wage), NYS-1 (reconciliation)
- **IL** — IL-941 (quarterly withholding), UI-3/40 (quarterly UI), IL-501 (periodic withholding payment)
- **FL** — RT-6 (quarterly reemployment tax)
- **OH** — IT-941 (annual withholding), IT-3 (transmittal), Ohio Job Family Services (UI quarterly)
- **PA** — PA-W3 (quarterly withholding), UC-2 (quarterly UI)
- **WA** — UI quarterly + B&O tax forms
- + ~40 more states as landlords need them

Each is a single INSERT migration. Half-session per 5-10 states
(research + verification dominates).

### Books portal frontend polish

- Surface `agency` + `agency_url` so landlord can click through to
  file
- Render `statute` citation as tooltip / detail expand
- Show `notes` inline for context

### Annual-refresh discipline

When 2027 starts, a migration extends every row to effective_year=2027.
Per CLAUDE.md S177: "annual-refresh migration cadence." Document
the cadence in CLAUDE.md or DEPOSIT_INTEREST_PLAYBOOK.md alongside
the deposit-interest carve-out.

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

End of S203 handoff.
