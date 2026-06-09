# Session 292 — closed

## Theme

CSV-import migration tooling deepened against real competitor exports.
Three sample reports landed (DoorLoop XLSX × 5, Square Customer Directory,
Square Transactions); columns verified against the existing mappings;
gaps closed. Then the recurring pattern surfaced — DoorLoop and Square
both identify tenants by name on their transactions reports, not email —
and got fixed at the validation layer instead of working around it per
platform. Square went from "incompatible with our schema" to fully wired
9th platform.

## Items shipped

### S29X-round-3 research aliases (HIGH + MEDIUM confidence)

A background research agent dug verbatim column transcriptions for the
three doc-only platforms (Yardi, Rentec Direct, TenantCloud). Applied:

- **Yardi tenant**: `Sign Date` → lease_start; ignored `Resident Code`,
  `tcode`, `Recert Status` (Yardi-internal identifiers).
- **Yardi payment** (Breeze fall-2024 release notes, HIGH conf): moved
  `Receipt Type` from payment_method to payment_type (it enumerates
  Manual Receipt / Non-Person Payer Receipt / Zero Dollar Receipt —
  transaction classification, not method); added `Payment Method`.
- **Rentec tenant**: `Lease Expiration` → lease_end; `Market Rent` →
  monthly_rent; `Ledger Balance` / `Tenant Ledger Balance` →
  outstanding_balance.
- **TenantCloud property** (HIGH conf, bidirectional with import
  template): `Street` → street1; ignored `Country` + `Currency`.
- **TenantCloud tenant**: `Home Phone` / `Work Phone` / `Cell Phone`.
- **TenantCloud payment**: `Income Category` → payment_type;
  `Transaction ID` / `Payee` → reference; ignored `Reconciliation
  Status` / `Payout Status`.

All MEDIUM-confidence additions land with explicit S29X-round-3 comment
flagging "pending real-export verification" — same posture as
S29X-round-2 Buildium/RentManager additions.

### DoorLoop real-export refinements (Oak Park Motel and RV samples)

5 XLSX reports parsed (stdlib zip + ElementTree — no openpyxl
required): Rent Roll, Transactions, Rent paid, Leasing report,
Management fees settings. Real column variants extracted and added:

- **DOORLOOP_MAPPING (tenant)**: `Start date` / `End date` (lowercase d),
  `Deposits` (plural — singular was the only existing alias),
  `Current balance` / `Balance Due` → outstanding_balance. Tenant-name
  combined-string columns (`Lease`, `Lease Name`) moved to IGNORED on
  the tenant flow since the Rent Roll's combined-name format can't be
  auto-split.
- **PROPERTY_DOORLOOP_MAPPING**: `Size (sq. ft.)` → sqft (parenthesized
  unit was dropping); `Listing price` → rent_amount.
- **PAYMENT_DOORLOOP_MAPPING**: `Asset account` ignored (GL destination,
  not method).

Tenant + property notes updated with verbatim guidance: use the Tenants
list (not Rent Roll) for tenant import; use Properties (not Rent Roll)
for property import. The Rent Roll uses property as a section-header
cell rather than a per-row column — won't parse correctly.

### tenant_name canonical header + name-fallback resolution

The big architectural win this session. Both DoorLoop transactions and
Square transactions identify tenants by name only — no email column.
Rather than telling landlords to hand-add an Email column (S29X-round-3
initial DoorLoop posture), the fix landed at the resolution layer:

- **Schema change** (no migration — code only): added `tenant_name` to
  `GAM_PAYMENT_HISTORY_CANONICAL_HEADERS`. Wired into every platform's
  PaymentColumnMapping with platform-appropriate aliases:
  - DoorLoop: `Lease` / `Tenant Name` / `Tenant` / `Name` / `Lease Name`
  - AppFolio: `Tenant` / `Tenant Name` / `Resident` / `Resident Name`
  - Yardi: `Resident` / `Resident Name` / `Tenant` / `Tenant Name`
  - Plus RentManager, Propertyware, Rentec, TenantCloud, Buildium.
- **PaymentCsvRow type** updated (backend + frontend) with `tenantName`
  + `resolvedVia: 'email' | 'name'` provenance flag.
- **Validate resolution order**:
  1. Email → exact match against active-lease tenant index.
  2. If email missing/unmatched → tenant_name → fuzzy match against
     name index, disambiguated by property + unit on multi-match.
- **Name-matching helpers** in landlords.ts:
  - `normalizeTenantNameForMatch` — strips punctuation, collapses
    whitespace, lowercases.
  - `tenantNameVariants` — splits combined names on " & ", " and ", "/"
    (DoorLoop's "Kim Harland & Zach Harland" bundle); handles
    "Last, First" comma-inversion (AppFolio); strips middle initials
    ("Josh R. Roby" → "Josh Roby").
- **Required-field rule**: either tenant_email OR tenant_name must be
  supplied (was: tenant_email required).
- **Name index pre-load**: validate now pre-loads the full active-tenant
  roster for the landlord (was: only the emails referenced in the CSV).
  Typical landlord = dozens to low-hundreds of tenants; cheap single
  query, eliminates the per-row-name round-trip the alternative would
  require.

### Square as 9th platform with preprocessor

Square's transactions export has structural quirks the alias-mapping
pattern can't express — payment method split across columns (Card /
Cash / Other Tender / Square Gift Card), Event Type filtering for
refunds, Description parsing for rent/utility discrimination. Solved
with a generic preprocess hook:

- **PaymentPlatformConfig** gained an optional `preprocess?:
  PaymentPreprocess` field — a `(records) => records` function that
  runs against raw-column-name records before alias rewriting. Future
  platforms with similar quirks can reuse the hook.
- **squarePreprocess**:
  - Drops rows where `Event Type != "Payment"` (filters refunds, etc.).
  - Derives `__derived_method` from which amount column has a non-zero
    value: Card → 'card', Cash → 'cash', Square Gift Card → 'gift_card',
    Other Tender → lower(Other Tender Type) || 'other'.
  - Derives `__derived_type` from Description heuristics (electric/water/
    gas/utility/kw → 'utility', late fee → 'late_fee', deposit →
    'deposit', else default 'rent').
- **PAYMENT_SQUARE_MAPPING**: tenant_name ← `Customer Name`,
  payment_date ← `Date`, amount ← `Total Collected`, payment_method ←
  `__derived_method`, payment_type ← `__derived_type`, reference ←
  `Transaction ID` / `Payment ID` / `Order Reference ID`. No
  tenant_email / property_name / unit_number aliases — name fallback
  handles tenant resolution; Nic can correct property/unit on preview
  if needed.
- **PAYMENT_SQUARE_IGNORED**: 45+ POS metadata columns documented and
  silently dropped.
- **Square added to CsvImportPlatform union**; PLATFORMS + PROPERTY_-
  PLATFORMS entries set `enabled: false` (Square has no tenant-roster
  or property concept). PAYMENT_PLATFORMS entry `enabled: true`.
- **Frontend**: Square added to PaymentHistoryOnboardingPage's
  PLATFORM_OPTIONS; preview table gained a Name column next to Email;
  step-1 copy updated to reflect "email OR name" requirement.
- **PAYMENT_TYPE_MAP** gained `payment` → 'rent' + `monthly` → 'rent'
  to handle DoorLoop's bare `Payment` Type and Square's "Monthly..."
  descriptions.

### Notes updates

- DoorLoop payment notes rewritten — no more "add an Email column"
  instruction (name fallback handles it).
- DoorLoop tenant + property notes added verbatim guidance about using
  Tenants/Properties exports, not Rent Roll.
- Square payment notes flag the one-year export cap (multi-year
  migrations require multiple uploads) + the no-email tenant-matching
  posture.

## Files touched (S292)

```
apps/api/src/lib/
  csvImportMappings.ts             (~+250 lines net — Square platform +
                                    preprocessor, tenant_name across
                                    9 platforms, S29X-round-3 aliases
                                    for Yardi/Rentec/TenantCloud/DoorLoop)

apps/api/src/routes/
  landlords.ts                     (~+90 lines net — name-matching
                                    helpers, name-fallback resolution
                                    in payment-history validate,
                                    PaymentCsvRow.tenantName +
                                    resolvedVia, full-roster name index
                                    preload, expanded PAYMENT_TYPE_MAP)
  csvImportPaymentHistory.test.ts  (+9 new test cases: name fallback,
                                    combined-name "Kim & Zach",
                                    Last, First inversion, both-empty
                                    block, name-not-found block, Square
                                    method derivation × 3, Square
                                    refund-filter, Square no-tenant-
                                    match block; seed helper extended
                                    with tenantFirstName/LastName opts)

apps/landlord/src/
  pages/PaymentHistoryOnboardingPage.tsx
                                   (Square added to PLATFORM_OPTIONS,
                                    tenantName column in preview table,
                                    PaymentCsvRow type updated,
                                    instruction copy revised)

SESSION_292_HANDOFF.md             (this file)
```

## Decisions made during build

| Question | Decision |
|---|---|
| Square Customer Directory or Transactions export for migration? | **Transactions** — Customer Directory only has summary fields (Lifetime Spend, Transaction Count), not per-payment rows. Square's one-year export cap means multi-year migrations need multiple uploads; documented in platform notes. |
| Handle DoorLoop/Square missing-email at the platform notes level (tell landlord to add email column) or at the resolution layer? | **Resolution layer.** Adds a `tenant_name` canonical header + name-fallback resolution that benefits every future platform with the same gap. Avoids putting friction on every migration. |
| Handle DoorLoop combined names ("Kim Harland & Zach Harland") via name-splitting or by requiring landlord pre-split? | **Auto-split inside resolution.** Splits on " & ", " and ", "/" — finds the first part that matches an active tenant; resolves to that tenant's lease. Co-tenants on the same lease both belong to it so picking either is correct. |
| Square's payment_method split across 4 columns — generic preprocess hook or Square-only code path? | **Generic preprocess hook on PaymentPlatformConfig.** Future platforms (Yardi Voyager's batch receipts, RentManager's split allocations) will have similar quirks. Hook is one function field, opt-in per platform. |
| Square's `Source: Point of Sale` vs `Invoices` — filter to Invoices only? | **No filter.** Nic noted tenants sometimes pay rent via walk-in POS even when invoiced. POS sales to non-tenant guests get filtered out automatically by name-resolution (no matching tenant → row blocks, landlord can review). |
| DoorLoop's `Type: Payment` (generic) — block as unknown or default to rent? | **Default to rent.** Added `payment` → 'rent' to PAYMENT_TYPE_MAP. DoorLoop's payment rows are overwhelmingly rent in the tenant-payment-import use case; landlord can correct on preview. |
| Pre-load the full landlord-tenant roster for name lookups, or query per-CSV-row? | **Full roster preload.** One query for the entire active-lease set. Volume is small (dozens-to-low-hundreds per landlord); avoids N round-trips and the complexity of building a search-ranked name index. |
| Test the Square preprocessor with the real 611-row CSV in Downloads, or synthesized fixtures? | **Synthesized fixtures.** Each integration test sets up a minimal Square-shape CSV exercising one behavior (refund filter, method derivation by column, utility type detection, no-match block). Real-export validation belongs to Nic's smoke-walk pass when he has it. |

## Verification

- `cd apps/api && npx tsc -b` → clean.
- `cd apps/landlord && npx tsc --noEmit` → clean.
- `cd apps/api && npm test` → **226 / 226 passing** (was 217 at session
  start; +9 new cases in csvImportPaymentHistory.test.ts).
- No migrations this session — schema-compatible code-only changes.

## Items deferred (still on docket)

- **Real-export validation on Yardi / Rentec / TenantCloud** — MEDIUM-
  confidence aliases landed this session are marked "pending real-
  export verification" in inline comments. Confidence claims will firm
  up when Nic obtains a real customer export from any of those
  platforms.
- **Square one-year-cap UX** — multi-year migrations require multiple
  uploads. Currently each upload is independent (no batch / multi-file
  picker). If a landlord needs 5 years, that's 5 sequential clicks.
  Acceptable for now; revisit if it becomes friction.
- **Campground Master import path** — Nic mentioned having a Campground
  Master sample available; not pulled this session. Deferred to a
  later session for the RV-specific full path (property + tenant +
  payment-history).
- **2FA fan-out to other portals** — still walkthrough-blocked on the
  S290 admin portal. Pattern is mechanical to fan out once admin is
  validated; no movement this session.
- **Lawyer review of ToS arbitration + liability cap clauses** —
  unchanged from S291.
- **Host pick + deploy config** — Nic mentioned the dev team handles
  this. Out of session scope going forward.
- **Re-acceptance prompt for pre-S291 users** — confirmed not a real
  item (dev seed data only, no real users yet).

## Nic-pending (unchanged)

- Stripe live keys.
- Resend domain verification.
- Plaid production keys.
- Stripe Terminal hardware.
- Checkr Partner credentials.

## What S293 should target

1. **Campground Master import path** when Nic has the sample handy.
   RV-niche product strategic alignment.
2. **2FA fan-out** if and when the admin walkthrough lands.
3. **Real-export validation pass on the MEDIUM-confidence S29X-round-3
   aliases** — only when Nic has a real Yardi / Rentec / TenantCloud
   export from a trial account or prospective migration.

---

End of S292 handoff. Closed clean.
