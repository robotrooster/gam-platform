# Session 416 — closed

## Theme

**Seventh validation-hygiene micro-session.
S412 strict-validation pattern fanned out to
`POST /api/books/vendors` and `POST /api/books/employees`.**

Suite at S415 close: **1909 / 107 files**.
Suite at S416 close: **1928 / 107 files** (+19 cases,
no new file — added cases to existing test files).
0 failures. Runtime **62.75s** (suite baseline stable
post-S415 cleanup). Twentieth consecutive fully-green
full-suite run.

Zero tsc regressions.

## What shipped

### `POST /api/books/vendors`

**Pre-fix:** only `name` was required; everything
else passed through as `null`. An empty body
`{}` minus name returned 400; otherwise an
unidentifiable vendor row got created (no email,
no phone, no address, no payment terms, no tax ID).

**Post-fix:** strict zod schema requires:
```ts
name, contactName, email (format), phone (≥7 chars),
address, category, paymentTerms (enum), taxId
  (EIN XX-XXXXXXX or SSN XXX-XX-XXXX)
```

Two relaxations (flagged for Nic confirmation, same
pattern as S412 contractors EIN/SSN):
- `accountNumber` — optional. Many small vendors
  don't issue customer-specific account numbers.
- `notes` — optional. Free-text supplemental field.

`paymentTerms` enum: `['net15', 'net30', 'net45',
'net60', 'due_on_receipt', 'cod']`.

### `POST /api/books/employees`

**Pre-fix:** only `firstName`, `lastName`, `payType`,
`payRate` hand-checked. Everything else passed through
as `null`. An employee row could be created with no
email, no SSN, no address — useless for payroll.

**Post-fix:** strict zod schema requires:
```ts
firstName, lastName,
email (format), phone (≥7), address,
ssnLast4 (4 digits),
payType (enum: hourly|salary),
payRate (positive),
payFrequency (enum: weekly|biweekly|semimonthly|monthly),
filingStatus (enum: single|married|head_of_household),
federalAllowances (int ≥0),
title, department,
startDate (YYYY-MM-DD)
```

Plus the S91 back-compat: either `stateWithholdingPct`
OR the legacy `azWithholdingPct` is required (refine
clause). New name takes precedence when both supplied.

**No relaxations** — all employee fields are required
per the S398 default. Title/department are required
because employees of an LLC need org placement; if
that turns out to be too strict for a real onboarding,
Nic can relax.

## ⚠ Nic-pending: confirm the vendor relaxations

Two intentional relaxations on `POST /vendors`:
1. `accountNumber` optional
2. `notes` optional

**The choice for Nic:**
- **(A) Confirm as shipped** — the smart product call
  for small-vendor onboarding flexibility.
- **(B) Stricter** — require `accountNumber` too.
  Notes can stay optional since it's documentation.

Default to (A) until Nic decides. Same flag-back
posture as the S412 EIN/SSN conditional.

## Items shipped

### Route changes

```
apps/api/src/routes/
  books.ts                             (2 substantive:
                                         vendor zod
                                         schema + employee
                                         zod schema with
                                         legacy alias
                                         refine)
```

### Test changes — 19 net new cases

`books-contractors-vendors.test.ts`:
- Replaced 2 old POST /vendors tests with 10 new cases
- Net +8 cases pinning the strict contract

`books-accounts-employees.test.ts`:
- Replaced 3 old POST /employees tests with 14 new cases
- Net +11 cases pinning the strict contract

**Vendor POST cases (10):**
- Happy path with full payload
- Empty body → 400
- Missing name → 400
- Missing phone → 400
- Missing taxId → 400
- Invalid email format → 400
- Invalid paymentTerms enum → 400
- taxId wrong format → 400
- accountNumber + notes optional → 201 (pins relaxation)
- SSN-format taxId (sole proprietor) → 201

**Employee POST cases (14):**
- Happy path with full payload
- Legacy `azWithholdingPct` accepted in place of new
- New `stateWithholdingPct` takes precedence
- Empty body → 400
- Missing firstName → 400
- Missing ssnLast4 → 400 (was: NULL in DB pre-fix)
- Missing startDate → 400
- Invalid payType enum → 400
- Invalid payFrequency enum → 400
- Invalid filingStatus enum → 400
- startDate wrong format → 400
- ssnLast4 not 4 digits → 400
- payRate zero/negative → 400
- federalAllowances negative → 400

## Decisions made during build

| Question | Decision |
|---|---|
| Match the S412 pattern exactly? | **Yes.** Same zod-with-refine approach. Same "happyPayload() factory + per-case negative" test style. Consistency across the books CRUD surface. |
| Relax accountNumber on vendors? | **Yes — flag for Nic.** Realistic small-vendor scenario. Notes also optional (free-text). |
| Relax title/department on employees? | **No.** Org placement is genuinely useful; if a real flow trips on it, Nic relaxes. Strict-default per S398. |
| Honor the S91 azWithholdingPct legacy alias? | **Yes — via refine.** Backwards-compat is cheap; one of the two must be present. New name wins when both supplied. |
| paymentTerms enum value list? | **`['net15', 'net30', 'net45', 'net60', 'due_on_receipt', 'cod']`.** Standard AP terms. Schema has no CHECK, so I picked a sensible set. If a future flow needs `eom` (end of month) or `2/10 net 30`, one-line extension. |
| Add `payType: 'commission'` to the enum? | **No.** GAM rents collect cash, not commission. Hourly + salary covers the realistic landlord-employer scenarios; if a contractor commission flow is needed, that's the contractors table (S412), not employees. |
| Fix-it-right the `PATCH /vendors/:id` no-row-no-404 asymmetry noted in the existing test? | **No — out of scope.** S416 is POST validation only. The PATCH behavior is documented (existing test pins it); a separate hygiene pass can address. |

## Verification

- `npx tsc --noEmit` clean on apps/api (0 errors).
- `npm test` in apps/api: **1928 tests across 107
  files, 0 failures**, 62.75s. **Twentieth consecutive
  fully-green full-suite run.**
- 19 net new test cases across 2 existing test files.
- 0 production regressions.

## Items deferred — what S417 could target

### Validation-hygiene backlog (was 19, now 18)

Shipped in S416: S412 spawned (vendor + employee
strict validation).

Remaining:
- S413 spawned: vendor credit_balance CONSUMPTION on
  subsequent bills (the matching half of S386)
- S412 spawned: confirm entity-type-conditional
  EIN/SSN call (Nic-pending)
- **S416 spawned**: confirm vendor accountNumber/notes
  relaxation (Nic-pending)
- S411 spawned: disposable-domain fan-out
- S400 LEASE_TYPE_MATRIX ↔ CHECK drift
- S403 cross-landlord PI capture/cancel
- S405 bank_last4 null + ach_verified=TRUE defensive
- S405 /complete missing isExpired check
- S408 finding A (monthly-statement off-by-one
  default — Nic-pending)
- S408 finding B ($15 hardcoded fee — Nic-pending)
- S377 (a) email-blocked

### Cumulative bug-sweep totals (post-S416)

- **44 production bug fixes** (S416 is hardening
  the data-quality posture, not a bug discovery)
- 18 architectural / validation findings remaining
- 1928 tests across 107 files
- Suite baseline: **62-65s on a clean machine**

## What S417 should target

**Recommended: S411 spawned — disposable-domain
fan-out.** Apply the `DISPOSABLE_EMAIL_DOMAINS` Set
from S411 (tenants /profile route) to other email-
accepting routes: tenant invite, employee POST,
vendor POST, contractor POST, register-prospect.
Either extract to a shared lib helper or copy.

Fast iteration — single concept applied to ~5 routes.

**Alternatives:**
- S413 follow-on: vendor credit_balance CONSUMPTION
- S400 LEASE_TYPE_MATRIX ↔ CHECK drift (needs
  product input)
- S403 cross-landlord PI capture/cancel (Stripe
  round-trip required)
- Checkr wire-up (background.ts)
- Services audit start

---

End of S416 handoff. **S412 strict-validation pattern
shipped to vendors + employees: 19 new test cases
pinning each contract.**

1928 tests / 107 files / 0 failures. Twentieth
consecutive fully-green full-suite run.

**44 cumulative production bug fixes shipped across the
bug sweep.** Validation-hygiene backlog reduced from
19 to 18; 1 new Nic-pending confirmation (vendor
accountNumber/notes relaxation).
