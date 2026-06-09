// S231: Per-platform CSV import mapping registry. Translates a competitor's
// tenant-export CSV column headers to GAM's canonical generic headers, so
// landlords migrating from Buildium / AppFolio / DoorLoop / etc. can drop
// their export into TenantOnboardingPage without hand-editing the column
// names first.
//
// The shape: each platform declares an alias array per canonical header.
// applyMapping() walks the raw parsed records and rewrites keys to the
// canonical names, dropping unmapped columns. The /validate endpoint then
// runs unchanged against the rewritten records.
//
// Adding a platform: copy the Buildium block, fill in the alias arrays
// from the platform's actual export sample, and flip `enabled: true` in
// PLATFORM_OPTIONS on TenantOnboardingPage.tsx (frontend).

export type CsvImportPlatform =
  | 'generic'
  | 'buildium'
  | 'appfolio'
  | 'doorloop'
  | 'yardi'
  | 'rentmanager'
  | 'propertyware'
  | 'rentec'
  | 'tenantcloud'
  | 'square'

// GAM's canonical generic headers (same list as CSV_GENERIC_HEADERS in
// landlords.ts; duplicated here so the mapping module is self-contained).
//
// S29X: outstanding_balance added — when a landlord migrates from a prior
// platform we want day-1 AR to carry. Commit translates a non-zero value
// into an opening-balance invoice attached to the imported lease.
export const GAM_CANONICAL_HEADERS = [
  'first_name', 'last_name', 'email', 'phone',
  'property_name', 'unit_number',
  'lease_start', 'lease_end', 'monthly_rent',
  'security_deposit', 'late_fee_amount', 'late_fee_grace_days',
  'auto_renew', 'auto_renew_mode', 'notice_days_required',
  'outstanding_balance',
] as const

export type GamCanonicalHeader = typeof GAM_CANONICAL_HEADERS[number]

// Per-canonical-header list of accepted source aliases. Empty array means
// the platform doesn't expose this field — landlord can fill it in by hand
// after upload, or we leave it blank and let the validator flag it.
type ColumnMapping = Record<GamCanonicalHeader, readonly string[]>

interface PlatformConfig {
  enabled:           boolean
  label:             string
  columnMapping:     ColumnMapping
  // Optional: source headers we know exist but should be silently dropped
  // (e.g., Buildium's "Status" column we don't carry through). Documents
  // intent so a future audit doesn't wonder why these were ignored.
  ignoredColumns?:   readonly string[]
  // Optional: notes to show in the UI / template download header.
  notes?:            string
}

// Generic = identity mapping. Used when landlord downloaded GAM's own
// template and filled it in; columns are already canonical.
const GENERIC_MAPPING: ColumnMapping = {
  first_name:           ['first_name'],
  last_name:            ['last_name'],
  email:                ['email'],
  phone:                ['phone'],
  property_name:        ['property_name'],
  unit_number:          ['unit_number'],
  lease_start:          ['lease_start'],
  lease_end:            ['lease_end'],
  monthly_rent:         ['monthly_rent'],
  security_deposit:     ['security_deposit'],
  late_fee_amount:      ['late_fee_amount'],
  late_fee_grace_days:  ['late_fee_grace_days'],
  auto_renew:           ['auto_renew'],
  auto_renew_mode:      ['auto_renew_mode'],
  notice_days_required: ['notice_days_required'],
  outstanding_balance:  ['outstanding_balance'],
}

// Buildium "Active Tenants" export. Buildium's tenant-list report combines
// tenant contact info + active lease info on a single row, which is the
// shape GAM expects. Columns are based on Buildium's documented export
// (Properties → Rentals → Reports → Tenant List, default columns), with
// common aliases for variants.
const BUILDIUM_MAPPING: ColumnMapping = {
  first_name:           ['First Name', 'Tenant First Name', 'FirstName'],
  last_name:            ['Last Name',  'Tenant Last Name',  'LastName'],
  // S29X research: Buildium's resident-template CSV uses `Login email`
  // (verbatim from RentCheck transcription of Buildium's import template).
  // Without this alias every Buildium resident email is silently dropped.
  email:                ['Email', 'Email Address', 'Tenant Email', 'Login email'],
  // `Mobile` (bare, no "Phone" suffix) is the actual Buildium resident-
  // template column header — added per S29X round-2 research.
  phone:                ['Mobile Phone', 'Mobile Phone Number',
                         'Primary Phone', 'Phone', 'Home Phone', 'Mobile'],
  property_name:        ['Property', 'Property Name', 'Rental Property'],
  unit_number:          ['Unit', 'Unit Number', 'Unit Name'],
  lease_start:          ['Lease Start', 'Lease Start Date', 'Move-in Date',
                         'Move In Date'],
  lease_end:            ['Lease End', 'Lease End Date', 'Move-out Date',
                         'Move Out Date'],
  monthly_rent:         ['Rent', 'Rent Amount', 'Monthly Rent', 'Market Rent'],
  security_deposit:     ['Security Deposit', 'Deposit', 'Deposit Amount'],
  late_fee_amount:      ['Late Fee', 'Late Fee Amount'],
  late_fee_grace_days:  ['Late Fee Grace Days', 'Grace Period',
                         'Grace Period (Days)'],
  // Buildium does not expose these fields in tenant-list exports —
  // landlord fills in after upload (or accepts GAM defaults).
  auto_renew:           [],
  auto_renew_mode:      [],
  notice_days_required: [],
  outstanding_balance:  ['Outstanding Balance', 'Account Balance',
                         'Balance', 'Past Due Amount', 'AR Balance'],
}

const BUILDIUM_IGNORED = [
  'Tenant Status', 'Status', 'Lease Type',
  'Last Payment Date', 'Last Payment Amount',
  'Tenant Type', 'Move In', 'Move Out',
]

// AppFolio "Tenant Directory" / "Tenant Roster" export. AppFolio's
// reports module has several variants; the one most commonly used for
// migration is the Tenant Directory that combines tenant contact info
// with active-lease columns. Per AppFolio's documented column list +
// the variants we've seen on real exports.
//
// Caveat: AppFolio sometimes ships a single combined "Tenant" column
// (e.g. "Doe, Jane") instead of split First/Last. The mapping prefers
// split columns when present; if a customer's export only has the
// combined column, the validator will flag missing first_name/last_name
// and the landlord can split the column in their spreadsheet before
// re-uploading. (Auto-splitting is a future enhancement — first/last
// name parsing from a "Last, First" or "First Last" string is its own
// can of worms with hyphenated names, suffixes, etc.)
const APPFOLIO_MAPPING: ColumnMapping = {
  first_name:           ['First Name', 'Tenant First Name'],
  last_name:            ['Last Name',  'Tenant Last Name'],
  // S29X research: AppFolio's Tenant Directory export uses `Emails`
  // (plural — multiple emails comma-separated in one cell) and
  // `Phone Numbers` (plural). Single-value `Email` is also seen.
  email:                ['Email', 'Email Address', 'Primary Email',
                         'Emails'],
  phone:                ['Mobile Phone', 'Phone', 'Phone Number',
                         'Primary Phone', 'Home Phone', 'Phone Numbers'],
  property_name:        ['Property', 'Property Name'],
  unit_number:          ['Unit', 'Unit Name', 'Unit Number'],
  // AppFolio reports also emit bare `Move-in` / `Move-out` without
  // the "Date" suffix — research confirmed via multiple integration
  // docs.
  lease_start:          ['Move-In Date', 'Move In Date', 'Lease Start',
                         'Lease From', 'Move-in', 'Move In', 'Move-In'],
  lease_end:            ['Move-Out Date', 'Move Out Date', 'Lease End',
                         'Lease To', 'Move-out', 'Move Out', 'Move-Out'],
  monthly_rent:         ['Rent', 'Current Rent', 'Monthly Rent',
                         'Rent Amount'],
  security_deposit:     ['Security Deposit', 'Deposit', 'Deposit Held'],
  late_fee_amount:      ['Late Fee', 'Late Fee Amount'],
  late_fee_grace_days:  ['Late Fee Grace Period', 'Grace Period',
                         'Grace Days'],
  // AppFolio doesn't expose lease auto-renew configuration in tenant
  // exports — landlord fills in post-upload.
  auto_renew:           [],
  auto_renew_mode:      [],
  notice_days_required: [],
  outstanding_balance:  ['Past Due Amount', 'Past Due', 'Balance',
                         'Outstanding Balance', 'AR Balance',
                         'Account Balance', 'Delinquent Amount'],
}

const APPFOLIO_IGNORED = [
  'Tenant', 'Tenant Name',  // combined name column — see caveat above
  'Status', 'Tenant Status',
  'Last Payment', 'Last Payment Date', 'Last Payment Amount',
  'Tenant Type', 'Resident', 'Resident Type',
  'Property Address', 'Property Manager',
]

// DoorLoop tenant export. DoorLoop's "Tenants" report lists tenants
// with their primary lease. Columns are documented in DoorLoop's
// migration guide; aliases below cover the most common variants.
// S29X-round-3: column variants verified against a real DoorLoop XLSX
// export of Rent Roll, Leasing report, and Rent Paid. DoorLoop uses
// lowercase `date` (e.g., `Start date`) and inconsistent pluralization
// (`Deposits` not `Deposit`) — both were silently dropping before.
const DOORLOOP_MAPPING: ColumnMapping = {
  first_name:           ['First Name', 'Tenant First Name'],
  last_name:            ['Last Name',  'Tenant Last Name'],
  email:                ['Email', 'Email Address', 'Primary Email'],
  phone:                ['Mobile Phone', 'Phone', 'Phone Number',
                         'Primary Phone', 'Office Phone'],
  property_name:        ['Property', 'Property Name'],
  unit_number:          ['Unit', 'Unit Number'],
  lease_start:          ['Lease Start', 'Lease Start Date',
                         'Move-in Date', 'Move In Date',
                         'Start date'],
  lease_end:            ['Lease End', 'Lease End Date',
                         'Move-out Date', 'Move Out Date',
                         'End date'],
  monthly_rent:         ['Rent', 'Monthly Rent', 'Rent Amount'],
  security_deposit:     ['Security Deposit', 'Deposit', 'Deposit Amount',
                         'Deposits'],
  late_fee_amount:      ['Late Fee', 'Late Fee Amount'],
  late_fee_grace_days:  ['Grace Period', 'Late Fee Grace Period',
                         'Grace Days'],
  auto_renew:           [],
  auto_renew_mode:      [],
  notice_days_required: [],
  outstanding_balance:  ['Balance', 'Outstanding Balance',
                         'Account Balance', 'Total Balance',
                         'Past Due', 'Past Due Amount',
                         'Current balance', 'Balance Due'],
}

// S29X-round-3: DoorLoop's Rent Roll and Leasing reports use `Lease` (or
// `Lease Name`) as a row identifier holding a combined-name string (e.g.,
// "Kim Harland & Zach Harland"). GAM requires first/last separately —
// landlord must pre-split, same posture as AppFolio's `Tenant` column.
// Other columns below are reporting summary / GL-side and not first-class
// tenant fields.
const DOORLOOP_IGNORED = [
  'Status', 'Tenant Status', 'Tenant Type', 'Lease Type',
  'Last Payment', 'Last Payment Date', 'Last Payment Amount',
  'Co-tenants', 'Cosigners', 'Number of Cosigners',
  'Lease', 'Lease Name',
  'Charges', 'Rent (Charges)', 'Other Transactions (Charges)',
  'Total (Charges)', 'Rent (Amount Paid)',
  'Other Transactions (Amount Paid)', 'Total (Amount Paid)',
  'Prev Balance',
  'Beds / Baths', 'Size (sq. ft.)', 'Listing price',
]

// Yardi (Voyager / Breeze) tenant export. Yardi has multiple variants
// depending on which report the customer ran (Resident Roster, Lease
// Audit, Rent Roll). Aliases below cover the most common columns
// across those variants.
const YARDI_MAPPING: ColumnMapping = {
  first_name:           ['First Name', 'Resident First Name'],
  last_name:            ['Last Name',  'Resident Last Name'],
  email:                ['Email', 'Email Address', 'Resident Email'],
  phone:                ['Phone', 'Mobile Phone', 'Phone Number',
                         'Primary Phone', 'Cell Phone'],
  property_name:        ['Property', 'Property Name', 'Building'],
  unit_number:          ['Unit', 'Unit Number', 'Unit Code'],
  // S29X-round-3: `Sign Date` is the lease-signature column on Yardi
  // Voyager's rent roll — used when the move-in date isn't yet stamped
  // for a future-effective lease. Pending real-export verification.
  // S293: `Lease From Date` / `Lease To Date` / `Move-In Date` long-
  // form variants verified verbatim against TenantTech's published
  // Yardi-integration field spec (third-party migration tool that
  // exposes Yardi's resident-module field names). Plain `Move In Date`
  // (no hyphen) added alongside since Yardi help materials use both.
  lease_start:          ['Move In', 'Move-In Date', 'Move In Date',
                         'Lease Start', 'Lease From', 'Lease From Date',
                         'Sign Date'],
  lease_end:            ['Move Out', 'Move-Out Date', 'Move Out Date',
                         'Lease End', 'Lease To', 'Lease To Date',
                         'Lease Expiration'],
  monthly_rent:         ['Rent', 'Charge', 'Market Rent', 'Monthly Rent',
                         'Current Rent'],
  security_deposit:     ['Deposit', 'Security Deposit', 'Deposit Held'],
  late_fee_amount:      ['Late Fee', 'Late Charge'],
  late_fee_grace_days:  ['Grace Period', 'Grace Days'],
  auto_renew:           [],
  auto_renew_mode:      [],
  notice_days_required: [],
  outstanding_balance:  ['Balance', 'AR Balance', 'Outstanding',
                         'Outstanding Balance', 'Resident Balance',
                         'Past Due'],
}

// S29X-round-3: `Resident Code` and `tcode` are Yardi-internal identifiers
// surfaced in rent roll exports. `Recert Status` is a recertification-flow
// column irrelevant to GAM's import. Pending real-export verification.
const YARDI_IGNORED = [
  'Resident Name', 'Tenant Name',
  'Status', 'Resident Status', 'Lease Status', 'Resident Type',
  'Property Code', 'Unit Type', 'Bedrooms', 'Bathrooms',
  'Resident Code', 'tcode', 'Recert Status',
]

// RentManager tenant export.
const RENTMANAGER_MAPPING: ColumnMapping = {
  first_name:           ['First Name', 'Tenant First Name'],
  last_name:            ['Last Name', 'Tenant Last Name'],
  email:                ['Email', 'Email Address'],
  phone:                ['Phone', 'Phone Number', 'Mobile Phone',
                         'Primary Phone'],
  property_name:        ['Property', 'Property Name'],
  unit_number:          ['Unit', 'Unit Number'],
  lease_start:          ['Lease Start', 'Move In', 'Move-In Date'],
  lease_end:            ['Lease End', 'Move Out', 'Move-Out Date'],
  monthly_rent:         ['Rent', 'Monthly Rent', 'Rent Amount'],
  security_deposit:     ['Security Deposit', 'Deposit'],
  late_fee_amount:      ['Late Fee', 'Late Fee Amount'],
  late_fee_grace_days:  ['Grace Period', 'Grace Days'],
  auto_renew:           [],
  auto_renew_mode:      [],
  notice_days_required: [],
  outstanding_balance:  ['Balance', 'Outstanding Balance',
                         'Account Balance', 'Tenant Balance',
                         'Past Due', 'Past Due Amount'],
}

const RENTMANAGER_IGNORED = [
  'Status', 'Tenant Status', 'Tenant Type',
  'Last Payment Date',
]

// Propertyware tenant export.
const PROPERTYWARE_MAPPING: ColumnMapping = {
  first_name:           ['First Name'],
  last_name:            ['Last Name'],
  email:                ['Email', 'Email Address'],
  // S29X research: Propertyware emits phone columns with a literal
  // trailing `#` character (`Home Phone #`, `Mobile Phone #`,
  // `Work Phone #`). Without these aliases every Propertyware phone
  // column gets silently dropped.
  phone:                ['Phone', 'Mobile Phone', 'Cell Phone',
                         'Primary Phone',
                         'Home Phone #', 'Mobile Phone #',
                         'Work Phone #', 'Cell Phone #'],
  property_name:        ['Property', 'Property Name', 'Portfolio'],
  unit_number:          ['Unit', 'Unit Number'],
  lease_start:          ['Lease Start Date', 'Lease Start',
                         'Move In', 'Move-In Date'],
  lease_end:            ['Lease End Date', 'Lease End',
                         'Move Out', 'Move-Out Date'],
  monthly_rent:         ['Rent', 'Monthly Rent', 'Rent Amount'],
  security_deposit:     ['Security Deposit', 'Deposit'],
  late_fee_amount:      ['Late Fee'],
  late_fee_grace_days:  ['Grace Period', 'Grace Days'],
  auto_renew:           [],
  auto_renew_mode:      [],
  notice_days_required: [],
  outstanding_balance:  ['Balance', 'Outstanding Balance',
                         'Account Balance', 'Tenant Balance',
                         'AR Balance'],
}

const PROPERTYWARE_IGNORED = [
  'Status', 'Tenant Status', 'Lease Status',
]

// Rentec Direct tenant export.
const RENTEC_MAPPING: ColumnMapping = {
  first_name:           ['First Name'],
  last_name:            ['Last Name'],
  // S293: `Email Address` verified verbatim against Rentec help
  // article 519 (Add Tenants form).
  email:                ['Email', 'Email Address'],
  // S293: Rentec help articles use `Mobile Phone` exclusively;
  // `Primary Phone` removed (no public source uses that phrasing).
  phone:                ['Phone', 'Phone Number', 'Mobile Phone'],
  property_name:        ['Property', 'Property Name'],
  unit_number:          ['Unit', 'Unit Number'],
  lease_start:          ['Move In Date', 'Move-In Date', 'Lease Start',
                         'Start Date'],
  // S29X-round-3: `Lease Expiration` is Rentec's enhanced-rent-roll
  // column name. Pending real-export verification.
  lease_end:            ['Move Out Date', 'Move-Out Date', 'Lease End',
                         'End Date', 'Lease Expiration'],
  // S29X-round-3: `Market Rent` appears on Rentec's enhanced rent roll
  // alongside the contracted rent. Pending real-export verification.
  monthly_rent:         ['Rent', 'Monthly Rent', 'Rent Amount',
                         'Market Rent'],
  security_deposit:     ['Security Deposit', 'Deposit'],
  // S293: `Overdue` is Rentec's late-fee field name per help article
  // 716 (Customize Late Fee Settings) — verbatim vendor doc.
  late_fee_amount:      ['Late Fee', 'Overdue'],
  // S293: `Grace Period` verified verbatim against help article 716.
  late_fee_grace_days:  ['Grace Period'],
  auto_renew:           [],
  auto_renew_mode:      [],
  notice_days_required: [],
  // S29X-round-3: Rentec exposes a tenant ledger balance directly on
  // their tenant export. Pending real-export verification.
  outstanding_balance:  ['Balance', 'Outstanding Balance',
                         'Account Balance', 'Tenant Balance',
                         'Amount Owed', 'Past Due',
                         'Ledger Balance', 'Tenant Ledger Balance'],
}

const RENTEC_IGNORED = [
  'Tenant Name',  // combined name column — see AppFolio caveat
  'Status', 'Tenant Status',
  'Last Payment',
]

// TenantCloud tenant export.
const TENANTCLOUD_MAPPING: ColumnMapping = {
  first_name:           ['First Name'],
  last_name:            ['Last Name'],
  email:                ['Email', 'Email Address'],
  // S29X-round-3: TenantCloud's contact form captures Home / Work / Cell
  // separately and exports them as distinct columns. Pending real-export
  // verification.
  phone:                ['Phone', 'Mobile Phone', 'Phone Number',
                         'Primary Phone',
                         'Home Phone', 'Work Phone', 'Cell Phone'],
  property_name:        ['Property', 'Property Name'],
  unit_number:          ['Unit', 'Unit Number', 'Unit Name'],
  // S293: TenantCloud's Q2 2025 update split the date column into
  // `Start Date` / `End Date` per their public release notes.
  lease_start:          ['Lease Start', 'Lease Start Date',
                         'Move In', 'Move-In Date', 'Start Date'],
  lease_end:            ['Lease End', 'Lease End Date',
                         'Move Out', 'Move-Out Date', 'End Date'],
  // S293: `Market rent` is a discrete TC column distinct from
  // contract rent.
  monthly_rent:         ['Monthly Rent', 'Rent', 'Rent Amount',
                         'Market Rent', 'Market rent'],
  // S293: `Deposits held` is TC's column header per Q2 2025 update.
  security_deposit:     ['Security Deposit', 'Deposit',
                         'Deposits held', 'Deposits Held'],
  late_fee_amount:      ['Late Fee'],
  late_fee_grace_days:  ['Grace Period', 'Grace Days'],
  auto_renew:           [],
  auto_renew_mode:      [],
  notice_days_required: [],
  outstanding_balance:  ['Balance', 'Outstanding Balance',
                         'Account Balance', 'Tenant Balance',
                         'Past Due'],
}

// S293: `Lease Duration` and `Lease number` are TC-specific
// metadata GAM doesn't model at import time. `Credits` is a
// running credit-balance column distinct from outstanding balance.
const TENANTCLOUD_IGNORED = [
  'Status', 'Tenant Status', 'Tenant Type',
  'Lease Duration', 'Lease number', 'Lease Number',
  'Credits',
]

// Stub mappings for platforms whose real export samples haven't been
// researched yet. Marked enabled=false; flipping to true requires filling
// in the columnMapping arrays from a real export. Frontend hides
// disabled platforms behind "coming soon" labels.
const STUB_MAPPING: ColumnMapping = {
  first_name: [], last_name: [], email: [], phone: [],
  property_name: [], unit_number: [],
  lease_start: [], lease_end: [], monthly_rent: [],
  security_deposit: [], late_fee_amount: [], late_fee_grace_days: [],
  auto_renew: [], auto_renew_mode: [], notice_days_required: [],
  outstanding_balance: [],
}

const PLATFORMS: Record<CsvImportPlatform, PlatformConfig> = {
  generic:      { enabled: true,  label: 'Generic (GAM template)', columnMapping: GENERIC_MAPPING },
  buildium:     { enabled: true,  label: 'Buildium',
                  columnMapping: BUILDIUM_MAPPING,
                  ignoredColumns: BUILDIUM_IGNORED,
                  notes: 'Use Buildium > Reports > Tenant List > Export.' },
  appfolio:     { enabled: true,  label: 'AppFolio',
                  columnMapping: APPFOLIO_MAPPING,
                  ignoredColumns: APPFOLIO_IGNORED,
                  notes: 'Use AppFolio > Reports > Tenant Directory > Export to CSV. If your export uses a combined "Tenant" column instead of First/Last Name, split it in your spreadsheet before uploading.' },
  doorloop:     { enabled: true,  label: 'DoorLoop',
                  columnMapping: DOORLOOP_MAPPING,
                  ignoredColumns: DOORLOOP_IGNORED,
                  notes: 'Use DoorLoop > Tenants > Export to CSV (not Rent Roll — the Rent Roll combines tenant names into a single "Lease" column with no per-row property column; use the Tenants list which exposes First Name / Last Name / Email separately).' },
  yardi:        { enabled: true,  label: 'Yardi',
                  columnMapping: YARDI_MAPPING,
                  ignoredColumns: YARDI_IGNORED,
                  notes: 'Use the Resident Roster or Rent Roll report (Voyager / Breeze). If your export uses a combined "Resident Name" column, split it into First/Last before uploading.' },
  rentmanager:  { enabled: true,  label: 'RentManager',
                  columnMapping: RENTMANAGER_MAPPING,
                  ignoredColumns: RENTMANAGER_IGNORED,
                  notes: 'Export the Tenant List from Reports.' },
  propertyware: { enabled: true,  label: 'Propertyware',
                  columnMapping: PROPERTYWARE_MAPPING,
                  ignoredColumns: PROPERTYWARE_IGNORED,
                  notes: 'Use Propertyware > Reports > Tenant Roster.' },
  rentec:       { enabled: true,  label: 'Rentec Direct',
                  columnMapping: RENTEC_MAPPING,
                  ignoredColumns: RENTEC_IGNORED,
                  notes: 'Use Rentec Direct > Tenants > Export. If your export combines name into "Tenant Name", split it before uploading.' },
  tenantcloud:  { enabled: true,  label: 'TenantCloud',
                  columnMapping: TENANTCLOUD_MAPPING,
                  ignoredColumns: TENANTCLOUD_IGNORED,
                  notes: 'Use TenantCloud > Tenants > Export to CSV.' },
  // S29X-round-3: Square is a POS / invoicing system, not a property
  // manager. It has no tenant-roster concept. Disabled here; enabled
  // in PAYMENT_PLATFORMS only.
  square:       { enabled: false, label: 'Square',
                  columnMapping: STUB_MAPPING,
                  notes: 'Square does not export tenant rosters. Use the payment-history importer for Square instead.' },
}

export function isCsvImportPlatform(s: string): s is CsvImportPlatform {
  return s in PLATFORMS
}

export function isPlatformEnabled(p: CsvImportPlatform): boolean {
  return !!PLATFORMS[p]?.enabled
}

export function getPlatformConfig(p: CsvImportPlatform): PlatformConfig {
  return PLATFORMS[p]
}

// S294: shared core for the three apply* mapping functions. Translates
// a single record's source-column names to GAM canonical names; any
// column that isn't a canonical alias AND isn't in the platform's
// noise/ignored set is preserved verbatim (original-case key + raw
// value) under the `_extra` field. Validate/commit handlers route
// _extra to the row's import_extra_data JSONB column so the super
// admin review queue (S295) can surface unmapped columns from real
// customer exports — turning "silently lost data" into "captured for
// review."
//
// `aliasToCanonical` — caller-built lowercase-source-header → canonical
//                      key map. First alias wins on collisions.
// `noiseSet`         — caller-built lowercase-source-header set of
//                      truly-discard columns (vendor state machines,
//                      computed fields like running balance, etc.).
//                      Columns in this set are dropped silently — same
//                      as pre-S294 behavior.
function mapWithExtra(
  rec: Record<string, any>,
  aliasToCanonical: Map<string, string>,
  noiseSet: Set<string>,
): Record<string, any> {
  const out: Record<string, any> = {}
  const extra: Record<string, any> = {}
  for (const [key, val] of Object.entries(rec)) {
    const norm = key.trim().toLowerCase()
    const canonical = aliasToCanonical.get(norm)
    if (canonical) {
      out[canonical] = val
    } else if (!noiseSet.has(norm)) {
      // Preserve original-case header so the review queue shows the
      // landlord's exact uploaded shape, not a normalized version.
      extra[key] = val
    }
  }
  if (Object.keys(extra).length > 0) {
    out._extra = extra
  }
  return out
}

// Translate a parsed-CSV record set from a platform's column names to
// GAM's canonical names. S294: source columns that aren't canonical-
// aliased AND aren't on the platform's ignoredColumns noise list are
// preserved under `_extra` instead of being silently dropped.
// Matching is case-insensitive on whitespace-trimmed strings — handles
// the common "First Name" vs "first name" vs "FIRST_NAME" variants.
// First alias in the array wins on collisions (later aliases are
// fallbacks).
export function applyMapping(
  records: Record<string, any>[],
  platform: CsvImportPlatform,
): Record<string, any>[] {
  if (platform === 'generic') return records
  const cfg = PLATFORMS[platform]
  if (!cfg) throw new Error(`Unknown platform: ${platform}`)

  // Build a normalized lookup for fast per-row matching. Map of
  // normalized-source-header → canonical header. First alias wins.
  const aliasToCanonical = new Map<string, GamCanonicalHeader>()
  for (const canonical of GAM_CANONICAL_HEADERS) {
    for (const alias of cfg.columnMapping[canonical]) {
      const norm = alias.trim().toLowerCase()
      if (!aliasToCanonical.has(norm)) {
        aliasToCanonical.set(norm, canonical)
      }
    }
  }

  const noiseSet = new Set<string>(
    (cfg.ignoredColumns || []).map(c => c.trim().toLowerCase())
  )

  return records.map(rec => mapWithExtra(rec, aliasToCanonical, noiseSet))
}

// Per-platform CSV template content. Generic returns GAM's headers + an
// example row. Other enabled platforms return the platform's expected
// header order so the landlord can paste in their export's first row to
// sanity-check column alignment.
export function buildTemplateCsv(platform: CsvImportPlatform): string {
  const cfg = PLATFORMS[platform]
  if (!cfg) throw new Error(`Unknown platform: ${platform}`)

  if (platform === 'generic') {
    const header = GAM_CANONICAL_HEADERS.join(',')
    const exampleRow = [
      'Jane', 'Doe', 'jane@example.com', '555-123-4567',
      'Sunset Apartments', '4B',
      '2024-06-01', '2025-05-31', '1850',
      '1850', '50', '5',
      'no', '', '30',
      '0',
    ].join(',')
    return `${header}\n${exampleRow}\n`
  }

  // For platform-specific templates: return the FIRST alias of each
  // canonical column the platform supports, in canonical order. Skips
  // canonical fields the platform doesn't expose (empty alias array).
  // Landlord typically exports directly from their platform — this is a
  // reference of which column names GAM recognizes. UI surfaces
  // platform.notes near the download button rather than baking a comment
  // line into the CSV (would break round-tripping).
  const headers = GAM_CANONICAL_HEADERS
    .map(h => cfg.columnMapping[h][0])
    .filter((h): h is string => !!h)
  return `${headers.join(',')}\n`
}

// ───────────────────────────────────────────────────────────────────────
// PROPERTY + UNIT CSV import registry (parallel to the tenant registry
// above). Lets a landlord drop a property/unit export from their prior
// PM software directly into PropertyOnboardingPage. One CSV row = one
// unit; the property is found-or-created by (name, street1) on commit.
//
// Same shape as the tenant registry: per-platform alias arrays for each
// GAM canonical header, plus an ignoredColumns list for documented
// pass-through.

export const GAM_PROPERTY_CANONICAL_HEADERS = [
  'property_name', 'street1', 'street2', 'city', 'state', 'zip', 'timezone',
  'property_type',
  'unit_number', 'bedrooms', 'bathrooms', 'sqft', 'unit_type',
  'rent_amount', 'security_deposit',
] as const

export type GamPropertyCanonicalHeader = typeof GAM_PROPERTY_CANONICAL_HEADERS[number]

type PropertyColumnMapping = Record<GamPropertyCanonicalHeader, readonly string[]>

interface PropertyPlatformConfig {
  enabled:           boolean
  label:             string
  columnMapping:     PropertyColumnMapping
  ignoredColumns?:   readonly string[]
  notes?:            string
}

// Stub for platforms that don't expose property data (e.g., Square).
const PROPERTY_STUB_MAPPING: PropertyColumnMapping = {
  property_name: [], street1: [], street2: [],
  city: [], state: [], zip: [], timezone: [],
  property_type: [], unit_number: [],
  bedrooms: [], bathrooms: [], sqft: [], unit_type: [],
  rent_amount: [], security_deposit: [],
}

const PROPERTY_GENERIC_MAPPING: PropertyColumnMapping = {
  property_name:    ['property_name'],
  street1:          ['street1'],
  street2:          ['street2'],
  city:             ['city'],
  state:            ['state'],
  zip:              ['zip'],
  timezone:         ['timezone'],
  property_type:    ['property_type'],
  unit_number:      ['unit_number'],
  bedrooms:         ['bedrooms'],
  bathrooms:        ['bathrooms'],
  sqft:             ['sqft'],
  unit_type:        ['unit_type'],
  rent_amount:      ['rent_amount'],
  security_deposit: ['security_deposit'],
}

// Buildium Rentals export — Properties > Rentals > Reports > Rental
// Property List or Unit List. Single row per unit with property fields
// flattened onto the same row.
//
// S29X round-2 research (RentCheck verbatim transcription of Buildium's
// unit + resident import templates): the actual export uses
// `Unit address line 1/2/3` and `Street Address line 1/2/3`, plus
// `City/Locality`, `State/Province/Territory`, `Postal code`, and
// `Sub type` for the unit classifier. Pre-S29X the only alias here
// was `Address` — Buildium doesn't emit that, so every Buildium
// property address was silently dropped.
const PROPERTY_BUILDIUM_MAPPING: PropertyColumnMapping = {
  property_name:    ['Property', 'Property Name', 'Rental Property'],
  street1:          ['Address', 'Address Line 1', 'Street Address',
                     'Property Address',
                     'Unit address line 1', 'Street Address line 1'],
  // Buildium emits up to three address lines. GAM only has street1 +
  // street2 — we take line 2 and intentionally drop line 3 (typically
  // a building/floor reference) rather than concatenating, which would
  // produce truncated/malformed addresses in many cases. Landlords can
  // hand-edit street2 on the preview screen if line 3 was load-bearing.
  street2:          ['Address Line 2', 'Unit Address', 'Apt/Suite',
                     'Unit address line 2', 'Street Address line 2'],
  city:             ['City', 'City/Locality'],
  state:            ['State', 'State/Province', 'State/Province/Territory'],
  zip:              ['Zip', 'ZIP', 'Zip Code', 'Postal Code', 'Postal code'],
  timezone:         ['Timezone', 'Time Zone'],
  property_type:    ['Property Type', 'Rental Type', 'Sub type'],
  unit_number:      ['Unit', 'Unit Number', 'Unit Name', 'Unit number'],
  bedrooms:         ['Bedrooms', 'Beds', '# Beds'],
  bathrooms:        ['Bathrooms', 'Baths', '# Baths'],
  sqft:             ['Square Feet', 'Sqft', 'Sq Ft', 'Size'],
  unit_type:        ['Unit Type'],
  rent_amount:      ['Market Rent', 'Rent', 'Monthly Rent', 'Rent Amount'],
  security_deposit: ['Security Deposit', 'Deposit', 'Deposit Amount'],
}

const PROPERTY_BUILDIUM_IGNORED = [
  'Status', 'Occupancy Status', 'Current Tenant',
  'Last Inspection', 'Year Built', 'Lot Size',
]

// AppFolio Property/Unit export — Reports > Property List / Unit
// Directory / Rent Roll. S29X research: AppFolio prefixes EVERY
// address column with `Unit ` (e.g. `Unit Street Address 1`,
// `Unit City`, `Unit Zip`). Before adding these aliases, a real
// AppFolio property export landed with zero address fields mapped
// because we only had bare `Address` / `City` / etc.
const PROPERTY_APPFOLIO_MAPPING: PropertyColumnMapping = {
  property_name:    ['Property', 'Property Name', 'Building'],
  street1:          ['Address', 'Property Address', 'Street',
                     'Unit Street Address 1', 'Unit Address'],
  street2:          ['Address 2', 'Unit Street Address 2',
                     'Unit Address Cont.', 'Unit Address 2'],
  city:             ['City', 'Unit City'],
  state:            ['State', 'Unit State'],
  zip:              ['Zip', 'Postal Code', 'Unit Zip', 'Unit Postal Code'],
  timezone:         ['Time Zone', 'Timezone'],
  property_type:    ['Property Type'],
  unit_number:      ['Unit', 'Unit Name', 'Unit Number', 'Unit ID'],
  bedrooms:         ['Bedrooms', 'Beds'],
  bathrooms:        ['Bathrooms', 'Baths'],
  sqft:             ['Square Feet', 'Sq Ft', 'Sqft'],
  unit_type:        ['Unit Type'],
  rent_amount:      ['Market Rent', 'Current Rent', 'Rent',
                     'Monthly Rent', 'Asking Rent'],
  security_deposit: ['Security Deposit', 'Deposit'],
}

const PROPERTY_APPFOLIO_IGNORED = [
  'Status', 'Occupancy', 'Vacant', 'Current Resident',
  'Property Manager', 'Owner', 'Year Built',
]

// DoorLoop Properties export — Properties > Export to CSV.
// S29X-round-3: DoorLoop's Rent Roll uses `Size (sq. ft.)` (parenthesized
// unit) and `Listing price` (marketing rent, distinct from contracted
// rent). The `Beds / Baths` column is combined and needs landlord
// pre-split — keep in IGNORED so import doesn't choke.
const PROPERTY_DOORLOOP_MAPPING: PropertyColumnMapping = {
  property_name:    ['Property', 'Property Name'],
  street1:          ['Address', 'Street Address', 'Address Line 1'],
  street2:          ['Address Line 2', 'Apt/Unit'],
  city:             ['City'],
  state:            ['State'],
  zip:              ['Zip', 'Zip Code', 'Postal Code'],
  timezone:         ['Time Zone', 'Timezone'],
  property_type:    ['Property Type', 'Type'],
  unit_number:      ['Unit', 'Unit Number'],
  bedrooms:         ['Bedrooms', 'Beds'],
  bathrooms:        ['Bathrooms', 'Baths'],
  sqft:             ['Square Feet', 'Sqft', 'Size', 'Size (sq. ft.)'],
  unit_type:        ['Unit Type'],
  rent_amount:      ['Rent', 'Monthly Rent', 'Market Rent', 'Rent Amount',
                     'Listing price'],
  security_deposit: ['Security Deposit', 'Deposit', 'Deposits'],
}

const PROPERTY_DOORLOOP_IGNORED = [
  'Status', 'Occupancy Status', 'Current Tenant',
  'Year Built', 'Owner',
  'Beds / Baths', 'Lease', 'Charges', 'Balance',
]

// Yardi Property/Unit export — Voyager / Breeze property list +
// rent roll combined.
const PROPERTY_YARDI_MAPPING: PropertyColumnMapping = {
  property_name:    ['Property', 'Property Name', 'Building'],
  street1:          ['Address', 'Property Address', 'Street'],
  street2:          ['Address 2'],
  city:             ['City'],
  state:            ['State'],
  zip:              ['Zip', 'Postal Code'],
  // S293: `Time Zone` removed — no public Yardi source shows it as a
  // rent-roll / property-export column. Landlords set timezone at
  // property-creation time inside GAM. (Same removal applied to
  // Rentec + TenantCloud below; other platforms unverified, left
  // as-is to avoid regressing prior research.)
  timezone:         [],
  // S293: `Building Type` removed — not seen in any public Yardi
  // source. Yardi uses `Property Type`.
  property_type:    ['Property Type'],
  unit_number:      ['Unit', 'Unit Number', 'Unit Code'],
  bedrooms:         ['Bedrooms', 'Beds', 'BR'],
  bathrooms:        ['Bathrooms', 'Baths', 'BA'],
  sqft:             ['Square Feet', 'Sq Ft', 'Sqft', 'Size'],
  unit_type:        ['Unit Type', 'Floorplan'],
  rent_amount:      ['Market Rent', 'Rent', 'Monthly Rent',
                     'Current Rent', 'Charge'],
  security_deposit: ['Deposit', 'Security Deposit'],
}

const PROPERTY_YARDI_IGNORED = [
  'Property Code', 'Status', 'Occupancy', 'Resident Name',
  'Year Built', 'Owner',
]

// RentManager properties + units export.
//
// S29X round-2 research (RentCheck verbatim transcription of
// RentManager's unit + resident import templates): the actual export
// uses `Street1`/`Street 1` (both spacing variants exist across the
// unit vs resident templates), `Street2`/`Street 2`, and
// `PostalCode` (concatenated, no space). Pre-S29X the only aliases
// were `Address`/`Street Address` — RentManager doesn't emit those,
// so every RentManager property address was silently dropped.
const PROPERTY_RENTMANAGER_MAPPING: PropertyColumnMapping = {
  property_name:    ['Property', 'Property Name'],
  street1:          ['Address', 'Street Address', 'Street1', 'Street 1'],
  street2:          ['Address 2', 'Street2', 'Street 2'],
  city:             ['City'],
  state:            ['State'],
  zip:              ['Zip', 'Postal Code', 'PostalCode'],
  timezone:         ['Time Zone', 'Timezone'],
  property_type:    ['Property Type'],
  unit_number:      ['Unit', 'Unit Number'],
  bedrooms:         ['Bedrooms', 'Beds'],
  bathrooms:        ['Bathrooms', 'Baths'],
  sqft:             ['Square Feet', 'Sq Ft', 'Sqft'],
  unit_type:        ['Unit Type'],
  rent_amount:      ['Rent', 'Monthly Rent', 'Market Rent'],
  security_deposit: ['Security Deposit', 'Deposit'],
}

const PROPERTY_RENTMANAGER_IGNORED = [
  'Status', 'Year Built', 'Owner', 'Current Tenant',
]

// Propertyware properties + units export — Reports > Rent Roll
// (Lease Reports) or the Units report. S29X research: Propertyware
// emits ALL-CAPS column names + uses `Cont.` (with period) for
// address continuation lines + prefixes unit-context address columns
// with `Unit `. Our applyMapping().toLowerCase() handles the casing
// but the `Cont.` and `Unit *` variants need explicit aliases.
const PROPERTY_PROPERTYWARE_MAPPING: PropertyColumnMapping = {
  property_name:    ['Property', 'Property Name', 'Portfolio'],
  street1:          ['Address', 'Street Address', 'Property Address',
                     'Unit Address'],
  street2:          ['Address 2', 'Address Cont.', 'Unit Address Cont.'],
  city:             ['City', 'Unit City'],
  state:            ['State', 'Unit State'],
  zip:              ['Zip', 'Postal Code', 'Unit Zip'],
  timezone:         ['Time Zone'],
  property_type:    ['Property Type'],
  unit_number:      ['Unit', 'Unit Number'],
  bedrooms:         ['Bedrooms', 'Beds'],
  bathrooms:        ['Bathrooms', 'Baths'],
  sqft:             ['Square Feet', 'Sq Ft'],
  unit_type:        ['Unit Type'],
  rent_amount:      ['Rent', 'Monthly Rent', 'Market Rent'],
  security_deposit: ['Security Deposit', 'Deposit'],
}

const PROPERTY_PROPERTYWARE_IGNORED = [
  'Status', 'Owner', 'Manager',
]

// Rentec Direct properties + units export.
//
// S293: column names verified verbatim against Rentec help article
// 518 (Add Properties form). Rentec uses `Nickname` for property
// name, `Square Footage` for sqft, `Default Rent` instead of
// "Market Rent", `Default Security Deposit` for the deposit, and
// exposes `Year Built` + `Multi-Unit Property` as discrete fields.
const PROPERTY_RENTEC_MAPPING: PropertyColumnMapping = {
  property_name:    ['Property', 'Property Name', 'Nickname'],
  street1:          ['Address', 'Street Address'],
  street2:          ['Address 2'],
  city:             ['City'],
  state:            ['State'],
  zip:              ['Zip', 'Postal Code'],
  timezone:         [],
  property_type:    ['Property Type', 'Type'],
  unit_number:      ['Unit', 'Unit Number'],
  bedrooms:         ['Bedrooms', 'Beds'],
  bathrooms:        ['Bathrooms', 'Baths'],
  sqft:             ['Square Feet', 'Sq Ft', 'Square Footage'],
  unit_type:        ['Unit Type'],
  rent_amount:      ['Rent', 'Monthly Rent', 'Market Rent',
                     'Default Rent'],
  security_deposit: ['Security Deposit', 'Deposit',
                     'Default Security Deposit'],
}

// S293: `Year Built` and `Multi-Unit Property` are Rentec property
// fields we don't currently capture (GAM doesn't model either at the
// property level). Documenting them as ignored so they don't surface
// as "unrecognized column" warnings.
const PROPERTY_RENTEC_IGNORED = [
  'Status', 'Owner',
  'Year Built', 'Multi-Unit Property', 'How Many Units',
  'Description', 'Income Account', 'Expense Account',
  'Property Reserve',
]

// TenantCloud properties + units export.
const PROPERTY_TENANTCLOUD_MAPPING: PropertyColumnMapping = {
  property_name:    ['Property', 'Property Name'],
  // S29X-round-3: `Street` is the verbatim column header used by
  // TenantCloud's property-import template (help.tenantcloud.com,
  // HIGH confidence — import schema is bidirectional with export).
  street1:          ['Address', 'Street Address', 'Street'],
  street2:          ['Address 2'],
  city:             ['City'],
  state:            ['State'],
  zip:              ['Zip', 'Postal Code'],
  timezone:         [],
  property_type:    ['Property Type'],
  unit_number:      ['Unit', 'Unit Number', 'Unit Name'],
  bedrooms:         ['Bedrooms', 'Beds'],
  bathrooms:        ['Bathrooms', 'Baths'],
  // S293: TC's rent-roll help article uses `size` (lowercase) for
  // square footage — the alias normalizer handles casing.
  sqft:             ['Square Feet', 'Sq Ft', 'Size'],
  unit_type:        ['Unit Type'],
  rent_amount:      ['Rent', 'Monthly Rent', 'Market Rent'],
  security_deposit: ['Security Deposit', 'Deposit'],
}

// S29X-round-3: `Country` and `Currency` appear on TenantCloud's
// property-import template — GAM is US-only USD, so we drop them.
// S293: TC's rent-roll includes `Owner` as a customizable column —
// landlord identity is implicit from the import session so we
// silently drop it.
const PROPERTY_TENANTCLOUD_IGNORED = [
  'Status', 'Owner',
  'Country', 'Currency',
]

const PROPERTY_PLATFORMS: Record<CsvImportPlatform, PropertyPlatformConfig> = {
  generic:      { enabled: true,  label: 'Generic (GAM template)',
                  columnMapping: PROPERTY_GENERIC_MAPPING },
  buildium:     { enabled: true,  label: 'Buildium',
                  columnMapping: PROPERTY_BUILDIUM_MAPPING,
                  ignoredColumns: PROPERTY_BUILDIUM_IGNORED,
                  notes: 'Use Buildium > Rentals > Reports > Rental Property List (or Unit List). One row per unit; property address fields repeat across rows for the same property.' },
  appfolio:     { enabled: true,  label: 'AppFolio',
                  columnMapping: PROPERTY_APPFOLIO_MAPPING,
                  ignoredColumns: PROPERTY_APPFOLIO_IGNORED,
                  notes: 'Use AppFolio > Reports > Property List or Unit List > Export to CSV.' },
  doorloop:     { enabled: true,  label: 'DoorLoop',
                  columnMapping: PROPERTY_DOORLOOP_MAPPING,
                  ignoredColumns: PROPERTY_DOORLOOP_IGNORED,
                  notes: 'Use DoorLoop > Properties > Export to CSV (NOT the Rent Roll — Rent Roll uses property as a section header instead of a per-row column, which won\'t parse correctly). If your Properties export is one row per property only, combine it with the Units export so each row carries both property + unit fields. The Rent Roll\'s "Beds / Baths" column is combined — split into separate Bedrooms / Bathrooms columns before upload.' },
  yardi:        { enabled: true,  label: 'Yardi',
                  columnMapping: PROPERTY_YARDI_MAPPING,
                  ignoredColumns: PROPERTY_YARDI_IGNORED,
                  notes: 'Use Voyager or Breeze: Rent Roll report (one row per unit with property fields).' },
  rentmanager:  { enabled: true,  label: 'RentManager',
                  columnMapping: PROPERTY_RENTMANAGER_MAPPING,
                  ignoredColumns: PROPERTY_RENTMANAGER_IGNORED,
                  notes: 'Export the Property + Unit list from Reports.' },
  propertyware: { enabled: true,  label: 'Propertyware',
                  columnMapping: PROPERTY_PROPERTYWARE_MAPPING,
                  ignoredColumns: PROPERTY_PROPERTYWARE_IGNORED,
                  notes: 'Use Propertyware > Reports > Property List + Unit List.' },
  rentec:       { enabled: true,  label: 'Rentec Direct',
                  columnMapping: PROPERTY_RENTEC_MAPPING,
                  ignoredColumns: PROPERTY_RENTEC_IGNORED,
                  notes: 'Use Rentec Direct > Properties > Export.' },
  tenantcloud:  { enabled: true,  label: 'TenantCloud',
                  columnMapping: PROPERTY_TENANTCLOUD_MAPPING,
                  ignoredColumns: PROPERTY_TENANTCLOUD_IGNORED,
                  notes: 'Use TenantCloud > Properties > Export to CSV.' },
  // S29X-round-3: Square has no property concept. Disabled here;
  // payment-history only.
  square:       { enabled: false, label: 'Square',
                  columnMapping: PROPERTY_STUB_MAPPING,
                  notes: 'Square does not track properties. Use the payment-history importer for Square instead.' },
}

export function getPropertyPlatformConfig(p: CsvImportPlatform): PropertyPlatformConfig {
  return PROPERTY_PLATFORMS[p]
}

export function applyPropertyMapping(
  records: Record<string, any>[],
  platform: CsvImportPlatform,
): Record<string, any>[] {
  if (platform === 'generic') return records
  const cfg = PROPERTY_PLATFORMS[platform]
  if (!cfg) throw new Error(`Unknown platform: ${platform}`)

  const aliasToCanonical = new Map<string, GamPropertyCanonicalHeader>()
  for (const canonical of GAM_PROPERTY_CANONICAL_HEADERS) {
    for (const alias of cfg.columnMapping[canonical]) {
      const norm = alias.trim().toLowerCase()
      if (!aliasToCanonical.has(norm)) {
        aliasToCanonical.set(norm, canonical)
      }
    }
  }

  const noiseSet = new Set<string>(
    (cfg.ignoredColumns || []).map(c => c.trim().toLowerCase())
  )

  return records.map(rec => mapWithExtra(rec, aliasToCanonical, noiseSet))
}

export function buildPropertyTemplateCsv(platform: CsvImportPlatform): string {
  const cfg = PROPERTY_PLATFORMS[platform]
  if (!cfg) throw new Error(`Unknown platform: ${platform}`)

  if (platform === 'generic') {
    const header = GAM_PROPERTY_CANONICAL_HEADERS.join(',')
    const exampleRow = [
      'Sunset Apartments', '100 Main St', '', 'Phoenix', 'AZ', '85001',
      'America/Phoenix', 'residential',
      '4B', '2', '1.5', '850', 'apartment',
      '1850', '1850',
    ].join(',')
    return `${header}\n${exampleRow}\n`
  }

  const headers = GAM_PROPERTY_CANONICAL_HEADERS
    .map(h => cfg.columnMapping[h][0])
    .filter((h): h is string => !!h)
  return `${headers.join(',')}\n`
}

// ───────────────────────────────────────────────────────────────────────
// PAYMENT HISTORY CSV import registry (Phase B). For migrating
// historical rent collections from a prior PM software. Each row =
// one historical payment, resolved to a tenant + lease via email +
// optional property/unit sanity check. Commit writes
// `payments` rows with status='settled', import_source=<platform>,
// settled_at=payment_date.

// S29X-round-3: `tenant_name` added as a fallback identifier for platforms
// whose transactions export doesn't carry tenant email (DoorLoop, Square,
// Yardi receipts, etc.). Resolution order on validate is:
//   email → exact match → if missing/unmatched → name → fuzzy match against
//   active tenants, disambiguated by property_name + unit_number.
export const GAM_PAYMENT_HISTORY_CANONICAL_HEADERS = [
  'tenant_email', 'tenant_name', 'payment_date', 'amount',
  'payment_type', 'payment_method',
  'property_name', 'unit_number', 'reference',
] as const

export type GamPaymentHistoryCanonicalHeader =
  typeof GAM_PAYMENT_HISTORY_CANONICAL_HEADERS[number]

type PaymentColumnMapping =
  Record<GamPaymentHistoryCanonicalHeader, readonly string[]>

// S29X-round-3: optional preprocess hook for platforms with structural
// quirks the alias mapping can't express (multi-column payment method,
// non-payment row filtering, etc.). Square is the first user — see
// squarePreprocess below. Runs before alias rewriting; receives raw
// parsed records with the platform's source column names.
type PaymentPreprocess = (raw: Record<string, any>[]) => Record<string, any>[]

interface PaymentPlatformConfig {
  enabled:           boolean
  label:             string
  columnMapping:     PaymentColumnMapping
  ignoredColumns?:   readonly string[]
  notes?:            string
  preprocess?:       PaymentPreprocess
}

const PAYMENT_GENERIC_MAPPING: PaymentColumnMapping = {
  tenant_email:   ['tenant_email'],
  tenant_name:    ['tenant_name'],
  payment_date:   ['payment_date'],
  amount:         ['amount'],
  payment_type:   ['payment_type'],
  payment_method: ['payment_method'],
  property_name:  ['property_name'],
  unit_number:    ['unit_number'],
  reference:      ['reference'],
}

// Buildium "Transaction List" / "Tenant Ledger" export.
const PAYMENT_BUILDIUM_MAPPING: PaymentColumnMapping = {
  tenant_email:   ['Tenant Email', 'Email', 'Email Address'],
  tenant_name:    ['Tenant Name', 'Tenant', 'Resident', 'Resident Name'],
  payment_date:   ['Date', 'Transaction Date', 'Payment Date',
                   'Paid Date'],
  amount:         ['Amount', 'Payment Amount', 'Total'],
  payment_type:   ['Type', 'Transaction Type', 'Category',
                   'Charge Type'],
  payment_method: ['Method', 'Payment Method', 'Payment Type'],
  property_name:  ['Property', 'Property Name', 'Rental Property'],
  unit_number:    ['Unit', 'Unit Number'],
  reference:      ['Reference', 'Check Number', 'Memo',
                   'Description'],
}

const PAYMENT_BUILDIUM_IGNORED = [
  'Status', 'Posted Date', 'Posted By', 'Account', 'GL Account',
  'Running Balance',
]

// AppFolio "Tenant Ledger" / "Receipts" export.
const PAYMENT_APPFOLIO_MAPPING: PaymentColumnMapping = {
  tenant_email:   ['Email', 'Primary Email', 'Tenant Email'],
  tenant_name:    ['Tenant', 'Tenant Name', 'Resident', 'Resident Name'],
  payment_date:   ['Date', 'Receipt Date', 'Posted Date',
                   'Payment Date'],
  amount:         ['Amount', 'Payment', 'Receipt Amount'],
  payment_type:   ['Type', 'Charge Type', 'Category'],
  payment_method: ['Method', 'Payment Method', 'Receipt Type'],
  property_name:  ['Property', 'Property Name'],
  unit_number:    ['Unit', 'Unit Name'],
  reference:      ['Reference', 'Check #', 'Memo', 'Description'],
}

const PAYMENT_APPFOLIO_IGNORED = [
  'Status', 'Account',
  'GL Account', 'Running Balance', 'Posted By',
]

// DoorLoop "Tenant Transactions" / "Payments" export.
// S29X-round-3: DoorLoop's Transactions report has no email column.
// Tenants are identified by the `Lease` column (combined-name string,
// e.g., "Kim Harland & Zach Harland") with fallback to `Name` (the
// payment tenderer). Wired into tenant_name; validate resolves by name
// against active tenants when email is absent.
const PAYMENT_DOORLOOP_MAPPING: PaymentColumnMapping = {
  tenant_email:   ['Email', 'Tenant Email', 'Primary Email'],
  tenant_name:    ['Lease', 'Tenant Name', 'Tenant', 'Name', 'Lease Name'],
  payment_date:   ['Date', 'Payment Date', 'Transaction Date'],
  amount:         ['Amount', 'Payment Amount'],
  payment_type:   ['Type', 'Category', 'Transaction Type'],
  payment_method: ['Method', 'Payment Method'],
  property_name:  ['Property', 'Property Name'],
  unit_number:    ['Unit', 'Unit Number'],
  reference:      ['Reference', 'Memo', 'Description', 'Notes'],
}

// S29X-round-3: `Asset account` (Operating Account, etc.) is the GL
// destination, not a payment method.
const PAYMENT_DOORLOOP_IGNORED = [
  'Status', 'Running Balance',
  'Account', 'Asset account',
]

// Yardi "Receipts" / "AR Ledger" export.
const PAYMENT_YARDI_MAPPING: PaymentColumnMapping = {
  tenant_email:   ['Email', 'Resident Email'],
  tenant_name:    ['Resident', 'Resident Name', 'Tenant', 'Tenant Name'],
  payment_date:   ['Date', 'Receipt Date', 'Post Date',
                   'Transaction Date'],
  amount:         ['Amount', 'Receipt Amount', 'Payment'],
  // S29X-round-3: Yardi Breeze's transaction register surfaces
  // `Receipt Type` enumerating Manual Receipt / Non-Person Payer
  // Receipt / Zero Dollar Receipt — that's a transaction
  // classification, not a payment method, so it belongs here.
  // Source: Yardi Breeze fall-2024 release notes (HIGH confidence).
  payment_type:   ['Charge Code', 'Type', 'Category', 'Receipt Type'],
  // S29X-round-3: Breeze fall-2024 release notes added a `Payment
  // Method` column to receipts. (HIGH confidence.)
  payment_method: ['Method', 'Payment Method'],
  property_name:  ['Property', 'Property Name', 'Building'],
  unit_number:    ['Unit', 'Unit Code', 'Unit Number'],
  reference:      ['Reference', 'Check Number', 'Memo'],
}

const PAYMENT_YARDI_IGNORED = [
  'Status', 'Property Code',
  'GL Account', 'Running Balance',
]

// RentManager transactions export.
const PAYMENT_RENTMANAGER_MAPPING: PaymentColumnMapping = {
  tenant_email:   ['Email', 'Tenant Email'],
  tenant_name:    ['Tenant', 'Tenant Name'],
  payment_date:   ['Date', 'Transaction Date', 'Payment Date'],
  amount:         ['Amount', 'Payment Amount'],
  payment_type:   ['Type', 'Charge Type', 'Category'],
  payment_method: ['Method', 'Payment Method'],
  property_name:  ['Property', 'Property Name'],
  unit_number:    ['Unit', 'Unit Number'],
  reference:      ['Reference', 'Check Number', 'Memo'],
}

const PAYMENT_RENTMANAGER_IGNORED = [
  'Status', 'Account',
  'Running Balance', 'Posted By',
]

// Propertyware "Tenant Ledger" export.
const PAYMENT_PROPERTYWARE_MAPPING: PaymentColumnMapping = {
  tenant_email:   ['Email', 'Tenant Email'],
  tenant_name:    ['Tenant', 'Tenant Name'],
  payment_date:   ['Date', 'Payment Date', 'Transaction Date'],
  amount:         ['Amount', 'Payment Amount'],
  payment_type:   ['Type', 'Charge Type'],
  payment_method: ['Method', 'Payment Method'],
  property_name:  ['Property', 'Property Name'],
  unit_number:    ['Unit', 'Unit Number'],
  reference:      ['Reference', 'Memo'],
}

const PAYMENT_PROPERTYWARE_IGNORED = [
  'Status', 'Running Balance',
]

// Rentec Direct transactions export.
//
// S293: `check #` (with literal hash character) is Rentec's customizable
// transaction column per help article 776 (Reports Overview). `category`
// is Rentec's term for payment type — already aliased via toLowerCase
// match against 'Category'.
const PAYMENT_RENTEC_MAPPING: PaymentColumnMapping = {
  tenant_email:   ['Email', 'Tenant Email'],
  tenant_name:    ['Tenant Name', 'Tenant'],
  payment_date:   ['Date', 'Payment Date'],
  amount:         ['Amount'],
  payment_type:   ['Type', 'Category'],
  payment_method: ['Method', 'Payment Type'],
  property_name:  ['Property', 'Property Name'],
  unit_number:    ['Unit', 'Unit Number'],
  reference:      ['Reference', 'Memo', 'Notes',
                   'Check Number', 'Check #'],
}

const PAYMENT_RENTEC_IGNORED = [
  'Status', 'Running Balance',
]

// TenantCloud transactions export.
//
// S293: TC's Owner Statement uses `Money In` / `Money Out` as the
// inflow/outflow columns per the help article. `Money In` aliases
// to amount; `Money Out` is ignored (outflow, not tenant payment).
// `Available on` (added Q2 2025) is a payout-availability date,
// not a payment date — ignored.
const PAYMENT_TENANTCLOUD_MAPPING: PaymentColumnMapping = {
  tenant_email:   ['Email', 'Tenant Email'],
  tenant_name:    ['Tenant', 'Tenant Name'],
  payment_date:   ['Date', 'Payment Date', 'Transaction Date'],
  amount:         ['Amount', 'Payment Amount', 'Money In'],
  // S29X-round-3: TenantCloud's payment-activity report uses
  // `Income Category` for the rent/late/pet-fee discriminator.
  // Pending real-export verification.
  payment_type:   ['Type', 'Category', 'Income Category'],
  payment_method: ['Method', 'Payment Method'],
  property_name:  ['Property', 'Property Name'],
  unit_number:    ['Unit', 'Unit Number', 'Unit Name'],
  // S29X-round-3: `Transaction ID` is TenantCloud's external-ref
  // column. `Payee` shows the payee name for landlord-side payments.
  // Pending real-export verification.
  reference:      ['Reference', 'Memo', 'Notes',
                   'Transaction ID', 'Payee'],
}

// S29X-round-3: `Reconciliation Status` / `Payout Status` are
// TenantCloud's internal reconciliation flags. Pending real-export
// verification.
// S293: `Money Out` (Owner Statement outflows — owner draws,
// expenses), `Available on` (Q2 2025 payout-availability date),
// `Payment Account` (the bank account that received the payout —
// not relevant to migration).
const PAYMENT_TENANTCLOUD_IGNORED = [
  'Status', 'Running Balance',
  'Reconciliation Status', 'Payout Status',
  'Money Out', 'Available on', 'Available On',
  'Payment Account',
]

// ─── Square (POS + Invoices) Transactions export ───────────────────────
// S29X-round-3: Square is a POS / invoicing platform GAM landlords use
// for tenant card/ACH collection at properties where Stripe Connect
// hasn't been adopted. Quirks the alias-mapping pattern can't handle:
//   1) payment method is split across columns (Card / Cash / Other
//      Tender / Square Gift Card) — only one has a non-zero value
//   2) Event Type != "Payment" rows (refunds, etc.) must be filtered
//   3) no tenant email column — resolved via tenant_name fallback
//   4) Description carries rent/utility/etc. classification mixed with
//      line-item text — best-effort parse below; landlord can correct on
//      preview
//
// Preprocess outputs records with two synthesized columns prepended:
//   __derived_method  — 'card' / 'cash' / 'check' / 'gift_card' / etc.
//   __derived_type    — 'rent' / 'utility' / 'late_fee' / 'deposit'
// which the alias mapping then picks up.

function parseSquareAmount(v: any): number {
  if (v == null) return 0
  const s = String(v).replace(/[$,\s]/g, '')
  const n = parseFloat(s)
  return isFinite(n) ? n : 0
}

const squarePreprocess: PaymentPreprocess = (records) => {
  const out: Record<string, any>[] = []
  for (const rec of records) {
    const eventType = String(rec['Event Type'] || '').trim().toLowerCase()
    // Drop refunds / non-payment events. Empty string lets through old
    // exports that didn't carry the Event Type column.
    if (eventType && eventType !== 'payment') continue

    // Derive payment method from the only column with a non-zero amount.
    let method = ''
    if (parseSquareAmount(rec['Card']) > 0) method = 'card'
    else if (parseSquareAmount(rec['Cash']) > 0) method = 'cash'
    else if (parseSquareAmount(rec['Square Gift Card']) > 0) method = 'gift_card'
    else if (parseSquareAmount(rec['Other Tender']) > 0) {
      const otherType = String(rec['Other Tender Type'] || '').trim().toLowerCase()
      method = otherType || 'other'
    }

    // Derive payment_type from Description heuristics. Defaults to rent
    // since that's the dominant case for tenant payments routed through
    // Square (POS or Invoices); landlord can correct on preview.
    const desc = String(rec['Description'] || '').toLowerCase()
    let derivedType = 'rent'
    if (/electric|water|gas|utility|kw\b/.test(desc)) derivedType = 'utility'
    else if (/late\s*fee/.test(desc)) derivedType = 'late_fee'
    else if (/deposit/.test(desc)) derivedType = 'deposit'

    out.push({ ...rec, __derived_method: method, __derived_type: derivedType })
  }
  return out
}

const PAYMENT_SQUARE_MAPPING: PaymentColumnMapping = {
  tenant_email:   [],
  tenant_name:    ['Customer Name'],
  payment_date:   ['Date'],
  amount:         ['Total Collected'],
  payment_type:   ['__derived_type'],
  payment_method: ['__derived_method'],
  property_name:  [],
  unit_number:    [],
  reference:      ['Transaction ID', 'Payment ID', 'Order Reference ID'],
}

// Square columns we deliberately drop. The transactions export is wide
// (50+ columns) — most are POS / fee-attribution metadata GAM doesn't
// model for historical imports.
const PAYMENT_SQUARE_IGNORED = [
  'Time', 'Time Zone',
  'Gross Sales', 'Discounts', 'Service Charges', 'Net Sales',
  'Gift Card Sales', 'Tax', 'Tip', 'Partial Refunds',
  'Source', 'Card', 'Card Entry Methods', 'Cash', 'Square Gift Card',
  'Other Tender', 'Other Tender Type', 'Tender Note',
  'Fees', 'Net Total', 'Card Brand', 'PAN Suffix',
  'Device Name', 'Staff Name', 'Staff ID', 'Details', 'Description',
  'Event Type', 'Location', 'Dining Option',
  'Customer ID', 'Customer Reference ID', 'Device Nickname',
  'Third Party Fees', 'Deposit ID', 'Deposit Date', 'Deposit Details',
  'Fee Percentage Rate', 'Fee Fixed Rate',
  'Refund Reason', 'Discount Name', 'Transaction Status',
  'Cash App', 'Fulfillment Note', 'Free Processing Applied',
  'Channel', 'Unattributed Tips', 'Table Info', 'International Fee',
]

const PAYMENT_PLATFORMS: Record<CsvImportPlatform, PaymentPlatformConfig> = {
  generic:      { enabled: true,  label: 'Generic (GAM template)',
                  columnMapping: PAYMENT_GENERIC_MAPPING },
  buildium:     { enabled: true,  label: 'Buildium',
                  columnMapping: PAYMENT_BUILDIUM_MAPPING,
                  ignoredColumns: PAYMENT_BUILDIUM_IGNORED,
                  notes: 'Use Buildium > Reports > Accounting > Transaction List (or a tenant ledger export). Filter to payment-type transactions only.' },
  appfolio:     { enabled: true,  label: 'AppFolio',
                  columnMapping: PAYMENT_APPFOLIO_MAPPING,
                  ignoredColumns: PAYMENT_APPFOLIO_IGNORED,
                  notes: 'Use AppFolio > Reports > Tenant Ledger or Receipts. Export as CSV.' },
  doorloop:     { enabled: true,  label: 'DoorLoop',
                  columnMapping: PAYMENT_DOORLOOP_MAPPING,
                  ignoredColumns: PAYMENT_DOORLOOP_IGNORED,
                  notes: 'Use DoorLoop > Reports > Transactions, filtered to payments. Export to CSV. Tenants are matched by the Lease column (combined-name string); DoorLoop\'s transactions export does not carry tenant email. Make sure the tenants are already onboarded in GAM under the same names before importing payments.' },
  yardi:        { enabled: true,  label: 'Yardi',
                  columnMapping: PAYMENT_YARDI_MAPPING,
                  ignoredColumns: PAYMENT_YARDI_IGNORED,
                  notes: 'Use Voyager / Breeze: Receipts report or AR Ledger. Filter to receipt transactions.' },
  rentmanager:  { enabled: true,  label: 'RentManager',
                  columnMapping: PAYMENT_RENTMANAGER_MAPPING,
                  ignoredColumns: PAYMENT_RENTMANAGER_IGNORED,
                  notes: 'Use RentManager > Reports > Transactions. Filter to payments / receipts.' },
  propertyware: { enabled: true,  label: 'Propertyware',
                  columnMapping: PAYMENT_PROPERTYWARE_MAPPING,
                  ignoredColumns: PAYMENT_PROPERTYWARE_IGNORED,
                  notes: 'Use Propertyware > Reports > Tenant Ledger.' },
  rentec:       { enabled: true,  label: 'Rentec Direct',
                  columnMapping: PAYMENT_RENTEC_MAPPING,
                  ignoredColumns: PAYMENT_RENTEC_IGNORED,
                  notes: 'Use Rentec Direct > Transactions > Export.' },
  tenantcloud:  { enabled: true,  label: 'TenantCloud',
                  columnMapping: PAYMENT_TENANTCLOUD_MAPPING,
                  ignoredColumns: PAYMENT_TENANTCLOUD_IGNORED,
                  notes: 'Use TenantCloud > Reports > Transactions or Payments.' },
  square:       { enabled: true,  label: 'Square',
                  columnMapping: PAYMENT_SQUARE_MAPPING,
                  ignoredColumns: PAYMENT_SQUARE_IGNORED,
                  preprocess: squarePreprocess,
                  notes: 'Use Square Dashboard > Reports > Transactions > Export. Square caps exports at one year — split a multi-year migration across multiple uploads. Tenants are matched by Customer Name (Square does not export tenant email in the Transactions report).' },
}

export function getPaymentPlatformConfig(p: CsvImportPlatform): PaymentPlatformConfig {
  return PAYMENT_PLATFORMS[p]
}

export function applyPaymentMapping(
  records: Record<string, any>[],
  platform: CsvImportPlatform,
): Record<string, any>[] {
  if (platform === 'generic') return records
  const cfg = PAYMENT_PLATFORMS[platform]
  if (!cfg) throw new Error(`Unknown platform: ${platform}`)

  // S29X-round-3: run optional preprocess to handle structural quirks
  // (Square's multi-column payment method, Event Type filtering) before
  // alias rewriting picks up the synthesized columns.
  const prepped = cfg.preprocess ? cfg.preprocess(records) : records

  const aliasToCanonical = new Map<string, GamPaymentHistoryCanonicalHeader>()
  for (const canonical of GAM_PAYMENT_HISTORY_CANONICAL_HEADERS) {
    for (const alias of cfg.columnMapping[canonical]) {
      const norm = alias.trim().toLowerCase()
      if (!aliasToCanonical.has(norm)) {
        aliasToCanonical.set(norm, canonical)
      }
    }
  }

  // S294: also exclude the Square preprocess's synthesized helper
  // columns from extra_data — they're internal scaffolding, not
  // real source data.
  const noiseSet = new Set<string>(
    (cfg.ignoredColumns || []).map(c => c.trim().toLowerCase())
  )
  noiseSet.add('__derived_method')
  noiseSet.add('__derived_type')

  return prepped.map(rec => mapWithExtra(rec, aliasToCanonical, noiseSet))
}

export function buildPaymentTemplateCsv(platform: CsvImportPlatform): string {
  const cfg = PAYMENT_PLATFORMS[platform]
  if (!cfg) throw new Error(`Unknown platform: ${platform}`)

  if (platform === 'generic') {
    const header = GAM_PAYMENT_HISTORY_CANONICAL_HEADERS.join(',')
    const exampleRow = [
      'jane@example.com', '', '2025-06-01', '1850',
      'rent', 'ach',
      'Sunset Apartments', '4B',
      'June rent',
    ].join(',')
    return `${header}\n${exampleRow}\n`
  }

  const headers = GAM_PAYMENT_HISTORY_CANONICAL_HEADERS
    .map(h => cfg.columnMapping[h][0])
    .filter((h): h is string => !!h)
  return `${headers.join(',')}\n`
}
