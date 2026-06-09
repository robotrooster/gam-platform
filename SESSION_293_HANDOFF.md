# Session 293 — closed

## Theme

Public-source column research pass against Yardi (Voyager +
Breeze), Rentec Direct, and TenantCloud to firm up the
MEDIUM-confidence aliases that landed in S292's S29X-round-3.
Trial signups explicitly ruled out by Nic ("onboarding is the
biggest pain point — just scrape data/videos online"). A
research agent worked ~25 public sources; high-leverage
findings applied to `csvImportMappings.ts`; non-applicable
findings (Yardi GL-export shape, Rentec template gating)
folded into DEFERRED.md as carry-forwards.

## Items shipped

### Yardi (Voyager + Breeze) tenant — long-form date variants

TenantTech's published Yardi-integration field spec (the only
public source we found that names Yardi's resident-module fields
verbatim) confirms Yardi exposes `Lease From Date` / `Lease To
Date` / `Move-In Date` / `Move-Out Date` — full-phrase variants
distinct from the shorter `Lease From` / `Lease To` / `Move In`
/ `Move Out` we already had aliased. Added all four long-form
variants. `Move In Date` (no hyphen) added too since Yardi help
materials use both spacings.

### Yardi property — Building Type and Time Zone removed

`Building Type` was a speculative S29X alias not seen in any
public Yardi source. Removed. `Time Zone` similarly not seen on
any public Yardi rent-roll or property export; removed. (Time
Zone removal kept Yardi-only — other 8 platforms have prior
research backing their Time Zone aliases and were left alone to
avoid regressing.)

### Rentec Direct — verbatim help-doc column updates

Rentec's open help center is the most thorough of the three
researched platforms. Verified verbatim against help articles
518 (Add Properties), 519 (Add Tenants), 716 (Late Fee
Settings), 776 (Reports Overview):

- **PROPERTY_RENTEC_MAPPING**: `Nickname` added to property_name
  aliases (Rentec's own term for property name). `Square Footage`
  added to sqft. `Default Rent` added to rent_amount. `Default
  Security Deposit` added to security_deposit.
- **PROPERTY_RENTEC_IGNORED**: `Year Built`, `Multi-Unit Property`,
  `How Many Units`, `Description`, `Income Account`, `Expense
  Account`, `Property Reserve` documented as silently dropped
  (Rentec property fields GAM doesn't model).
- **RENTEC_MAPPING (tenant)**: `Overdue` added to late_fee_amount
  (Rentec's term for the late-fee field per article 716).
  `Primary Phone` removed (no Rentec source uses that phrasing;
  Rentec uses `Mobile Phone` exclusively).
- **PAYMENT_RENTEC_MAPPING**: `Check Number` + `Check #` added to
  reference (Rentec's customizable transaction column per article
  776 uses the literal hash character).

### TenantCloud — Q2 2025 column updates

TenantCloud's Q2 2025 release notes plus the rent-roll +
owner-statement + invoice-payment-activity help articles
documented several new and existing column names:

- **TENANTCLOUD_MAPPING (tenant)**: `Start Date` / `End Date`
  added to lease_start/lease_end (TC split the date column in
  Q2 2025). `Market Rent` added to monthly_rent (distinct TC
  column from contract rent). `Deposits held` / `Deposits Held`
  added to security_deposit.
- **TENANTCLOUD_IGNORED**: `Lease Duration`, `Lease number` /
  `Lease Number`, `Credits` documented as silently dropped.
- **PROPERTY_TENANTCLOUD_MAPPING**: `Size` added to sqft (TC's
  rent-roll column header). `Time Zone` removed (not exported by
  TC).
- **PAYMENT_TENANTCLOUD_MAPPING**: `Money In` added to amount
  (Owner Statement inflow column).
- **PAYMENT_TENANTCLOUD_IGNORED**: `Money Out` (Owner Statement
  outflows — owner draws, expenses), `Available on` / `Available
  On` (Q2 2025 payout-availability date), `Payment Account`
  documented as silently dropped.

### DEFERRED.md — S291 onboarding section updated

The "Still unproven against real exports" subsection rewritten
to reflect:
- S292 added DoorLoop + Square real-export verification.
- S293 added public-source research pass against Yardi / Rentec /
  TenantCloud (no real customer exports — trial signups ruled out
  by Nic).
- Two follow-ups carried forward:
  1. **Yardi GL-style export columns** — distinct from rent-roll
     exports. Boston Post's docs name `Transaction Number` /
     `Posting Date` / `Posting Month` / `Batch Memo` / `Class
     Code` / `Amount`. Yardi's GL export does NOT carry
     payment_method (real migration limitation if landlord shows
     up with GL data). Not wiring now — different shape, lower
     likelihood than receipt format.
  2. **Rentec import template (`Import-Properties-and-Tenants
     .xlsx`) is gated behind Rentec login.** Public help docs
     covered most of the property side; canonical Rentec import
     columns stay LOW-confidence until a real Rentec customer
     surfaces with the blank template.

## Files touched (S293)

```
apps/api/src/lib/
  csvImportMappings.ts        (~+40 lines net — Yardi long-form
                               date variants, Building Type +
                               Time Zone removed on Yardi/Rentec/
                               TC, Rentec Nickname / Square
                               Footage / Default Rent / Default
                               Security Deposit / Overdue / Check
                               # / Year Built ignored set, TC
                               Q2 2025 columns + Money In + Money
                               Out + Available on + size + Lease
                               Duration ignored)

DEFERRED.md                   (S291 onboarding section: real-
                               export status rewritten with
                               S292 + S293 progress notes,
                               two carry-forwards added)

SESSION_293_HANDOFF.md        (this file)
```

## Decisions made during build

| Question | Decision |
|---|---|
| Trial signups for Yardi / Rentec / TenantCloud? | **No.** Nic confirmed: "onboarding is the biggest pain point — just scrape data/videos online." Public sources only. |
| Apply low-confidence research aliases? | **Selective.** HIGH-confidence (verbatim vendor help-doc field labels) and MEDIUM-confidence (TenantTech integration spec for Yardi, verbatim Q2 2025 release notes for TC) applied. LOW-confidence (blog mentions, forum posts) skipped to avoid alias pollution. |
| Remove `Time Zone` across all platforms or just the researched three? | **Just the three.** Other 8 platforms have prior research backing (S29X round-2 et al.); removing speculatively would regress them. |
| Wire Yardi GL-export columns (`Transaction Number` / `Posting Month` / `Batch Memo` / `Class Code`)? | **Defer.** Different export format than the receipt-style transactions GAM's payment-history import is shaped around. Lower likelihood. Flagged in DEFERRED.md if a Yardi GL customer surfaces. |
| `Year Built` / `Multi-Unit Property` / `Income Account` etc. on Rentec property — add as aliases or ignored? | **Ignored set.** GAM doesn't model any of these at the property level. Documenting them as silently dropped prevents "unrecognized column" warnings without forcing schema changes. |
| `Money In` aliased to amount; `Money Out` ignored — confirm? | **Yes.** Owner Statement `Money In` is tenant→landlord inflow (= payment); `Money Out` is owner draws / expenses (= outflow, not a tenant payment). |
| `Primary Phone` on Rentec — keep as defensive alias or remove? | **Remove.** No public Rentec source uses that phrasing; Rentec uses `Mobile Phone` exclusively. Stray aliases are cheap but actively wrong ones risk false positives if some other platform's `Primary Phone` column accidentally gets imported under Rentec selection. |

## Verification

- `cd apps/api && npx tsc -b` → clean (no output).
- `cd apps/api && npm test` → **226 / 226 passing** (unchanged
  from S292 close). No new test cases this session — schema-
  compatible alias additions don't need new tests; the existing
  csvImportMappings.test.ts cases continue to cover the
  normalization pipeline.
- No migrations this session — code-only mapping updates.

## Items deferred (still on docket)

- **Yardi GL-export columns** — distinct export shape with no
  payment_method field. Surface as migration limitation if a
  Yardi GL customer arrives.
- **Rentec blank import template (`Import-Properties-and-Tenants
  .xlsx`)** — gated behind Rentec login. Highest-leverage ask if
  a real Rentec customer surfaces.
- **TenantCloud column-mapping step in import UI** — TC reports
  are user-customizable column-by-column, so TC exports vary
  wildly. Consider a per-import column-mapping confirmation
  step specifically for TC if migration friction surfaces.
- **Campground Master import path** — Nic mentioned having a
  Campground Master sample available; deferred to a later
  session for the RV-specific full path.
- **2FA fan-out to other portals** — still walkthrough-blocked
  on the S290 admin portal.
- **Lawyer review of ToS arbitration + liability cap clauses** —
  unchanged from S291–S292.
- **Real-export validation for Yardi / Rentec / TenantCloud** —
  S293 public-source pass firms up confidence as much as is
  publicly achievable; HIGH-confidence finalization requires a
  real customer export, which will surface organically as
  migrations happen.

## Nic-pending (unchanged)

- Stripe live keys.
- Resend domain verification.
- Plaid production keys.
- Stripe Terminal hardware.
- Checkr Partner credentials.

## What S294 should target

1. **Campground Master import path** when Nic has the sample
   handy. RV-niche product strategic alignment. Unchanged from
   S292 docket.
2. **2FA fan-out** if and when the admin walkthrough lands.
3. **TenantCloud column-mapping UI step** if/when a real TC
   migration surfaces and exposes column-customization friction.

---

End of S293 handoff. Closed clean.
