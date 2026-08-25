// ============================================================
// GOLD ASSET MANAGEMENT — SHARED TYPES
// Single source of truth for all data models across all apps
// ============================================================

// ── ENUMS ──────────────────────────────────────────────────

export const USER_ROLES = [
  'admin',
  'super_admin',
  'landlord',
  'tenant',
  'bookkeeper',
  'property_manager',
  'onsite_manager',
  'maintenance',
  // S453: service-business operator roles. business_owner = signs up
  // a new business + owns the portal; business_staff = scoped staff
  // member working under a business (scope row in business_users).
  // See `BUSINESS_*` exports below for the per-business enums.
  'business_owner',
  'business_staff',
  // Fitness tracker standalone-app role. Not a portal role: a fitness_user
  // is someone who signed up directly through the fitness app (:3013) to
  // try it out without being a GAM landlord/tenant. They have no
  // landlord/tenant profile row. Tenants/landlords also use the fitness
  // app, but keep their own role — fitness_user is only the "no other GAM
  // relationship" case. Auth on /api/fitness/* is plain requireAuth, so
  // every role (including this one) is accepted there.
  'fitness_user',
  // S568 (Nic): the CONTACT / customer pool. A person given a free GAM account
  // solely so a landlord can send them an e-sign document (purchase agreement,
  // contract) — no landlord/tenant profile row. Requiring an account (vs mailing
  // a doc to any raw email) is the anti-spam / consent gate: the recipient opts
  // in by activating their free account before they can view or sign. Same
  // "no other GAM relationship" shape as fitness_user.
  'contact',
  // S592 (Nic): GAM-side account manager / closing agent. Scoped to their own
  // book of landlord accounts (portfolio_manager_id / service_manager_id) — NOT
  // a platform role. Distinct from 'property_manager' (a landlord's in-house
  // staff). Earns the closing + service commission on the accounts they close /
  // service. Own scoped portal (the former admin-ops app); walled off from
  // /api/admin. See PORTFOLIO_MANAGER_SPEC.md.
  'portfolio_manager',
] as const

export type UserRole = typeof USER_ROLES[number]

// ---------- Role label maps ----------
// Roles are partitioned into four non-overlapping categories.
// Any UI picks the map that fits its purpose; no map contains
// roles outside its category, so a dropdown can't accidentally
// list the wrong options.

export const PLATFORM_ROLES = ['admin', 'super_admin'] as const
export type PlatformRole = typeof PLATFORM_ROLES[number]
export const PLATFORM_ROLE_LABEL: Record<PlatformRole, string> = {
  admin:       'Platform Admin',
  super_admin: 'Super Admin',
}

// S592: GAM-side account manager / closing agent — its own category. Scoped to
// their book (never platform-wide); see PORTFOLIO_MANAGER_SPEC.md.
export const PORTFOLIO_MANAGER_ROLES = ['portfolio_manager'] as const
export type PortfolioManagerRole = typeof PORTFOLIO_MANAGER_ROLES[number]
export const PORTFOLIO_MANAGER_ROLE_LABEL: Record<PortfolioManagerRole, string> = {
  portfolio_manager: 'Portfolio Strategist',
}

export const LANDLORD_ROLES = ['landlord'] as const
export type LandlordRole = typeof LANDLORD_ROLES[number]
export const LANDLORD_ROLE_LABEL: Record<LandlordRole, string> = {
  landlord: 'Landlord',
}

export const TENANT_ROLES = ['tenant'] as const
export type TenantRole = typeof TENANT_ROLES[number]
export const TENANT_ROLE_LABEL: Record<TenantRole, string> = {
  tenant: 'Tenant',
}

export const LANDLORD_ASSIGNABLE_ROLES = [
  'property_manager',
  'onsite_manager',
  'maintenance',
  'bookkeeper',
] as const
export type LandlordAssignableRole = typeof LANDLORD_ASSIGNABLE_ROLES[number]
export const LANDLORD_ASSIGNABLE_ROLE_LABEL: Record<LandlordAssignableRole, string> = {
  property_manager: 'Property Manager',
  onsite_manager:   'On-Site Manager',
  maintenance:      'Maintenance',
  bookkeeper:       'Bookkeeper',
}

// ---------- Service-business operator roles (S453) ----------
// Distinct from landlord-side roles. Service businesses (trash hauling,
// maintenance crews, mobile rentals, equipment rentals) live in the
// `businesses` table and run their own portal at apps/business.
//   business_owner — top of the business, like landlord is to property
//   business_staff — scoped staff resolved via business_users at login

export const BUSINESS_ROLES = ['business_owner'] as const
export type BusinessRole = typeof BUSINESS_ROLES[number]
export const BUSINESS_ROLE_LABEL: Record<BusinessRole, string> = {
  business_owner: 'Business Owner',
}

// Agent revenue capabilities — per-property, landlord opt-in. The CS agent may
// only take these revenue-affecting actions on a property where the landlord has
// explicitly enabled the capability (default OFF). Single source of truth for the
// property_agent_permissions.capability CHECK constraint. NOTE: accepting a
// notice-to-vacate and changing lease terms are intentionally NOT here — the agent
// never performs those, with or without a toggle.
export const AGENT_REVENUE_CAPABILITIES = [
  'take_payment',   // take/retry a tenant payment or set up autopay
  'lease_renewal',  // process a lease renewal
  'bill_fee',       // bill a fee against a tenant/lease
] as const
export type AgentRevenueCapability = typeof AGENT_REVENUE_CAPABILITIES[number]
export const AGENT_REVENUE_CAPABILITY_LABEL: Record<AgentRevenueCapability, string> = {
  take_payment: 'Take a payment',
  lease_renewal: 'Process a renewal',
  bill_fee: 'Bill a fee',
}

// Lease renewal request lifecycle. A tenant (often via the agent) expresses
// intent to renew; the LANDLORD finalizes the actual lease — the agent never
// changes lease terms. Single source of truth for the
// lease_renewal_requests.status CHECK.
export const LEASE_RENEWAL_REQUEST_STATUSES = ['requested', 'approved', 'declined', 'cancelled', 'completed'] as const
export type LeaseRenewalRequestStatus = typeof LEASE_RENEWAL_REQUEST_STATUSES[number]

// S565: FlexCredit (rent-payment credit reporting) demand-capture inquiry
// status. Demand-test only for now — 'interested' is the sole live state; the
// others are reserved for when the product actually launches (past the $500/mo
// provider breakeven). No billing/Esusu wired yet.
export const FLEXCREDIT_INQUIRY_STATUSES = ['interested', 'enrolled', 'declined'] as const
export type FlexCreditInquiryStatus = typeof FLEXCREDIT_INQUIRY_STATUSES[number]

// Booking-guest change requests. A no-account booking guest (RV/STR/extended-
// stay) asks the guest agent for a stay change; the HOST finalizes it — the
// agent only records the request (draft-with-approval, never auto-committed).
// Single source for the booking_change_requests.{request_type,status} CHECKs.
export const BOOKING_CHANGE_REQUEST_TYPES = ['late_checkout', 'early_checkin', 'extra_night', 'other'] as const
export type BookingChangeRequestType = typeof BOOKING_CHANGE_REQUEST_TYPES[number]
export const BOOKING_CHANGE_REQUEST_TYPE_LABEL: Record<BookingChangeRequestType, string> = {
  late_checkout: 'Late checkout',
  early_checkin: 'Early check-in',
  extra_night: 'Extra night',
  other: 'Other request',
}
export const BOOKING_CHANGE_REQUEST_STATUSES = ['requested', 'approved', 'declined', 'cancelled'] as const
export type BookingChangeRequestStatus = typeof BOOKING_CHANGE_REQUEST_STATUSES[number]

// Inspection lifecycle stages. Single source for the
// unit_inspections.inspection_type CHECK. 'turnover' = the landlord's
// clean/repair of an empty unit between tenancies — a first-class stage so
// the unit video lifecycle (move-in → move-out → turnover → next move-in)
// has a record for the turn.
export const INSPECTION_TYPES = ['move_in', 'move_out', 'periodic', 'turnover'] as const
export type InspectionType = typeof INSPECTION_TYPES[number]

// Per-item condition rating on an inspection checklist item. Single source
// for the route + agent-tool validators. S602 (Nic): Excellent / Good / Fair /
// Damaged-or-Missing / N/A. "Damaged" and "Missing" stay COMBINED (missing =
// taken/stolen by the tenant — still a chargeable loss, not "not applicable").
// "N/A" means the item doesn't apply to THIS unit (e.g. no dishwasher) — a
// distinct SELECTABLE value, NOT the same as an un-inspected item, which stays
// NULL. N/A is excluded from the move-out worse-than comparison and never
// charges. (Reverses S573's removal of N/A.) The column also allows NULL.
export const INSPECTION_ITEM_CONDITIONS = ['excellent', 'good', 'fair', 'damaged_missing', 'na'] as const
export type InspectionItemCondition = typeof INSPECTION_ITEM_CONDITIONS[number]
export const INSPECTION_ITEM_CONDITION_LABEL: Record<InspectionItemCondition, string> = {
  excellent:       'Excellent',
  good:            'Good',
  fair:            'Fair',
  damaged_missing: 'Damaged / Missing',
  na:              'N/A',
}
// Worse-than ordering for the move-out-vs-move-in comparison (higher = worse).
// 'na' is intentionally omitted — items where either side is N/A are SKIPPED by
// the comparison (routes/inspections.ts), never flagged as damage.
export const INSPECTION_CONDITION_RANK: Record<string, number> = {
  excellent: 0, good: 1, fair: 2, damaged_missing: 3,
}

// ── Common areas & amenity reservations ───────────────────────────────
// Property-level shared amenities (pool, clubhouse, gym, BBQ pavilion…)
// that residents can reserve for private use (parties etc.) and that the
// landlord can take offline (chemical treatment, private rental, event).
// An approved reservation or a landlord closure fans out an
// "amenity unavailable" notification to every active resident of the
// property. Single source for the route/service validators + the two
// migration CHECK constraints.
//
// kind drives the notification copy and who created the row:
//   tenant_reservation — a resident booked it (private use, e.g. a party)
//   private_rental     — landlord rented it out privately to one party
//   maintenance_closure— closed for upkeep (chemical treatment, repair)
//   event              — landlord-run community event (still occupies it)
export const COMMON_AREA_RESERVATION_KINDS = [
  'tenant_reservation', 'private_rental', 'maintenance_closure', 'event',
  // S547: a short-term GUEST (unit_bookings stay, no tenant account) booked
  // it from the property's public website — keyed by guest_booking_id.
  'guest_reservation',
] as const
export type CommonAreaReservationKind = typeof COMMON_AREA_RESERVATION_KINDS[number]

// pending  — tenant request awaiting landlord decision (auto-skipped when
//            the area is auto-approve or the row is landlord-created)
// approved — live; occupies the area + (if notify_residents) alerts residents
// rejected — landlord declined the request
// cancelled— withdrawn by the requester or landlord after the fact
export const COMMON_AREA_RESERVATION_STATUSES = [
  'pending', 'approved', 'rejected', 'cancelled',
] as const
export type CommonAreaReservationStatus = typeof COMMON_AREA_RESERVATION_STATUSES[number]

// Landlord-created kinds never need tenant-request approval; they go live
// immediately. tenant_reservation is the only resident-initiated kind.
export const LANDLORD_RESERVATION_KINDS = [
  'private_rental', 'maintenance_closure', 'event',
] as const

// ── Service interruptions (utility outage broadcasts) ─────────────────
// Landlord-initiated notice that a utility/service will be down — planned
// (scheduled main repair) or emergency (unplanned shutoff) — fanned out to
// affected residents with an expected-restore time. A notice targets a
// whole property (empty unit set) or a specific unit subset. Single source
// for the route validator + the migration CHECK constraints.
export const SERVICE_INTERRUPTION_TYPES = [
  'water', 'power', 'gas', 'heat_ac', 'elevator', 'internet', 'parking', 'other',
] as const
export type ServiceInterruptionType = typeof SERVICE_INTERRUPTION_TYPES[number]

export const SERVICE_INTERRUPTION_TYPE_LABELS: Record<ServiceInterruptionType, string> = {
  water: 'Water', power: 'Power', gas: 'Gas', heat_ac: 'Heat / AC',
  elevator: 'Elevator', internet: 'Internet', parking: 'Parking', other: 'Other',
}

// scheduled — starts in the future; active — ongoing now; resolved —
// landlord marked it restored (may fire an all-clear); cancelled — called off.
export const SERVICE_INTERRUPTION_STATUSES = [
  'scheduled', 'active', 'resolved', 'cancelled',
] as const
export type ServiceInterruptionStatus = typeof SERVICE_INTERRUPTION_STATUSES[number]

// ── Sales leads (marketing-site sales agent → Portfolio Strategists) ──
// S553: single source for the sales_leads.status CHECK (values predate this
// export; the DB CHECK lists the same five).
// ── Calendar-day math (S553) ──────────────────────────────────────────
// Whole-day difference between two calendar dates, immune to the source
// representation. Mixing `new Date('YYYY-MM-DD')` (midnight UTC) with a
// pg DATE column (a Date at midnight LOCAL time) skews raw millisecond
// math by the host's UTC offset — correct only by accident on a
// west-of-UTC server (Math.ceil absorbs the shortfall) and off by one on
// UTC-or-east hosts. Slice both ends to their calendar day first.
export function dayDiff(from: string | Date, to: string | Date): number {
  const day = (v: string | Date): number => {
    if (v instanceof Date) return Date.UTC(v.getFullYear(), v.getMonth(), v.getDate())
    const [y, m, d] = String(v).slice(0, 10).split('-').map(Number)
    return Date.UTC(y, m - 1, d)
  }
  return Math.round((day(to) - day(from)) / 86_400_000)
}

export const SALES_LEAD_STATUSES = [
  'new', 'contacted', 'qualified', 'converted', 'closed',
] as const
export type SalesLeadStatus = typeof SALES_LEAD_STATUSES[number]
export const SALES_LEAD_STATUS_LABELS: Record<SalesLeadStatus, string> = {
  new: 'New',
  contacted: 'Contacted',
  qualified: 'Qualified',
  converted: 'Converted',
  closed: 'Closed',
}

// ── Standard inspection walkthrough checklist (single source) ──────────
// S573 (Nic): per-unit FEATURE catalog — "what does this unit actually have".
// Gates which master-catalog inspection items appear (nothing is ever "N/A";
// absent features = absent items). Stored in units.features (jsonb map); an
// absent key falls back to the unit-type PRESET (`presetOn`), so a unit with
// zero configuration still inspects correctly. New features need only a new
// entry here — no migration (the product evolves via feature requests).
export interface UnitFeatureDef {
  key: string
  label: string
  group: string                 // UI grouping
  types: readonly string[]      // unit types where this feature is offered
  presetOn: readonly string[]   // subset of `types` where it defaults ON
}
const _DWELL = ['apartment', 'single_family', 'mobile_home'] as const
const _SFH_MH = ['single_family', 'mobile_home'] as const
export const UNIT_FEATURE_CATALOG: readonly UnitFeatureDef[] = [
  // Appliances / kitchen
  { key: 'provides_range',        label: 'Range / oven provided',        group: 'Appliances', types: _DWELL,  presetOn: _DWELL },
  { key: 'provides_refrigerator', label: 'Refrigerator provided',        group: 'Appliances', types: _DWELL,  presetOn: _DWELL },
  { key: 'provides_dishwasher',   label: 'Dishwasher provided',          group: 'Appliances', types: _DWELL,  presetOn: [] },
  { key: 'provides_microwave',    label: 'Microwave provided',           group: 'Appliances', types: _DWELL,  presetOn: [] },
  { key: 'garbage_disposal',      label: 'Garbage disposal',             group: 'Appliances', types: _DWELL,  presetOn: [] },
  { key: 'pantry',                label: 'Pantry',                       group: 'Rooms',      types: _DWELL,  presetOn: [] },
  // Rooms / interior extras
  { key: 'provides_blinds',       label: 'Window coverings / blinds',    group: 'Rooms',      types: ['apartment', 'single_family', 'mobile_home', 'hotel_room'], presetOn: ['apartment', 'single_family', 'mobile_home', 'hotel_room'] },
  { key: 'ceiling_fans',          label: 'Ceiling fan(s)',               group: 'Rooms',      types: _DWELL,  presetOn: [] },
  { key: 'fireplace',             label: 'Fireplace',                    group: 'Rooms',      types: _DWELL,  presetOn: [] },
  { key: 'hall_closet',           label: 'Coat / linen closet',          group: 'Rooms',      types: _DWELL,  presetOn: [] },
  // Laundry
  { key: 'in_unit_laundry',       label: 'In-unit laundry',              group: 'Laundry',    types: _DWELL,  presetOn: [] },
  { key: 'provides_washer',       label: 'Washer provided',              group: 'Laundry',    types: _DWELL,  presetOn: [] },
  { key: 'provides_dryer',        label: 'Dryer provided',               group: 'Laundry',    types: _DWELL,  presetOn: [] },
  { key: 'utility_sink',          label: 'Utility sink',                 group: 'Laundry',    types: _DWELL,  presetOn: [] },
  // Systems
  { key: 'central_ac',            label: 'Central A/C',                  group: 'Systems',    types: _DWELL,  presetOn: [] },
  { key: 'evap_cooler',           label: 'Evaporative cooler',           group: 'Systems',    types: _DWELL,  presetOn: [] },
  { key: 'fire_extinguisher',     label: 'Fire extinguisher provided',   group: 'Systems',    types: _DWELL,  presetOn: [] },
  // Doors
  { key: 'back_door',             label: 'Back / rear door',             group: 'Doors',      types: _DWELL,  presetOn: _SFH_MH },
  { key: 'screen_door',           label: 'Screen / storm door',          group: 'Doors',      types: _DWELL,  presetOn: [] },
  { key: 'patio_door',            label: 'Sliding glass / patio door',   group: 'Doors',      types: _DWELL,  presetOn: [] },
  { key: 'attached_garage',       label: 'Attached garage (interior door)', group: 'Doors',   types: ['single_family'], presetOn: [] },
  { key: 'doorbell',              label: 'Doorbell / intercom',          group: 'Doors',      types: _DWELL,  presetOn: [] },
  // Exterior / grounds (SFH + mobile home)
  { key: 'patio_deck',            label: 'Patio / deck',                 group: 'Exterior',   types: _SFH_MH, presetOn: [] },
  { key: 'balcony',               label: 'Balcony',                      group: 'Exterior',   types: ['apartment', 'single_family'], presetOn: [] },
  { key: 'garage_carport',        label: 'Garage / carport',             group: 'Exterior',   types: _SFH_MH, presetOn: [] },
  { key: 'fenced',                label: 'Fenced yard / gates',          group: 'Grounds',    types: _SFH_MH, presetOn: [] },
  { key: 'sprinklers',            label: 'Sprinkler / irrigation',       group: 'Grounds',    types: _SFH_MH, presetOn: [] },
  { key: 'shed',                  label: 'Shed / outbuilding',           group: 'Grounds',    types: _SFH_MH, presetOn: [] },
  // RV site
  { key: 'park_picnic_table',     label: 'Park-provided picnic table',   group: 'RV site',    types: ['rv_spot'], presetOn: [] },
  { key: 'park_fire_ring',        label: 'Park-provided fire ring / grill', group: 'RV site', types: ['rv_spot'], presetOn: [] },
  // Storage / handover
  { key: 'rollup_door',           label: 'Roll-up door',                 group: 'Storage',    types: ['storage'], presetOn: [] },
  { key: 'mailbox',              label: 'Mailbox / mailbox key',         group: 'Handover',   types: ['apartment', 'single_family', 'mobile_home'], presetOn: [] },
  { key: 'gate_code',            label: 'Gate / access code',            group: 'Handover',   types: ['apartment', 'single_family', 'mobile_home', 'rv_spot', 'storage'], presetOn: [] },
]

// Effective feature map for a unit: stored value wins; else the type preset.
// Only features offered for the type are included.
export function resolveUnitFeatures(
  unitType: string | null | undefined,
  stored: Record<string, unknown> | null | undefined,
): Record<string, boolean> {
  const t = unitType ?? 'apartment'
  const out: Record<string, boolean> = {}
  for (const f of UNIT_FEATURE_CATALOG) {
    if (!f.types.includes(t)) continue
    const s = stored?.[f.key]
    out[f.key] = typeof s === 'boolean' ? s : f.presetOn.includes(t)
  }
  return out
}

// The features offered for a unit type (for the setup UI), preset value filled.
export function featuresForType(unitType: string | null | undefined): Array<UnitFeatureDef & { presetValue: boolean }> {
  const t = unitType ?? 'apartment'
  return UNIT_FEATURE_CATALOG.filter(f => f.types.includes(t)).map(f => ({ ...f, presetValue: f.presetOn.includes(t) }))
}

// The areas the agent walks a tenant/landlord through on a move-in / move-out
// / periodic inspection. Each area expects at least one fresh camera photo;
// any item rated 'damaged' or 'missing' forces its own close-up (the agent's
// per-area minimum rule, Nic 2026-06-17). Bedroom areas are generated up to
// the UNIT's bedroom count (capped at 4) so the agent never prompts for a
// bedroom that does not exist. `buildInspectionChecklist` is the single entry
// point consumers (agent tools, inspection UI) call with the unit's facts.
export interface InspectionChecklistArea {
  area: string
  items: readonly string[]
}

export const MAX_INSPECTION_BEDROOMS = 4
export const MAX_INSPECTION_BATHROOMS = 4

// S573: how many living/family areas the checklist repeats (like bedrooms).
export const MAX_INSPECTION_LIVING_AREAS = 3

// S573 (Nic): accessible (ADA) units carry accommodation features the landlord
// must keep functional. Added only when units.is_ada_accessible, for interior-
// inspected residential types. GENERIC FEDERAL items only — per GAM's standing
// no-state-specific-legal-logic rule, per-state accessibility variances are NOT
// encoded here.
const ACCESSIBILITY_INSPECTION_AREA: InspectionChecklistArea = {
  area: 'Accessibility',
  items: [
    'Entry ramp / zero-step entry',
    'Door widths & maneuvering clearance',
    'Lever handles & reachable controls',
    'Bathroom grab bars secure',
    'Roll-in / accessible shower & seat',
    'Accessible toilet height',
    'Roll-under sink clearance (bath & kitchen)',
    'Accessible parking & path of travel',
    'Visual & audible alarms',
    'Threshold transitions & flooring',
  ],
}

// S573 (Nic): a unit's FLOOR PLACEMENT — for tenant search filtering
// ("ground floor only"). Distinct from is_multi_level (internal stairs): a
// single-level unit can still be entirely upstairs or in a basement. Backs
// units.floor_level (nullable = unspecified; migration 20260731190000).
export const FLOOR_LEVELS = ['ground_floor', 'upper_floor', 'basement', 'multi_floor'] as const
export type FloorLevel = typeof FLOOR_LEVELS[number]
export const FLOOR_LEVEL_LABEL: Record<FloorLevel, string> = {
  ground_floor: 'Ground floor',
  upper_floor:  'Upper floor',
  basement:     'Basement',
  multi_floor:  'Multiple floors',
}

// S550 (Nic): who owns the DWELLING on the unit. Backs units.dwelling_ownership
// (migration 20260719160000). Only meaningful for rv_spot and mobile_home —
// every other unit type is landlord-owned by definition and ignores the flag.
export const DWELLING_OWNERSHIP_VALUES = ['landlord', 'tenant'] as const
export type DwellingOwnership = typeof DWELLING_OWNERSHIP_VALUES[number]
export const DWELLING_OWNERSHIP_LABEL: Record<DwellingOwnership, string> = {
  landlord: 'Park/landlord-owned',
  tenant:   'Tenant-owned',
}

// S568 (Nic): rent line-item split. A lease's rent can be itemized into named
// components (space rent + trailer rent + other) that SUM to leases.rent_amount.
// Billing stays one rent payment; the components are the display + metrics
// breakdown. Backs lease_rent_components.kind (migration 20260730150000).
// S568 (Nic): landlord-entered expense categories for bookkeeping. Curated set
// + 'other'. Backs landlord_expenses.category (migration 20260730240000).
export const EXPENSE_CATEGORIES = [
  'maintenance', 'repairs', 'utilities', 'insurance', 'property_tax', 'management',
  'supplies', 'landscaping', 'professional', 'mortgage_interest', 'hoa', 'advertising',
  'lot_rent', 'bank_fees', 'other',
] as const
export type ExpenseCategory = typeof EXPENSE_CATEGORIES[number]
export const EXPENSE_CATEGORY_LABEL: Record<ExpenseCategory, string> = {
  maintenance: 'Maintenance', repairs: 'Repairs', utilities: 'Utilities', insurance: 'Insurance',
  property_tax: 'Property tax', management: 'Management', supplies: 'Supplies', landscaping: 'Landscaping',
  professional: 'Legal / professional', mortgage_interest: 'Mortgage interest', hoa: 'HOA', advertising: 'Advertising',
  lot_rent: 'Lot rent', bank_fees: 'Bank fees / charges', other: 'Other',
}

// S605 (Nic): microdeposit verification comes in TWO flavours and STRIPE picks,
// not us. Nic hit the mismatch live — the app promised "two small deposits" and
// the verify screen then asked for a six-digit code:
//
//   'amounts'         — two deposits under $1; the tenant enters both amounts.
//   'descriptor_code' — ONE $0.01 deposit whose statement DESCRIPTION carries a
//                       six-digit code; the tenant enters that code.
//
// Hardcoding either one guarantees the instructions contradict the screen for
// roughly half of banks, which on a rent payment reads as "something is wrong
// with my account". One helper, used everywhere, so the two can never drift.
export type MicrodepositType = 'amounts' | 'descriptor_code'

export function microdepositInstruction(type: MicrodepositType | null | undefined): string {
  if (type === 'descriptor_code') {
    return 'We sent a $0.01 deposit to your bank. Find it on your statement — its description ' +
      'contains a code starting with SM. Enter that code here to finish setting up your bank. ' +
      'Your bank may print its own reference number alongside it; the one we need is the SM code.'
  }
  if (type === 'amounts') {
    return 'We sent two small deposits to your bank. Once you see them, enter both amounts ' +
      'here to finish setting up your bank.'
  }
  // Type unknown (Stripe decides at confirm time, and older records predate this
  // field): describe both rather than promising the wrong one.
  return 'We sent a small verification deposit to your bank. When it arrives, come back here — ' +
    'we\'ll ask for either the deposit amounts or the code starting with SM in its description, ' +
    'whichever your bank received.'
}

// S605 (Nic, DIRECTIVE): "Every unit should be required to have a prefix to
// eliminate accidents."
//
// The accident: adding ONE unit numbered "37" to a park of RV 01…RV 36 created a
// unit literally called "37", because the number field is a PREFIX when adding a
// batch and a LITERAL name when adding one. Requiring a prefix removes the
// ambiguity at the source — "RV 37" means the same thing either way.
//
// It also keeps numbers unique across unit types on one property, which the
// uniqueness index needs: a park numbering mobile homes and RV spots 1..N
// independently collides on bare numbers but never on "MH 1" vs "RV 1".
//
// The rule is deliberately minimal — must not START with a digit — rather than a
// list of approved prefixes. Parks name things "Site", "Lot", "Space", "Slip",
// "Pad"; an allow-list would be wrong somewhere immediately.
//
// ENFORCED ON WRITE ONLY. Existing unprefixed units keep their names; renaming
// them is the landlord's call, not a migration's.
export function unitNumberNeedsPrefix(unitNumber: string): boolean {
  return /^\s*\d/.test(String(unitNumber ?? ''))
}

// S605 (Nic, DIRECTIVE): "Each unit type should have a standard platform prefix.
// I don't want it to be mobile home site one spelled out on one property and MH
// one on a different property."
//
// UNIT_TYPE_PREFIX already existed but was decorative — used once as a display
// hint and enforced nowhere, so every landlord invented their own convention and
// the same unit type read differently on every property. It is now the single
// source of the prefix, and the landlord no longer types one at all: they enter
// the identifier and the platform supplies the label.
//
// That also retires the whole class of accident behind this rule — typing "37"
// on a single unit can no longer produce a unit called "37", because the prefix
// is never the landlord's to omit.
//
// Identifiers may be numeric OR alphabetic: parks number spaces, buildings often
// letter apartments (Nic: "apartment a, apartment b, apartment c"). Pure numbers
// are zero-padded to two so 1..9 sort next to 10+ instead of above them; letters
// and mixed identifiers ("4B") are left as typed.
export function canonicalUnitNumber(unitType: UnitType, raw: string): string {
  const prefix = UNIT_TYPE_PREFIX[unitType] ?? ''
  let id = String(raw ?? '').trim().toUpperCase().replace(/\s+/g, ' ')

  // Strip the standard prefix if the landlord typed it anyway.
  if (prefix && (id === prefix || id.startsWith(prefix + ' '))) {
    id = id.slice(prefix.length).trim()
  } else {
    // Strip a spelled-out label in front of a number — "MOBILE HOME SITE 1",
    // "SPACE 4", "LOT 12" — which is exactly the drift this rule exists to end.
    // Only when what follows STARTS WITH A DIGIT, so a lettered identifier
    // ("A", "B") is never mistaken for a label and eaten.
    const m = id.match(/^[A-Z][A-Z\s.#-]*\s(\d.*)$/)
    if (m) id = m[1].trim()
  }
  id = id.replace(/^#/, '').trim()

  // Zero-pad a pure number to two digits. Anything already 2+ digits, or
  // containing letters, is left alone.
  if (/^\d$/.test(id)) id = '0' + id

  return id ? `${prefix} ${id}`.trim() : prefix
}

export const UNIT_NUMBER_PREFIX_ERROR =
  'Unit numbers need a label in front of the number — "RV 37", "MH 4", "Apt 101", "Site 12". ' +
  'A bare number is too easy to mistype into the wrong space, and it collides when two unit ' +
  'types share a number.'

// S605 (Nic): ABA routing-number checksum.
//
// GAM collects routing + account numbers on its own form (microdeposits only —
// see the no-instant-verification directive), which means no bank-search UI
// validates the number before it goes to Stripe. Nic: "you don't have to select
// the institution... I don't know if people would be more suspicious."
//
// A picker would be redundant — the routing number already identifies the bank.
// What a picker actually provides is CONFIDENCE that the number is right, and
// the checksum gives that instantly and more reliably: every valid US routing
// number satisfies this weighted mod-10, so a transposed digit is caught as the
// tenant types instead of surfacing as a failed deposit days later.
export function isValidRoutingNumber(routing: string): boolean {
  const d = String(routing).replace(/\D/g, '')
  if (d.length !== 9) return false
  const sum =
    3 * (+d[0] + +d[3] + +d[6]) +
    7 * (+d[1] + +d[4] + +d[7]) +
    1 * (+d[2] + +d[5] + +d[8])
  return sum % 10 === 0
}

// S605 (Nic): income the landlord receives that GAM did not collect. The mirror
// of EXPENSE_CATEGORIES — before this, a money-in bank row could only be ignored,
// so the P&L counted every expense but only GAM-collected income.
//
// Deliberately excludes rent: rent reaches the P&L from `payments`, and offering
// it here would invite double-counting the same money.
export const OTHER_INCOME_CATEGORIES = [
  'laundry', 'vending', 'storage', 'utility_reimbursement', 'late_fees', 'application_fees',
  'pet_fees', 'parking', 'propane_fuel', 'insurance_claim', 'tax_refund', 'sale_proceeds',
  'owner_contribution', 'interest', 'other',
] as const
export type OtherIncomeCategory = typeof OTHER_INCOME_CATEGORIES[number]
export const OTHER_INCOME_CATEGORY_LABEL: Record<OtherIncomeCategory, string> = {
  laundry: 'Laundry', vending: 'Vending', storage: 'Storage', utility_reimbursement: 'Utility reimbursement',
  late_fees: 'Late fees', application_fees: 'Application fees', pet_fees: 'Pet fees', parking: 'Parking',
  propane_fuel: 'Propane / fuel', insurance_claim: 'Insurance claim', tax_refund: 'Tax refund',
  sale_proceeds: 'Sale proceeds', owner_contribution: 'Owner contribution', interest: 'Interest earned',
  other: 'Other income',
}

// S570 (Nic): bank feed (Stripe Financial Connections). A landlord links their
// operating bank read-only; transactions sync in and get categorized into the
// landlord P&L. Back bank_connections / bank_transactions / landlord_merchant_rules
// (migration 20260730250000).
export const BANK_CONNECTION_PROVIDERS = ['stripe_fc', 'csv'] as const
export type BankConnectionProvider = typeof BANK_CONNECTION_PROVIDERS[number]

export const BANK_CONNECTION_STATUSES = ['active', 'disconnected', 'error'] as const
export type BankConnectionStatus = typeof BANK_CONNECTION_STATUSES[number]

// needs_review = surfaced for the landlord to categorize; matched = auto-linked to
// GAM-known money (a disbursement/payment), hidden from the queue; categorized =
// became a landlord_expenses row; ignored = dismissed by the landlord.
export const BANK_TXN_STATUSES = ['needs_review', 'matched', 'categorized', 'ignored'] as const
export type BankTxnStatus = typeof BANK_TXN_STATUSES[number]

// How a categorized bank charge maps onto the expense model: to one unit, to the
// property as a common cost, or to the property split across its units.
export const MERCHANT_RULE_SCOPES = ['unit', 'property_common', 'property_allocate'] as const
export type MerchantRuleScope = typeof MERCHANT_RULE_SCOPES[number]

// S570 (Nic): notification types that are too important to silence. Email is
// FORCED on for these regardless of the user's preference (they can't toggle it
// off in the UI), because missing them causes real harm (a failed rent payment
// slipping to a late fee / eviction clock). In-app is always on already.
// S609: a failed AUTOPAY pull belongs here for the same reason. The tenant
// believes their rent is handled and has no reason to check — silence is the
// worst possible outcome, and it ends in a late fee they never saw coming.
export const CRITICAL_NOTIFICATION_TYPES = ['payment_failed', 'autopay_failed'] as const
export type CriticalNotificationType = typeof CRITICAL_NOTIFICATION_TYPES[number]
export const isCriticalNotificationType = (t: string): boolean =>
  (CRITICAL_NOTIFICATION_TYPES as readonly string[]).includes(t)

// S568 (Nic): home-ownership tracking (who owns a tenant-owned home/RV — the
// economic sublessor). Backs home_ownerships (migration 20260730210000).
export const HOME_OWNERSHIP_ACQUIRED_VIA = ['recorded', 'sale', 'transfer', 'financed_payoff'] as const
export type HomeOwnershipAcquiredVia = typeof HOME_OWNERSHIP_ACQUIRED_VIA[number]
export const HOME_OWNERSHIP_ACQUIRED_VIA_LABEL: Record<HomeOwnershipAcquiredVia, string> = {
  recorded: 'Recorded', sale: 'Sale', transfer: 'Transfer', financed_payoff: 'Financed payoff',
}

export const RENT_COMPONENT_KINDS = ['space', 'trailer', 'other'] as const
export type RentComponentKind = typeof RENT_COMPONENT_KINDS[number]
export const RENT_COMPONENT_KIND_LABEL: Record<RentComponentKind, string> = {
  space:   'Space rent',
  trailer: 'Trailer/home rent',
  other:   'Other',
}

// S558 (Nic): per-unit occupancy mode. whole_unit = one lease, co-tenants share
// it (default safeguard). by_room = independent stacked leases, one per person,
// capped at 2×bedrooms (dorms / by-the-room rentals). See migration
// 20260726101000.
export const OCCUPANCY_MODES = ['whole_unit', 'by_room'] as const
export type OccupancyMode = typeof OCCUPANCY_MODES[number]
export const OCCUPANCY_MODE_LABEL: Record<OccupancyMode, string> = {
  whole_unit: 'Whole unit (one lease)',
  by_room:    'By the room (separate leases)',
}
// People-per-bedroom cap for by_room stacking.
export const BY_ROOM_LEASES_PER_BEDROOM = 2

// S558 (Nic): late-fee lease-document field columns. These boxes are populated
// from the per-(property, unit_type) late-fee POLICY (S535/S537) and stamped
// onto the drafted lease — the landlord must NOT be able to change the value,
// rebind, or delete them (that's how an off-policy / illegal charge would enter
// a signed lease). The template editor locks any field bound to one of these.
export const LATE_FEE_LEASE_COLUMNS = [
  'late_fee_grace_days',
  'late_fee_initial_flat', 'late_fee_initial_percent',
  'late_fee_accrual_flat_daily', 'late_fee_accrual_flat_weekly', 'late_fee_accrual_flat_monthly',
  'late_fee_accrual_percent_daily', 'late_fee_accrual_percent_weekly', 'late_fee_accrual_percent_monthly',
  'late_fee_cap_flat', 'late_fee_cap_percent',
] as const
export function isLateFeeColumn(col: string | null | undefined): boolean {
  return !!col && (LATE_FEE_LEASE_COLUMNS as readonly string[]).includes(col)
}

// S582: platform-locked lease columns — auto-inserted, non-editable in the
// template editor and at signing. late-fee columns (policy-controlled) +
// rent_due_day (LOCKED to the 1st — see WRITABLE_LEASE_COLUMN_SPECS). The landlord
// never chooses these; they're stamped so the signed doc states them verbatim.
export function isLockedLeaseColumn(col: string | null | undefined): boolean {
  return isLateFeeColumn(col) || col === 'rent_due_day'
}

// Park-owned RV rented as a unit: the site areas PLUS the rig itself.
// An RV never gets bedroom areas, no matter who owns it.
export const RV_UNIT_INSPECTION_AREAS: readonly InspectionChecklistArea[] = [
  { area: 'RV interior', items: ['Sleeping area', 'Dinette/seating', 'Cabinets & storage', 'Flooring'] },
  { area: 'RV kitchenette', items: ['Stove/range', 'Refrigerator', 'Sink & faucet', 'Microwave'] },
  { area: 'RV bath', items: ['Toilet', 'Shower', 'Sink', 'Ventilation'] },
  { area: 'RV systems', items: ['A/C & furnace', 'Water heater', 'Smoke/CO/LP detectors', 'Slide-outs', 'Awning'] },
  { area: 'RV exterior', items: ['Body & roof', 'Windows & seals', 'Steps & handrails', 'Keys & locks'] },
]

// S548: which unit types require a FINALIZED in-person move-out inspection
// before a deposit return can begin. rv_spot deliberately absent — its
// "walkthrough" is the mandatory pull-out meter read + same-day settlement.
export const MOVE_OUT_INSPECTION_REQUIRED_UNIT_TYPES = [
  'apartment', 'single_family', 'mobile_home', 'storage', 'parking',
] as const

// The master derivation (S550): every consumer — self-directed tenant
// walkthrough, agent-guided walkthrough, staff/landlord creation, scheduled
// move-outs — calls THIS with the unit's real facts (type, bedroom count,
// dwelling ownership) and gets exactly the relevant areas:
//   rv_spot     tenant-owned   -> site only (tenant's rig is theirs)
//   rv_spot     landlord-owned -> site + RV interior/rig (NEVER bedrooms)
//   mobile_home tenant-owned   -> lot/space only (never inside their home)
//   mobile_home landlord-owned -> full residential, bedrooms = actual count
//   apartment / single_family  -> full residential, bedrooms = actual count
//   storage / parking          -> tiny empty-and-latch checklist
//   everything else            -> residential base without bedrooms
export function buildInspectionChecklist(input: {
  unitType?: string | null
  bedrooms?: number | null
  bathrooms?: number | null
  livingAreas?: number | null
  dwellingOwnership?: string | null
  isMultiLevel?: boolean | null
  isAdaAccessible?: boolean | null
  /** units.features (jsonb) — resolved against type presets to gate items */
  features?: Record<string, unknown> | null
}): InspectionChecklistArea[] {
  const type = input.unitType ?? 'apartment'
  const ownership: DwellingOwnership = input.dwellingOwnership === 'tenant' ? 'tenant' : 'landlord'
  const F = resolveUnitFeatures(type, input.features)
  const has = (k: string) => !!F[k]
  const clamp = (v: any, max: number, min: number) => {
    const n = Math.trunc(Number(v))
    return Math.min(Math.max(Number.isFinite(n) ? n : min, min), max)
  }
  const clone = (areas: InspectionChecklistArea[]) => areas.map(a => ({ area: a.area, items: [...a.items] }))

  // ── RV spot: site (always) + rig (park-owned only). Never bedrooms. ──
  if (type === 'rv_spot') {
    const site: InspectionChecklistArea = { area: 'RV site', items: [
      'Pad surface / condition', 'Site leveling', 'Electric pedestal / hookup',
      'Water connection / spigot', 'Sewer connection', 'Weeds / vegetation',
      'Trash / debris removed', 'Site marker / number',
      ...(has('park_picnic_table') ? ['Picnic table'] : []),
      ...(has('park_fire_ring') ? ['Fire ring / grill'] : []),
    ] }
    return clone(ownership === 'landlord' ? [site, ...RV_UNIT_INSPECTION_AREAS] : [site])
  }
  if (type === 'storage') {
    return clone([{ area: 'Storage unit', items: [
      'Unit empty / cleared', 'Door operation', 'Latch / locking mechanism',
      'Interior walls & floor', ...(has('rollup_door') ? ['Roll-up door'] : []),
    ] }])
  }
  if (type === 'parking') {
    return clone([{ area: 'Parking space', items: ['Space empty / cleared', 'Space markings / number', 'Surface condition'] }])
  }

  // ── Grounds (single-family + mobile home, incl. tenant-owned grounds-only) ──
  const groundsAreas = (): InspectionChecklistArea[] => ([
    { area: 'Exterior & structure', items: [
      'Exterior walls / siding', 'Roof & gutters (visible)',
      ...(type === 'mobile_home' ? ['Skirting', 'Foundation / piers'] : []),
      'Exterior lighting', 'Exterior faucets / hose bibs', 'Porch / stoop / entry steps',
      ...(has('patio_deck') ? ['Patio / deck'] : []),
      ...(has('balcony') ? ['Balcony'] : []),
      ...(has('garage_carport') ? ['Garage / carport'] : []),
      'Driveway / parking pad',
    ] },
    { area: 'Yard & grounds', items: [
      'Front yard — landscaping & condition', 'Back yard — landscaping & condition',
      'Weeds / overgrowth', 'Trees / shrubs',
      ...(has('fenced') ? ['Fencing & gates'] : []),
      ...(has('sprinklers') ? ['Sprinkler / irrigation'] : []),
      ...(has('shed') ? ['Shed / outbuilding'] : []),
      'Trash / debris removed',
    ] },
  ])
  const handover = (): InspectionChecklistArea => ({ area: 'Handover', items: [
    'Keys / remotes / fobs',
    ...(has('mailbox') ? ['Mailbox key'] : []),
    ...(has('garage_carport') ? ['Garage-door opener'] : []),
    ...(has('gate_code') ? ['Gate / access code'] : []),
    'Utility meter readings',
  ] })

  // Tenant-owned mobile home: grounds/lot only — never inside their dwelling.
  if (type === 'mobile_home' && ownership === 'tenant') {
    return clone([...groundsAreas(), handover()])
  }

  // ── Interior dwellings (apartment / single-family / landlord MH / hotel / commercial) ──
  const isDwelling = ['apartment', 'single_family', 'mobile_home'].includes(type)
  const areas: InspectionChecklistArea[] = []

  areas.push({ area: 'Kitchen', items: [
    'Cabinets & drawers', 'Countertops', 'Sink & faucet', 'Backsplash',
    ...(has('provides_range') ? ['Range / oven'] : []),
    'Range hood / vent',
    ...(has('provides_refrigerator') ? ['Refrigerator'] : []),
    ...(has('provides_dishwasher') ? ['Dishwasher'] : []),
    ...(has('provides_microwave') ? ['Microwave'] : []),
    ...(has('garbage_disposal') ? ['Garbage disposal'] : []),
    ...(has('pantry') ? ['Pantry'] : []),
    'Flooring', 'Walls & ceiling', 'Outlets (incl. GFCI)', 'Lighting',
  ] })

  // Bathrooms — one per real bathroom (ceil; last is a half if fractional).
  const bathRaw = Number(input.bathrooms ?? 1)
  const bathCount = Math.min(Math.max(Number.isFinite(bathRaw) ? Math.ceil(bathRaw) : 1, 1), MAX_INSPECTION_BATHROOMS)
  const hasHalf = Number.isFinite(bathRaw) && bathRaw > 0 && bathRaw % 1 !== 0
  for (let i = 0; i < bathCount; i++) {
    const isHalf = hasHalf && i === bathCount - 1
    areas.push({
      area: bathCount === 1 ? 'Bathroom' : (isHalf ? `Bathroom ${i + 1} (half)` : `Bathroom ${i + 1}`),
      items: [
        'Toilet', 'Sink & vanity', 'Faucet & fixtures',
        ...(!isHalf ? ['Tub / shower', 'Shower surround / tile & grout'] : []),
        'Mirror / medicine cabinet', 'Exhaust fan / ventilation', 'Flooring',
        'Walls & ceiling', 'GFCI outlet', 'Towel bars / accessories', 'Visible leaks / shutoffs',
      ],
    })
  }

  // Living areas — repeat per the unit's living-area count (dwellings only).
  const livingCount = isDwelling ? clamp(input.livingAreas ?? 1, MAX_INSPECTION_LIVING_AREAS, 1) : 1
  for (let i = 0; i < livingCount; i++) {
    areas.push({
      area: livingCount === 1 ? 'Living / dining' : `Living area ${i + 1}`,
      items: [
        'Walls & paint', 'Flooring', 'Ceiling', 'Windows & screens',
        ...(has('provides_blinds') ? ['Blinds / window covering'] : []),
        ...(has('ceiling_fans') ? ['Ceiling fan'] : []),
        'Light fixtures', 'Outlets & switches',
        ...(has('fireplace') ? ['Fireplace'] : []),
        'Dining area',
      ],
    })
  }

  // Bedrooms — sized to the unit (dwellings only).
  if (isDwelling) {
    const n = clamp(input.bedrooms ?? 1, MAX_INSPECTION_BEDROOMS, 0)
    for (let i = 0; i < n; i++) {
      areas.push({ area: `Bedroom ${i + 1}`, items: [
        'Walls & paint', 'Flooring', 'Ceiling', 'Closet & shelving',
        'Window — operation, screen & lock',
        ...(has('provides_blinds') ? ['Blinds / window covering'] : []),
        'Outlets & light switches', 'Ceiling light fixture',
        ...(has('ceiling_fans') ? ['Ceiling fan'] : []),
        'Entry door', 'Smoke detector',
      ] })
    }
  }

  // Hallways & stairs
  const hall = ['Hallway walls & flooring']
  if (has('hall_closet')) hall.push('Coat / linen closet')
  hall.push('Smoke / CO detector')
  if (input.isMultiLevel) hall.push('Staircase & treads', 'Handrail — secure & sturdy', 'Landing', 'Stairwell lighting')
  areas.push({ area: 'Hallways & stairs', items: hall })

  // Laundry (only if in-unit)
  if (has('in_unit_laundry')) {
    areas.push({ area: 'Laundry', items: [
      ...(has('provides_washer') ? ['Washer'] : []),
      ...(has('provides_dryer') ? ['Dryer'] : []),
      'Washer / dryer hookups', 'Dryer vent',
      ...(has('utility_sink') ? ['Utility sink'] : []),
      'Flooring & walls',
    ] })
  }

  areas.push({ area: 'Systems & safety', items: [
    'Heating — furnace / HVAC', 'Thermostat',
    ...(has('central_ac') ? ['Cooling — A/C'] : []),
    ...(has('evap_cooler') ? ['Cooling — evaporative cooler'] : []),
    'Water heater', 'Electrical panel / breakers', 'Smoke detectors', 'Carbon-monoxide detectors',
    ...(has('fire_extinguisher') ? ['Fire extinguisher'] : []),
    'Plumbing — visible leaks / shutoffs', 'Vents / registers / ductwork',
  ] })

  areas.push({ area: 'Entry & doors', items: [
    'Front door & deadbolt',
    ...(has('back_door') ? ['Back / rear door'] : []),
    ...(has('screen_door') ? ['Screen / storm door'] : []),
    ...(has('patio_door') ? ['Sliding glass / patio door'] : []),
    ...(has('attached_garage') ? ['Garage interior door'] : []),
    ...(has('doorbell') ? ['Doorbell / intercom'] : []),
  ] })

  if (input.isAdaAccessible) areas.push(ACCESSIBILITY_INSPECTION_AREA)

  // Exterior: SFH + landlord-owned mobile home get full grounds; an apartment
  // shares building common areas; other interior types have no exterior area.
  if (type === 'single_family' || type === 'mobile_home') {
    areas.push(...groundsAreas())
  } else if (type === 'apartment') {
    areas.push({ area: 'Entry & common areas', items: [
      'Building entry / lobby', 'Shared hallway / stairwell',
      ...(has('balcony') ? ['Balcony'] : []),
      'Assigned parking / storage',
    ] })
  }

  areas.push(handover())
  return clone(areas)
}

// Per-business staff positions. Single source of truth for the
// business_users.staff_role CHECK constraint (S453 migration).
export const BUSINESS_STAFF_ROLES = [
  'manager',     // full operational scope, no ownership transfer
  'dispatcher',  // route/appointment planning, customer management
  'driver',      // driver-facing — assigned routes, complete stops only
  'office',      // billing/invoicing, no driver/route ops
] as const
export type BusinessStaffRole = typeof BUSINESS_STAFF_ROLES[number]
export const BUSINESS_STAFF_ROLE_LABEL: Record<BusinessStaffRole, string> = {
  manager:    'Manager',
  dispatcher: 'Dispatcher',
  driver:     'Driver',
  office:     'Office',
}

// businesses.business_type CHECK enum.
export const BUSINESS_TYPES = [
  'trash_hauling',
  'maintenance_crew',
  'mobile_rental',
  'equipment_rental',
  'mini_market',
  'mechanic_stationary',
  'mechanic_mobile',
  'other',
] as const
export type BusinessType = typeof BUSINESS_TYPES[number]
export const BUSINESS_TYPE_LABEL: Record<BusinessType, string> = {
  trash_hauling:       'Trash / Waste Hauling',
  maintenance_crew:    'Maintenance Crew',
  mobile_rental:       'Mobile Rental (delivery-route)',
  equipment_rental:    'Equipment Rental (fixed-location)',
  mini_market:         'Mini Market / Retail',
  mechanic_stationary: 'Mechanic (Stationary Shop)',
  mechanic_mobile:     'Mechanic (Mobile)',
  other:               'Other',
}

// S492: businesses.enabled_features CHECK catalog. Single source of
// truth for the set of features a business can toggle. The CHECK
// constraint on `businesses.enabled_features` mirrors this list — to
// add a feature, append here AND cut a migration that ALTERs the
// CHECK (per CLAUDE.md "Single source of truth for enums and CHECK
// constraints" rule).
export const BUSINESS_FEATURES = [
  'customers',
  'staff',
  'recurring_schedules',
  'appointments',
  'routing',
  'pos',
  'inventory',
  'work_orders',
  'customer_vehicles',
  'invoicing',
  'payments',
  'quotes',
  'discounts',
  'bookkeeping',
] as const
export type BusinessFeature = typeof BUSINESS_FEATURES[number]

// S513 (J): discount code value types. percent → discount_value is a
// percentage (15.00 = 15% off); fixed → discount_value is a flat dollar
// amount off the pre-tax subtotal.
export const BUSINESS_DISCOUNT_TYPES = ['percent', 'fixed'] as const
export type BusinessDiscountType = typeof BUSINESS_DISCOUNT_TYPES[number]

export const BUSINESS_FEATURE_LABEL: Record<BusinessFeature, string> = {
  customers:           'Customers',
  staff:               'Staff',
  recurring_schedules: 'Recurring Schedules',
  appointments:        'Appointments',
  routing:             'Routes & Fleet',
  pos:                 'Point of Sale',
  inventory:           'Inventory',
  work_orders:         'Work Orders',
  customer_vehicles:   'Customer Vehicles',
  invoicing:           'Invoicing',
  payments:            'Payments',
  quotes:              'Quotes & Estimates',
  discounts:           'Discounts & Coupons',
  bookkeeping:         'Bookkeeping',
}

export const BUSINESS_FEATURE_DESCRIPTION: Record<BusinessFeature, string> = {
  customers:           'Track who you serve. Always on.',
  staff:               'Team members with role-based access. Always on.',
  recurring_schedules: 'Repeating services on a calendar (weekly, monthly). Powers Routes when fleet is on.',
  appointments:        'Timed visits — book and confirm individual customer slots.',
  routing:             'Daily route optimization for fleet-based services: depots, vehicles, dump locations, generated routes, driver execution.',
  pos:                 'In-store register for retail sales. Inventory-aware.',
  inventory:           'Stock tracking. Pairs with POS for retail and with Work Orders for parts.',
  work_orders:         'Service jobs with diagnosis, labor, parts, and per-job invoicing. Attaches to a customer or a customer vehicle.',
  customer_vehicles:   'Track customer-owned vehicles by VIN. Pairs with Work Orders. Cross-business history layer designed for future.',
  invoicing:           'Send invoices (recurring or per-service). Tracks paid / unpaid.',
  payments:            'Collect customer payments via Stripe Connect. Pairs with Invoicing.',
  quotes:              'Price proposals before work begins. Customer reviews, you mark accepted, then convert to an invoice or work order.',
  discounts:           'Owner-created discount codes (percent or flat amount) applied at the register or on an invoice. Optional usage limits + expiry.',
  bookkeeping:         'Track expenses and run a profit & loss report. Chart of accounts, expense/income transactions, and P&L over any date range.',
}

// Features that are universal and cannot be toggled off. Locked-on
// because every business needs them.
export const BUSINESS_FEATURE_ALWAYS_ON: BusinessFeature[] = [
  'customers',
  'staff',
]

// Default feature set per business_type. Drives the at-signup
// pre-fill; owner can edit anytime in Settings → Features.
export const BUSINESS_TYPE_DEFAULT_FEATURES: Record<BusinessType, BusinessFeature[]> = {
  trash_hauling: [
    'customers', 'staff', 'recurring_schedules', 'routing',
    'invoicing', 'payments',
  ],
  maintenance_crew: [
    'customers', 'staff', 'appointments', 'work_orders',
    'inventory', 'invoicing', 'payments', 'quotes', 'discounts',
  ],
  mobile_rental: [
    'customers', 'staff', 'appointments', 'routing',
    'invoicing', 'payments',
  ],
  equipment_rental: [
    'customers', 'staff', 'appointments', 'inventory',
    'invoicing', 'payments',
  ],
  mini_market: [
    'customers', 'staff', 'pos', 'inventory',
    'invoicing', 'payments', 'discounts',
  ],
  mechanic_stationary: [
    'customers', 'staff', 'appointments', 'work_orders',
    'customer_vehicles', 'inventory', 'invoicing', 'payments',
    'quotes', 'discounts',
  ],
  mechanic_mobile: [
    'customers', 'staff', 'appointments', 'routing',
    'work_orders', 'customer_vehicles', 'inventory',
    'invoicing', 'payments', 'quotes', 'discounts',
  ],
  other: [
    'customers', 'staff', 'invoicing', 'payments',
  ],
}

// ── S502: business_users.permissions catalog ──────────────────
//
// Single source of truth for the per-staff permission text[] column.
// Owners always have full access (no row in business_users); staff are
// gated to the subset they were granted. Each permission is a
// `feature.action` pair so the access-helper can also enforce the
// feature toggle from the same string (e.g. 'invoices.write' requires
// the 'invoicing' feature enabled).
//
// The same list appears in the businesses_users CHECK constraint
// (S502 migration). Adding a new permission requires:
//   - append to this array
//   - migration to ALTER the CHECK
//   - update PERMISSION_BY_ROLE defaults if appropriate
//   - if it gates a new endpoint, add the requireBusinessAccess() call
export const BUSINESS_STAFF_PERMISSIONS = [
  // Dashboard
  'dashboard.view',
  // Customers
  'customers.read',
  'customers.write',
  // Appointments
  'appointments.read',
  'appointments.write',
  // Invoices
  'invoices.read',
  'invoices.write',
  'invoices.send',
  // Quotes
  'quotes.read',
  'quotes.write',
  'quotes.send',
  // POS
  'pos.use',
  'pos.refund',
  // Inventory
  'inventory.read',
  'inventory.write',
  'inventory.adjust',
  // Work orders
  'work_orders.read',
  'work_orders.write',
  'work_orders.complete',
  // Customer vehicles
  'vehicles.read',
  'vehicles.write',
  // Routes (fleet)
  'routes.read',
  'routes.write',
  'routes.drive',
  // Discounts / coupons
  'discounts.read',
  'discounts.write',
  // Reports / analytics (owner-level data view)
  'reports.view',
] as const
export type BusinessStaffPermission = typeof BUSINESS_STAFF_PERMISSIONS[number]

// UI-grouped labels for the permission editor on Staff page.
export const BUSINESS_STAFF_PERMISSION_GROUP: Record<BusinessStaffPermission, string> = {
  'dashboard.view':      'Overview',
  'customers.read':      'Customers',
  'customers.write':     'Customers',
  'appointments.read':   'Appointments',
  'appointments.write':  'Appointments',
  'invoices.read':       'Invoices',
  'invoices.write':      'Invoices',
  'invoices.send':       'Invoices',
  'quotes.read':         'Quotes',
  'quotes.write':        'Quotes',
  'quotes.send':         'Quotes',
  'pos.use':             'POS',
  'pos.refund':          'POS',
  'inventory.read':      'Inventory',
  'inventory.write':     'Inventory',
  'inventory.adjust':    'Inventory',
  'work_orders.read':    'Work Orders',
  'work_orders.write':   'Work Orders',
  'work_orders.complete':'Work Orders',
  'vehicles.read':       'Customer Vehicles',
  'vehicles.write':      'Customer Vehicles',
  'routes.read':         'Routes',
  'routes.write':        'Routes',
  'routes.drive':        'Routes',
  'discounts.read':      'Discounts',
  'discounts.write':     'Discounts',
  'reports.view':        'Reports',
}

export const BUSINESS_STAFF_PERMISSION_LABEL: Record<BusinessStaffPermission, string> = {
  'dashboard.view':      'View dashboard',
  'customers.read':      'View customers',
  'customers.write':     'Create + edit customers',
  'appointments.read':   'View appointments',
  'appointments.write':  'Create + edit appointments',
  'invoices.read':       'View invoices',
  'invoices.write':      'Create + edit invoices',
  'invoices.send':       'Send invoices + record payments',
  'quotes.read':         'View quotes',
  'quotes.write':        'Create + edit quotes',
  'quotes.send':         'Send quotes + mark accept/decline + convert',
  'pos.use':             'Use the POS register',
  'pos.refund':          'Refund POS sales',
  'inventory.read':      'View inventory',
  'inventory.write':     'Create + edit inventory items',
  'inventory.adjust':    'Adjust stock counts',
  'work_orders.read':    'View work orders',
  'work_orders.write':   'Create + edit work orders + add lines',
  'work_orders.complete':'Complete + cancel work orders',
  'vehicles.read':       'View customer vehicles',
  'vehicles.write':      'Create + edit customer vehicles',
  'routes.read':         'View routes',
  'routes.write':        'Generate + edit routes',
  'routes.drive':        'Drive routes (mobile UI)',
  'discounts.read':      'View discount codes',
  'discounts.write':     'Create + edit discount codes',
  'reports.view':        'View reports + analytics',
}

// Defaults applied to a new staff member based on their staff_role at
// invite time. Owner can override per-staff after they accept.
//
// Manager: full operational scope (no settings / no staff management).
// Dispatcher: customer-facing ops + routes/appointments/quotes (no POS, no inventory write).
// Driver: drive-only + read appointments + read customers + read routes.
// Office: customer-facing billing — invoices/quotes/payments + customers + appointments + POS register.
export const BUSINESS_STAFF_PERMISSIONS_BY_ROLE: Record<BusinessStaffRole, BusinessStaffPermission[]> = {
  manager: [
    'dashboard.view',
    'customers.read', 'customers.write',
    'appointments.read', 'appointments.write',
    'invoices.read', 'invoices.write', 'invoices.send',
    'quotes.read', 'quotes.write', 'quotes.send',
    'pos.use', 'pos.refund',
    'inventory.read', 'inventory.write', 'inventory.adjust',
    'work_orders.read', 'work_orders.write', 'work_orders.complete',
    'vehicles.read', 'vehicles.write',
    'routes.read', 'routes.write',
    'discounts.read', 'discounts.write',
    'reports.view',
  ],
  dispatcher: [
    'dashboard.view',
    'customers.read', 'customers.write',
    'appointments.read', 'appointments.write',
    'invoices.read',
    'quotes.read', 'quotes.write',
    'work_orders.read',
    'vehicles.read', 'vehicles.write',
    'routes.read', 'routes.write',
  ],
  driver: [
    'appointments.read',
    'customers.read',
    'routes.read', 'routes.drive',
  ],
  office: [
    'dashboard.view',
    'customers.read', 'customers.write',
    'appointments.read', 'appointments.write',
    'invoices.read', 'invoices.write', 'invoices.send',
    'quotes.read', 'quotes.write', 'quotes.send',
    'pos.use',
    'discounts.read', 'discounts.write',
    'reports.view',
  ],
}

// businesses.status CHECK enum.
export const BUSINESS_STATUSES = ['active', 'suspended', 'archived'] as const
export type BusinessStatus = typeof BUSINESS_STATUSES[number]

// business_users.status CHECK enum.
export const BUSINESS_USER_STATUSES = ['active', 'invited', 'revoked'] as const
export type BusinessUserStatus = typeof BUSINESS_USER_STATUSES[number]

// business_customers.customer_type CHECK enum.
export const BUSINESS_CUSTOMER_TYPES = ['individual', 'business'] as const
export type BusinessCustomerType = typeof BUSINESS_CUSTOMER_TYPES[number]
export const BUSINESS_CUSTOMER_TYPE_LABEL: Record<BusinessCustomerType, string> = {
  individual: 'Individual',
  business:   'Business',
}

// business_customers.status CHECK enum.
export const BUSINESS_CUSTOMER_STATUSES = ['active', 'archived'] as const
export type BusinessCustomerStatus = typeof BUSINESS_CUSTOMER_STATUSES[number]

// appointments.status CHECK enum (S459 / Phase 1a.2).
export const APPOINTMENT_STATUSES = [
  'scheduled',
  'completed',
  'cancelled',
  'no_show',
] as const
export type AppointmentStatus = typeof APPOINTMENT_STATUSES[number]
export const APPOINTMENT_STATUS_LABEL: Record<AppointmentStatus, string> = {
  scheduled: 'Scheduled',
  completed: 'Completed',
  cancelled: 'Cancelled',
  no_show:   'No-show',
}

// recurring_schedules.status CHECK enum (S460 / Phase 1a.2).
export const RECURRING_SCHEDULE_STATUSES = [
  'active',
  'paused',
  'ended',
] as const
export type RecurringScheduleStatus = typeof RECURRING_SCHEDULE_STATUSES[number]
export const RECURRING_SCHEDULE_STATUS_LABEL: Record<RecurringScheduleStatus, string> = {
  active: 'Active',
  paused: 'Paused',
  ended:  'Ended',
}

// business_recurring_invoice_schedules.frequency CHECK enum (S505 weekly/monthly;
// S511 added the month-stepped intervals). All non-weekly frequencies anchor to a
// day_of_month and differ only in how many months the cadence advances per cycle.
export const RECURRING_INVOICE_FREQUENCIES = [
  'weekly',
  'monthly',
  'quarterly',
  'semiannual',
  'annual',
] as const
export type RecurringInvoiceFrequency = typeof RECURRING_INVOICE_FREQUENCIES[number]
export const RECURRING_INVOICE_FREQUENCY_LABEL: Record<RecurringInvoiceFrequency, string> = {
  weekly:     'Weekly',
  monthly:    'Monthly',
  quarterly:  'Quarterly',
  semiannual: 'Every 6 months',
  annual:     'Yearly',
}
// Month-based frequencies advance the due date by this many months each cycle;
// 'weekly' is special-cased (+7 days) and is intentionally absent here.
export const RECURRING_INVOICE_MONTH_STEP: Record<
  Exclude<RecurringInvoiceFrequency, 'weekly'>, number
> = {
  monthly:    1,
  quarterly:  3,
  semiannual: 6,
  annual:     12,
}
// True for every frequency that anchors to a day_of_month (i.e. not weekly).
export function isMonthlyRecurrence(
  freq: RecurringInvoiceFrequency
): freq is Exclude<RecurringInvoiceFrequency, 'weekly'> {
  return freq !== 'weekly'
}

// business_invoices.deposit_type CHECK enum (S511, walkthrough Business #9).
// A bookkeeping label only — service vs materials deposits behave identically.
export const BUSINESS_DEPOSIT_TYPES = ['service', 'materials'] as const
export type BusinessDepositType = typeof BUSINESS_DEPOSIT_TYPES[number]
export const BUSINESS_DEPOSIT_TYPE_LABEL: Record<BusinessDepositType, string> = {
  service:   'Service',
  materials: 'Materials',
}

// Two-stage payment math for a business invoice with an optional upfront
// deposit. PURE — shared by the API (checkout amount + webhook status) and the
// frontend (what's due now). All amounts are dollars.
export interface InvoiceDueInput {
  totalAmount: number
  amountPaid: number
  depositAmount: number
}
export interface InvoiceDue {
  depositRemaining: number              // deposit not yet covered
  balanceRemaining: number              // total not yet covered
  amountDueNow: number                  // deposit portion first, then the balance
  nextPaymentKind: 'deposit' | 'balance' | 'none'
  depositPaid: boolean                  // deposit fully covered (true when there's no deposit)
  fullyPaid: boolean
}
export function computeInvoiceDue(i: InvoiceDueInput): InvoiceDue {
  const round2 = (n: number) => Math.round(n * 100) / 100
  const EPS = 0.005
  const balanceRemaining = round2(Math.max(0, i.totalAmount - i.amountPaid))
  const depositRemaining = round2(Math.max(0, i.depositAmount - i.amountPaid))
  const fullyPaid = balanceRemaining <= EPS
  const depositPaid = i.depositAmount <= EPS || i.amountPaid >= i.depositAmount - EPS
  let amountDueNow: number
  let nextPaymentKind: 'deposit' | 'balance' | 'none'
  if (fullyPaid) { amountDueNow = 0; nextPaymentKind = 'none' }
  else if (depositRemaining > EPS) { amountDueNow = depositRemaining; nextPaymentKind = 'deposit' }
  else { amountDueNow = balanceRemaining; nextPaymentKind = 'balance' }
  return { depositRemaining, balanceRemaining, amountDueNow, nextPaymentKind, depositPaid, fullyPaid }
}

// business_bookable_services.recurrence CHECK enum (S511, Business #8). Cadence a
// self-booking customer is enrolled into. Recurring services fix a day of week
// (owner-set) and create a recurring_schedule on booking; one_time books a single
// appointment.
export const BOOKABLE_SERVICE_RECURRENCES = ['one_time', 'weekly', 'biweekly', 'monthly'] as const
export type BookableServiceRecurrence = typeof BOOKABLE_SERVICE_RECURRENCES[number]
export const BOOKABLE_SERVICE_RECURRENCE_LABEL: Record<BookableServiceRecurrence, string> = {
  one_time: 'One-time',
  weekly:   'Weekly',
  biweekly: 'Every 2 weeks',
  monthly:  'Every 4 weeks',
}
// Display helper: turn a code-style service_type ('trash_pickup') into a human
// label ('Trash pickup'). Leaves already-spaced free text untouched. Shared so
// the appointments UI, the public booking page, and the ICS feed all agree.
export function humanizeServiceType(s: string): string {
  if (!s || s.includes(' ')) return s
  const spaced = s.replace(/[_-]+/g, ' ')
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

// S538 (Nic-locked): raw backend identifiers must NEVER render in a UI —
// no user ever sees 'rv_spot' or 'month_to_month'. Use the dedicated
// *_LABEL map when one exists (UNIT_TYPE_LABEL, BUSINESS_TYPE_LABEL, …);
// humanize() is the fallback for any enum-ish value without one
// ('rv_spot' → 'RV Spot', 'month_to_month' → 'Month To Month').
const HUMANIZE_ACRONYMS = new Set(['rv', 'ach', 'pos', 'csv', 'pdf', 'ein', 'llc', 'pm', 'str', 'po', 'nnn', 'id', 'ssn', 'eod', 'gam', 'otp'])
export function humanize(value: string | null | undefined): string {
  if (!value) return ''
  return String(value).split(/[_-]+/).map(w => {
    const lw = w.toLowerCase()
    if (HUMANIZE_ACRONYMS.has(lw)) return lw.toUpperCase()
    return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()
  }).join(' ')
}

// rrule BYDAY codes indexed by JS getDay() (0=Sun .. 6=Sat).
export const RRULE_WEEKDAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const
export const WEEKDAY_LABEL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
// Build the rrule for a recurring bookable service (null for one_time). Every
// recurring cadence is weekly-frequency on the owner's fixed weekday; biweekly
// and monthly just widen the interval (2 / 4 weeks) so "owner fixes the day" holds.
export function bookableServiceRrule(
  recurrence: BookableServiceRecurrence,
  dayOfWeek: number,
): string | null {
  if (recurrence === 'one_time') return null
  const interval = recurrence === 'weekly' ? 1 : recurrence === 'biweekly' ? 2 : 4
  const code = RRULE_WEEKDAY_CODES[dayOfWeek] ?? 'MO'
  return `FREQ=WEEKLY;INTERVAL=${interval};BYDAY=${code}`
}

// generated_routes.status enum (S462 / Phase 1a.3).
export const GENERATED_ROUTE_STATUSES = [
  'generated',
  'in_progress',
  'completed',
] as const
export type GeneratedRouteStatus = typeof GENERATED_ROUTE_STATUSES[number]

// route_stops.kind + .status (S462 / Phase 1a.3).
export const ROUTE_STOP_KINDS = ['customer', 'dump', 'depot_return'] as const
export type RouteStopKind = typeof ROUTE_STOP_KINDS[number]

export const ROUTE_STOP_STATUSES = ['planned', 'completed', 'skipped'] as const
export type RouteStopStatus = typeof ROUTE_STOP_STATUSES[number]

// ---------- Sub-permission catalog (per role) ----------
// S79: granular feature toggles WITHIN a role. Composes with the role's
// scope row (property_manager_scopes etc.) which controls property/unit
// binding. A new POS employee and a POS manager can both have the
// onsite_manager role + same property scope, but different sub-permissions
// (the manager has pos.refund / pos.void; the new employee does not).
//
// Storage: team_members.permissions jsonb. Shape: { "[permission_key]": true }.
// Absent key = denied. Backfill / dual-write into team_members on
// invitation accept is follow-up work — see DEFERRED.md item 8 sub-tasks.
//
// Route gating is NOT yet wired. Routes today gate on role only. Wiring
// per-route checks against these keys is its own dedicated session — see
// DEFERRED.md item 8 follow-up "Wire sub-permission gates into routes."
//
// Bookkeeper is intentionally absent: bookkeeper access is a single
// access_level toggle (read_only | read_write) on bookkeeper_scopes —
// see BOOKKEEPER_ACCESS_LEVELS. Bookkeepers operate at landlord scope
// (or property level), not within a property, so per-feature subdivision
// doesn't fit the role.
//
// This is a starter list. Add/edit on product walkthroughs.

// S236: dropped 3 orphan perms (`properties.archive`, `units.set_rent`,
// `payments.initiate_disbursement`) from the property_manager list.
// All three were toggleable in the TeamPage UI but didn't gate any
// backend route — the perm flipping ON had no effect, creating UX
// confusion. Audit found via grep across routes/. Either re-introduce
// (with their actual gating handler) or leave them out.
//
// Old jsonb scope rows that had any of these flags = TRUE keep the
// keys harmlessly; the auth middleware checks via OR and ignores
// keys not in the current shared list.
export const PROPERTY_MANAGER_SUB_PERMISSIONS = [
  'team.invite',
  'team.manage_permissions',
  'properties.create',
  'properties.edit',
  'units.create',
  'units.edit',
  'tenants.create',
  'tenants.run_background_check',
  'tenants.archive',
  'leases.create',
  'leases.sign',
  'leases.terminate',
  'payments.view_all',
  'maintenance.approve_above_threshold',
  'books.view',
  'books.edit',
  'notifications.send_bulk',
  'work_trade.view',
  'work_trade.manage',
  'work_trade.reconcile',
] as const
export type PropertyManagerSubPermission = typeof PROPERTY_MANAGER_SUB_PERMISSIONS[number]

export const ONSITE_MANAGER_SUB_PERMISSIONS = [
  'pos.ring_sale',
  'pos.refund',
  'pos.void',
  'pos.discount',
  'pos.end_of_day',
  'pos.manage_inventory',
  'guests.check_in',
  'guests.check_out',
  'units.view_status',
  'utility.read_meters',
] as const
export type OnsiteManagerSubPermission = typeof ONSITE_MANAGER_SUB_PERMISSIONS[number]

export const MAINTENANCE_SUB_PERMISSIONS = [
  'work_orders.create',
  'work_orders.complete',
  'work_orders.reassign',
  'purchases.request',
  'purchases.approve',
  'unit_access.view',
  'time.clock_in_out',
] as const
export type MaintenanceSubPermission = typeof MAINTENANCE_SUB_PERMISSIONS[number]

export type AnySubPermission =
  | PropertyManagerSubPermission
  | OnsiteManagerSubPermission
  | MaintenanceSubPermission

export const SUB_PERMISSIONS_BY_ROLE: Record<
  Exclude<LandlordAssignableRole, 'bookkeeper'>,
  readonly string[]
> = {
  property_manager: PROPERTY_MANAGER_SUB_PERMISSIONS,
  onsite_manager:   ONSITE_MANAGER_SUB_PERMISSIONS,
  maintenance:      MAINTENANCE_SUB_PERMISSIONS,
}

export const SUB_PERMISSION_LABEL: Record<AnySubPermission, string> = {
  // property_manager
  'team.invite':                       'Invite team members',
  'team.manage_permissions':           'Manage team permissions',
  'properties.create':                 'Create properties',
  'properties.edit':                   'Edit properties',
  'units.create':                      'Create units',
  'units.edit':                        'Edit units',
  'tenants.create':                    'Create tenants',
  'tenants.run_background_check':      'Run background checks',
  'tenants.archive':                   'Archive tenants',
  'leases.create':                     'Create leases',
  'leases.sign':                       'Sign leases',
  'leases.terminate':                  'Terminate leases',
  'payments.view_all':                 'View all payments',
  'maintenance.approve_above_threshold': 'Approve maintenance over threshold',
  'books.view':                        'View books',
  'books.edit':                        'Edit books',
  'notifications.send_bulk':           'Send bulk notifications',
  'work_trade.view':                   'View work-trade agreements',
  'work_trade.manage':                 'Create / update work-trade agreements',
  'work_trade.reconcile':              'Approve hours + reconcile periods',
  // onsite_manager
  'pos.ring_sale':                     'Ring sales',
  'pos.refund':                        'Issue refunds',
  'pos.void':                          'Void transactions',
  'pos.discount':                      'Apply discounts',
  'pos.end_of_day':                    'End-of-day close',
  'pos.manage_inventory':              'Manage inventory',
  'guests.check_in':                   'Check guests in',
  'guests.check_out':                  'Check guests out',
  'units.view_status':                 'View unit status',
  'utility.read_meters':               'Enter meter readings',
  // maintenance
  'work_orders.create':                'Create work orders',
  'work_orders.complete':              'Complete work orders',
  'work_orders.reassign':              'Reassign work orders',
  'purchases.request':                 'Request purchases',
  'purchases.approve':                 'Approve purchases',
  'unit_access.view':                  'View unit access codes',
  'time.clock_in_out':                 'Clock in/out',
}

// ---------- Permission catalog (modular per-user access) ----------
//
// The single source of truth for the per-user permissions page. Access is
// composed by toggling individual keys per staff user — there is no fixed
// role bundle. Each nav category is a group; within it, every independently-
// grantable surface (a tab, a table, an action) is one entry. Surfaces that
// only function together share ONE key rather than getting a key each.
//
// Consumers:
//   - The per-user permissions page renders these groups as toggle sections.
//   - Each page/route gates its surfaces on the same keys (owner roles bypass).
// Keys are stored in the scope row's `permissions` jsonb as { key: true }.
//
// This catalog grows category-by-category. POS is the fully-wired reference;
// append a group per category as each is enumerated + gated.
export interface PermissionItem {
  key: string
  label: string
  /** Optional one-liner shown under the toggle on the permissions page. */
  hint?: string
  /** Renders a "sensitive" badge on the permissions page. Still grantable —
   *  the owner decides — but visually flagged (financials, PII, money movement,
   *  third-party control). */
  sensitive?: boolean
}
export interface PermissionGroup {
  /** Stable category id (matches the nav section / page family). */
  category: string
  label: string
  /** Sub-sections keep large groups readable on the permissions page. */
  sections: { label: string; items: PermissionItem[] }[]
}

export const PERMISSION_CATALOG: PermissionGroup[] = [
  {
    category: 'pos', label: 'Point of Sale',
    sections: [
      { label: 'Tabs', items: [
        { key: 'pos.tab.register',   label: 'Register' },
        { key: 'pos.tab.history',    label: 'Sales history' },
        { key: 'pos.tab.items',      label: 'Items' },
        { key: 'pos.tab.categories', label: 'Categories' },
        { key: 'pos.tab.taxes',      label: 'Tax rates' },
        { key: 'pos.tab.discounts',  label: 'Discounts' },
        { key: 'pos.tab.vendors',    label: 'Vendors' },
        { key: 'pos.tab.orders',     label: 'Purchase orders' },
        { key: 'pos.tab.inventory',  label: 'Inventory log' },
        { key: 'pos.tab.readers',    label: 'Card readers' },
      ]},
      { label: 'Actions', items: [
        { key: 'pos.ring_sale',        label: 'Ring sales' },
        { key: 'pos.refund',           label: 'Issue refunds' },
        { key: 'pos.void',             label: 'Void transactions' },
        { key: 'pos.discount',         label: 'Apply discounts' },
        { key: 'pos.end_of_day',       label: 'End-of-day close' },
        { key: 'pos.manage_inventory', label: 'Create / edit items, tax, vendors' },
      ]},
    ],
  },
  {
    category: 'dashboard', label: 'Dashboard',
    sections: [{ label: 'Access', items: [
      { key: 'dashboard.view', label: 'View dashboard', sensitive: true, hint: 'portfolio-wide financials' },
    ]}],
  },
  {
    category: 'properties', label: 'Properties',
    sections: [{ label: 'Access & actions', items: [
      { key: 'properties.view',           label: 'View properties' },
      { key: 'properties.create',         label: 'Add property' },
      { key: 'properties.edit',           label: 'Edit property' },
      { key: 'properties.bulk_import',    label: 'Bulk import (CSV)' },
      { key: 'properties.add_unit',       label: 'Add unit' },
      { key: 'properties.assign_manager', label: 'Assign property manager' },
    ]}],
  },
  {
    category: 'units', label: 'Units',
    sections: [{ label: 'Access & actions', items: [
      { key: 'units.view',             label: 'View units' },
      { key: 'units.set_status',       label: 'Change unit status' },
      { key: 'units.manage_lifecycle', label: 'Unit lifecycle (available / vacant / activate)' },
      { key: 'units.edit_listing',     label: 'Edit listing fields' },
      { key: 'units.eviction_mode',    label: 'Eviction mode', sensitive: true, hint: 'blocks tenant ACH; legal' },
    ]}],
  },
  {
    category: 'schedule', label: 'Master Schedule',
    sections: [
      { label: 'Tabs', items: [
        { key: 'schedule.tab.timeline', label: 'Timeline' },
        { key: 'schedule.tab.list',     label: 'List' },
        { key: 'schedule.tab.units',    label: 'Units' },
        { key: 'schedule.tab.history',  label: 'History' },
      ]},
      { label: 'Actions', items: [
        { key: 'schedule.create_reservation', label: 'Create reservations' },
        { key: 'schedule.edit_reservation',   label: 'Edit / move / cancel reservations' },
        { key: 'schedule.configure_unit',     label: 'Configure unit (rates, type, amenities)' },
        { key: 'guest_access',                label: 'Guest stay links', hint: 'shared with Reservations' },
      ]},
    ],
  },
  {
    category: 'bookings', label: 'Reservations',
    sections: [{ label: 'Access & actions', items: [
      { key: 'bookings.view',                   label: 'View reservations' },
      { key: 'bookings.change_requests',        label: 'View guest change requests' },
      { key: 'bookings.acknowledge',            label: 'Acknowledge property rules' },
      { key: 'bookings.resolve_change_request', label: 'Approve / decline change requests' },
    ]}],
  },
  {
    category: 'booking_sites', label: 'Booking Sites',
    sections: [{ label: 'Access & actions', items: [
      { key: 'booking_sites.view', label: 'View booking-site config' },
      { key: 'booking_sites.edit', label: 'Edit & publish booking site', sensitive: true, hint: 'publishes a public site' },
    ]}],
  },
  {
    category: 'tenants', label: 'Tenants',
    sections: [{ label: 'Access & actions', items: [
      { key: 'tenants.view',          label: 'View tenants' },
      { key: 'tenants.invite',        label: 'Invite tenant' },
      { key: 'tenants.onboard',       label: 'Onboard existing tenant' },
      { key: 'tenants.transfer_unit', label: 'Transfer tenant unit' },
    ]}],
  },
  {
    category: 'tenant_onboarding', label: 'Tenant Onboarding',
    sections: [{ label: 'Access & actions', items: [
      { key: 'tenant_onboarding.view',           label: 'Onboarding & import flows' },
      { key: 'tenant_onboarding.pending_manage', label: 'Manage pending pool (builds leases)' },
    ]}],
  },
  {
    category: 'leases', label: 'Leases',
    sections: [{ label: 'Access & actions', items: [
      { key: 'leases.view',           label: 'View leases' },
      { key: 'leases.edit',           label: 'Edit / confirm leases' },
      { key: 'leases.view_pdf',       label: 'View lease PDF' },
      { key: 'leases.bill_fee',       label: 'Bill a fee' },
      { key: 'leases.deposit_return', label: 'Deposit return / move-out', sensitive: true, hint: 'moves deposit money' },
    ]}],
  },
  {
    category: 'subleases', label: 'Subleases',
    sections: [{ label: 'Access & actions', items: [
      { key: 'subleases.view',      label: 'View subleases' },
      { key: 'subleases.decide',    label: 'Approve / deny subleases' },
      { key: 'subleases.terminate', label: 'Terminate sublease' },
    ]}],
  },
  {
    category: 'esign', label: 'GoldSign',
    sections: [
      { label: 'Tabs', items: [
        { key: 'esign.tab.documents', label: 'Documents' },
        { key: 'esign.tab.templates', label: 'Templates' },
      ]},
      { label: 'Actions', items: [
        { key: 'esign.send',            label: 'Send documents' },
        { key: 'esign.void',            label: 'Void documents' },
        { key: 'esign.download',        label: 'Download signed PDFs' },
        { key: 'esign.template_manage', label: 'Create / edit templates' },
      ]},
    ],
  },
  {
    category: 'disbursements', label: 'Disbursements',
    sections: [{ label: 'Access & actions', items: [
      { key: 'disbursements.view',           label: 'View disbursements' },
      { key: 'disbursements.pm_impact_view',  label: 'View PM impact', sensitive: true, hint: 'PM fee economics' },
      // "withdraw now" is self-service (withdraws the caller's OWN balance) — not
      // a landlord-staff action, so not a catalog key.
    ]}],
  },
  {
    // NOTE: add-account / archive / Connect-onboarding are SELF-SERVICE routes
    // (each user manages their OWN account, incl. property_manager direct
    // deposit) — they are not landlord-staff actions, so they're intentionally
    // NOT catalog keys. Only page visibility is grantable.
    category: 'banking', label: 'Banking',
    sections: [{ label: 'Access', items: [
      { key: 'banking.view', label: 'View banking' },
    ]}],
  },
  {
    category: 'payments', label: 'Payments',
    sections: [{ label: 'Access & actions', items: [
      { key: 'payments.view',           label: 'View payments' },
      { key: 'payments.import_history', label: 'Import payment history' },
    ]}],
  },
  {
    category: 'balances', label: 'Outstanding Balances',
    sections: [{ label: 'Access', items: [
      { key: 'balances.view', label: 'View who owes + contact', hint: 'read-only: name, unit, amount owed, phone/email' },
    ]}],
  },
  {
    category: 'reports', label: 'Reports',
    sections: [
      { label: 'Reports', items: [
        { key: 'reports.tab.overview',  label: 'Overview' },
        { key: 'reports.tab.property',  label: 'By property' },
        { key: 'reports.tab.annual',    label: 'Annual & tax', sensitive: true, hint: 'tenant 1099 PII' },
        { key: 'reports.tab.statement', label: 'Owner statement' },
        // S603: the flexible report builder + T-12. Financial like the rest of
        // this category — a scoped staffer granted it still only ever sees their
        // assigned properties (the engine applies property scope server-side).
        { key: 'reports.tab.custom',    label: 'Custom & T-12' },
      ]},
      { label: 'Actions', items: [
        { key: 'reports.export', label: 'Export / print' },
      ]},
    ],
  },
  {
    category: 'maintenance', label: 'Maintenance',
    sections: [
      { label: 'Tabs', items: [
        { key: 'maintenance.tab.outages', label: 'Outages' },
      ]},
      { label: 'Access & actions', items: [
        { key: 'maintenance.view',       label: 'View work orders' },
        { key: 'maintenance.create',     label: 'Log request' },
        { key: 'maintenance.approve',    label: 'Approve / reject' },
        { key: 'maintenance.assign',     label: 'Assign worker' },
        { key: 'maintenance.update',     label: 'Update work order' },
        { key: 'maintenance.comment',    label: 'Add notes' },
        { key: 'maintenance.view_costs', label: 'View cost breakdown', sensitive: true, hint: 'financial roll-up' },
      ]},
    ],
  },
  {
    category: 'inspections', label: 'Inspections',
    sections: [{ label: 'Access & actions', items: [
      { key: 'inspections.view',   label: 'View inspections' },
      { key: 'inspections.create', label: 'Create inspection' },
      { key: 'inspections.manage', label: 'Manage / finalize inspections' },
    ]}],
  },
  {
    category: 'amenities', label: 'Amenities',
    sections: [{ label: 'Access & actions', items: [
      { key: 'amenities.view',                label: 'View common areas' },
      { key: 'amenities.manage_areas',        label: 'Manage areas' },
      { key: 'amenities.hold',                label: 'Place holds' },
      { key: 'amenities.review_reservations', label: 'Review reservations' },
    ]}],
  },
  {
    category: 'documents', label: 'Documents',
    sections: [{ label: 'Access', items: [
      { key: 'documents.view', label: 'View documents' },
      { key: 'documents.upload', label: 'Upload documents' },
    ]}],
  },
  {
    category: 'inventory', label: 'Inventory',
    sections: [{ label: 'Access', items: [
      { key: 'inventory.view', label: 'View inventory' },
    ]}],
  },
  {
    category: 'entry_requests', label: 'Entry Requests',
    sections: [{ label: 'Access & actions', items: [
      { key: 'entry_requests.view',   label: 'View entry requests' },
      { key: 'entry_requests.create', label: 'Create entry request' },
      { key: 'entry_requests.manage', label: 'Grant / deny / record entry' },
    ]}],
  },
  {
    category: 'applicant_pool', label: 'Applicant Pool',
    sections: [{ label: 'Access & actions', items: [
      { key: 'applicant_pool.view',      label: 'View applicant pool' },
      { key: 'applicant_pool.reach_out', label: 'Reach out to candidates' },
    ]}],
  },
  {
    category: 'background_checks', label: 'Background Checks',
    sections: [{ label: 'Access', items: [
      { key: 'background_checks.view', label: 'View background checks', sensitive: true, hint: 'applicant risk PII' },
    ]}],
  },
  {
    category: 'screening', label: 'Rental History',
    sections: [{ label: 'Access', items: [
      { key: 'screening.view', label: 'View rental history', sensitive: true, hint: 'cross-landlord behavioral PII' },
    ]}],
  },
  {
    category: 'pm_invitations', label: 'PM Invitations',
    sections: [{ label: 'Access & actions', items: [
      { key: 'pm_invitations.view',    label: 'View PM invitations' },
      { key: 'pm_invitations.send',    label: 'Send PM invitation', sensitive: true, hint: 'grants 3rd-party control + fee cut' },
      { key: 'pm_invitations.respond', label: 'Accept / reject PM invitation', sensitive: true, hint: 'grants 3rd-party control + fee cut' },
    ]}],
  },
  {
    category: 'settings', label: 'Settings',
    // settings.security (the owner's own login 2FA) is intentionally excluded —
    // it can't meaningfully apply to another user.
    sections: [{ label: 'Sections', items: [
      { key: 'settings.account_view',         label: 'Account info' },
      { key: 'settings.billing_view',         label: 'Billing info', sensitive: true },
      { key: 'settings.maintenance_approval', label: 'Maintenance approval threshold', sensitive: true, hint: 'controls spend that bypasses approval' },
      { key: 'settings.default_pm_company',   label: 'Default PM company', sensitive: true },
    ]}],
  },
  {
    category: 'notification_prefs', label: 'Notification Prefs',
    sections: [{ label: 'Access & actions', items: [
      { key: 'notification_prefs.view',           label: 'Notification preferences' },
      { key: 'notification_prefs.email_failures', label: 'Email delivery issues', sensitive: true, hint: 'exposes recipient emails' },
    ]}],
  },
]

/** Flat list of every catalog key — for validation / "grant all" helpers. */
export const ALL_CATALOG_PERMISSION_KEYS: string[] =
  PERMISSION_CATALOG.flatMap(g => g.sections.flatMap(s => s.items.map(i => i.key)))

// Presets = named bundles of catalog keys. NOT roles — a preset is a one-click
// convenience on the permissions page that flips its keys ON; the owner edits
// freely afterward. Each user stays fully custom.
export interface PermissionPreset {
  id: string
  label: string
  description: string
  keys: string[]
}
export const PERMISSION_PRESETS: PermissionPreset[] = [
  {
    id: 'front_desk',
    label: 'Front Desk',
    description: 'The occupancy picture + who owes: Reservations, Leases, Master Schedule, and Outstanding Balances (with contact info).',
    keys: [
      // Bookings ops now live as tabs inside Master Schedule (Reservations + Requests).
      'bookings.view', 'bookings.change_requests', 'bookings.resolve_change_request', 'bookings.acknowledge',
      'leases.view', 'leases.view_pdf',
      'schedule.tab.timeline', 'schedule.tab.list', 'schedule.tab.units', 'schedule.tab.history',
      'balances.view',
    ],
  },
]

// ---------- Maintenance job categories ----------

export const MAINTENANCE_JOB_CATEGORIES = [
  'general',
  'plumbing',
  'electrical',
  'hvac',
  'appliance',
  'landscape',
  'pest',
  'cleaning',
  'roofing',
  'structural',
  'pool',
  'locksmith',
] as const

export type MaintenanceJobCategory = typeof MAINTENANCE_JOB_CATEGORIES[number]

export const MAINTENANCE_JOB_CATEGORY_LABEL: Record<MaintenanceJobCategory, string> = {
  general:    'General',
  plumbing:   'Plumbing',
  electrical: 'Electrical',
  hvac:       'HVAC',
  appliance:  'Appliance',
  landscape:  'Landscape',
  pest:       'Pest Control',
  cleaning:   'Cleaning',
  roofing:    'Roofing',
  structural: 'Structural',
  pool:       'Pool & Spa',
  locksmith:  'Locksmith',
}

// ---------- Role scope tables ----------
// Every landlord-assignable role has a scope table that defines
// what the user can see for a specific landlord. A user with zero
// scope rows is a valid standalone account waiting to be hired.

export interface PropertyManagerScope {
  id:                        string
  userId:                    string
  landlordId:                string
  propertyIds:               string[]
  unitIds:                   string[]
  allProperties:             boolean
  maintApprovalCeilingCents: number | null
  createdAt:                 Date
  updatedAt:                 Date
}

export interface OnsiteManagerScope {
  id:          string
  userId:      string
  landlordId:  string
  propertyIds: string[]
  unitIds:     string[]
  createdAt:   Date
  updatedAt:   Date
}

export interface MaintenanceWorkerScope {
  id:            string
  userId:        string
  landlordId:    string
  propertyIds:   string[]
  unitIds:       string[]
  jobCategories: MaintenanceJobCategory[]
  allProperties: boolean
  createdAt:     Date
  updatedAt:     Date
}

export const BOOKKEEPER_ACCESS_LEVELS = ['read_only', 'read_write'] as const
export type BookkeeperAccessLevel = typeof BOOKKEEPER_ACCESS_LEVELS[number]

export interface BookkeeperScope {
  id:          string
  userId:      string
  landlordId:  string
  accessLevel: BookkeeperAccessLevel
  createdAt:   Date
  updatedAt:   Date
}

// ── INVITATIONS & PLATFORM EVENTS ──────────────────────────
// The platform-wide audit trail. Every meaningful state change
// across every domain writes one row to `platform_events`. The
// future reputation / blockchain layer consumes this table — do
// not treat it as a debug log. Keep the CHECK constraints and
// the arrays below in lockstep.

// Invitation lifecycle status.
// Single source of truth for invitations.status CHECK constraint.
export const INVITATION_STATUSES = ['pending', 'accepted', 'expired', 'revoked'] as const
export type InvitationStatus = typeof INVITATION_STATUSES[number]
export const INVITATION_STATUS_LABEL: Record<InvitationStatus, string> = {
  pending:  'Pending',
  accepted: 'Accepted',
  expired:  'Expired',
  revoked:  'Revoked',
}

// Platform event subject types. Grows as new domains are added.
// Single source of truth for platform_events.subject_type CHECK.
export const PLATFORM_SUBJECT_TYPES = ['invitation'] as const
export type PlatformSubjectType = typeof PLATFORM_SUBJECT_TYPES[number]

// Platform event types — dot-namespaced so categories stay organized
// as the list grows.
// Single source of truth for platform_events.event_type CHECK.
export const PLATFORM_EVENT_TYPES = [
  'invitation.created',
  'invitation.resent',
  'invitation.viewed',
  'invitation.accepted',
  'invitation.expired',
  'invitation.revoked',
] as const
export type PlatformEventType = typeof PLATFORM_EVENT_TYPES[number]

// ---------- Scope payload shapes ----------
// These ride on invitations.scope_payload (jsonb) and expand into
// the matching scope-table row at acceptance time. id/userId/landlordId
// /timestamps are filled in at insert, not carried on the payload.

export interface PropertyManagerScopePayload {
  propertyIds:               string[]
  unitIds:                   string[]
  allProperties:             boolean
  maintApprovalCeilingCents: number | null
}

export interface OnsiteManagerScopePayload {
  propertyIds: string[]
  unitIds:     string[]
}

export interface MaintenanceWorkerScopePayload {
  propertyIds:   string[]
  unitIds:       string[]
  jobCategories: MaintenanceJobCategory[]
  allProperties: boolean
}

export interface BookkeeperScopePayload {
  accessLevel: BookkeeperAccessLevel
}

export type LandlordAssignableScopePayload =
  | PropertyManagerScopePayload
  | OnsiteManagerScopePayload
  | MaintenanceWorkerScopePayload
  | BookkeeperScopePayload

// ---------- Invitation & PlatformEvent interfaces ----------

export interface Invitation {
  id:              string
  email:           string
  landlordId:      string
  role:            LandlordAssignableRole
  scopePayload:    LandlordAssignableScopePayload
  invitedByUserId: string
  status:          InvitationStatus
  token:           string
  expiresAt:       Date
  acceptedAt:      Date | null
  acceptedUserId:  string | null
  revokedAt:       Date | null
  revokedByUserId: string | null
  createdAt:       Date
}

export interface PlatformEvent {
  id:          string
  subjectType: PlatformSubjectType
  subjectId:   string
  eventType:   PlatformEventType
  actorUserId: string | null
  payload:     Record<string, unknown>
  createdAt:   Date
}

export const ROLE_PERMISSIONS: Record<string, string[]> = {
  admin:            ['*'],
  landlord:         ['dashboard','units','properties','tenants','payments','disbursements','maintenance','documents','leases','pos','team','settings'],
  property_manager: ['dashboard','units','properties','tenants','payments','maintenance','documents','leases','pos'],
  onsite_manager:   ['pos','units','maintenance'],
  maintenance:      ['maintenance'],
  tenant:           ['home','payments','maintenance','documents','services'],
  bookkeeper:       ['books'],
  super_admin:      ['*'],
}

// Unit status values.
// Single source of truth for units.status CHECK constraint.
// direct_pay retired W-15/S531 (migration 20260704150000) — off-platform
// payment isn't a unit state GAM tracks; rows were merged into 'active'.
// S604 'owner_use' (Nic): a unit the OWNER occupies — their own home, a
// manager's residence, a model unit. It has NO lease and collects NO rent, so
// it is deliberately excluded from every revenue-shaped surface. It is NOT
// vacant (it cannot be rented or booked) so it counts as occupied for
// occupancy/availability purposes.
//
// The anti-cheat is structural, not a rule: because owner_use carries no lease,
// the $2/occupied-unit platform fee — which bills DISTINCT UNITS WITH AN ACTIVE
// LEASE (jobs/platformFeeAccrual.ts) — never charges it. A landlord cannot use
// the status to dodge the fee on a real tenant, because a unit with no lease
// also cannot collect rent through GAM.
export const UNIT_STATUSES = ['vacant', 'available', 'active', 'delinquent', 'suspended', 'owner_use'] as const
export type UnitStatus = typeof UNIT_STATUSES[number]
export const UNIT_STATUS_LABEL: Record<UnitStatus, string> = {
  vacant:     'Vacant',
  available:  'Available',
  active:     'Active',
  delinquent: 'Delinquent',
  suspended:  'Suspended',
  owner_use:  'Owner Use',
}

// Statuses that occupy a unit without producing rent. Excluded from
// revenue-shaped aggregates (expected rent, rep commission) while still
// counting as occupied for occupancy/vacancy. Anything reading
// `status <> 'vacant'` to mean "earning" must subtract these.
export const NON_REVENUE_OCCUPIED_STATUSES = ['owner_use'] as const

// Unit type values.
// Single source of truth for units.unit_type CHECK constraint.
// S538: hotel_room added (Nic) — small hotel/motel operators are a target
// market (Oak Park Motel is customer #1); their short-stays bill the 5%
// STR fee like every non-RV type (maps to the Airbnb-competitor pricing).
// S577: parking, boat_slip, land_lot added (Nic) — "accommodate any space
// people rent to other people." parking splits OUT of storage (self-storage
// stays 'storage'); both are short-stay-locked. boat_slip = wet slips/moorings
// at a marina/pier (an aquatic RV spot). land_lot = raw land / a leased lot
// beyond the mobile-home lot-rent case. Short-term / vacation rentals are NOT
// a unit type — they're a short-stay BOOKING on any existing unit (Nic S577).
// S577: campsite added (Nic) — tent / primitive campground site (no hookups),
// distinct from an RV site. Bookable like an RV spot. (Cabins are NOT a type —
// a cabin is a dwelling; landlords name it as a subtype.)
export const UNIT_TYPES = ['apartment', 'single_family', 'rv_spot', 'campsite', 'mobile_home', 'hotel_room', 'storage', 'parking', 'boat_slip', 'land_lot', 'commercial'] as const
export type UnitType = typeof UNIT_TYPES[number]
export const UNIT_TYPE_LABEL: Record<UnitType, string> = {
  apartment:     'Apartment',
  single_family: 'Single Family Home',
  rv_spot:       'RV Spot',
  campsite:      'Campsite / Tent Site',
  mobile_home:   'Mobile Home',
  hotel_room:    'Hotel / Motel Room',
  storage:       'Storage',
  parking:       'Parking / Vehicle Space',
  boat_slip:     'Boat Slip / Marina',
  land_lot:      'Land / Lot',
  commercial:    'Commercial',
}
export const UNIT_TYPE_PREFIX: Record<UnitType, string> = {
  apartment:     'APT',
  single_family: 'SFH',
  rv_spot:       'RV',
  campsite:      'CMP',
  mobile_home:   'MH',
  hotel_room:    'RM',
  storage:       'STG',
  // S605 (Nic): was PKG, which reads as "package". STALL is the industry term
  // for an individual parking space (garages, apartment complexes) and can't be
  // misread — and it matches SLIP: both are full words for one bounded space.
  parking:       'STALL',
  boat_slip:     'SLIP',
  land_lot:      'LOT',
  commercial:    'COM',
}
export const UNIT_TYPE_ICON: Record<UnitType, string> = {
  apartment:     '🏢',
  single_family: '🏠',
  rv_spot:       '🚐',
  campsite:      '⛺',
  mobile_home:   '🏡',
  hotel_room:    '🛏️',
  storage:       '📦',
  parking:       '🅿️',
  boat_slip:     '⛵',
  land_lot:      '🌾',
  commercial:    '🏪',
}
// Platform-fee rule (Nic-locked; S538 + S577). The fee is by PRODUCT / SERVICE
// LEVEL (S577 basis decision), so like products pay alike:
//   • Occupied monthly (lease / month-to-month), ANY type → $2 per occupied
//     unit / month (min $10/property). Vacant = $0.
//   • BARE LODGING SITES (rv_spot, campsite, boat_slip) → short stays aggregate
//     at $2 x CEIL(nights/30) (the monthly $2 prorated). A bare site costs ~$2/
//     space/month however it's rented, so an RV park, campground, and marina are
//     priced identically and there's no monthly-vs-nightly arbitrage.
//   • FURNISHED / SERVICED LODGING (apartment, single_family, mobile_home,
//     hotel_room) → 5% of booking revenue short-term (the Airbnb-competitor
//     lane, higher value + more GAM does). A motel room is FURNISHED, not a bare
//     site → 5%, same category as a cabin/apartment STR (Nic S577). The gap vs
//     monthly $2 is intentional and guarded by the auto-lease-at-threshold rule.
//   • NON-LODGING space (parking, land_lot, commercial) → monthly $2; the rare
//     short-term booking bills 5% (5% never gouges cheap space, whereas a $2/30
//     minimum would — e.g. 25¢ on a $5 parking day). Truly hourly casual space
//     (parking-by-the-hour, dump/laundry) rides the self-service QR pay page
//     later, not this engine. storage is never short-term bookable.
// Consumed by jobs/platformFeeAccrual.ts and services/platformFee.ts.
export const NIGHTS_AGGREGATION_UNIT_TYPES = ['rv_spot', 'campsite', 'boat_slip'] as const
// S538 (Nic-locked): storage units can NEVER be short-term bookable — no
// nightly/weekly bookings, no public booking page, no subtype override.
// Enforced at unit create (allow-list), unit type config (isBookable),
// manual reservation create, and the public bookStay flow. (S577: parking is
// NOT locked — it's bookable by the day at 5%, or rented monthly at $2/unit.)
export const SHORT_STAY_LOCKED_UNIT_TYPES = ['storage'] as const

/**
 * S616 (Nic) — which stay lengths each unit type may be rented for.
 *
 * "I don't know where you're getting the twenty nine out of thirty... that's
 *  completely false. The apartment doesn't allow that, and all eight mobile home
 *  spaces do not allow that. So we need to check something. If you're thinking
 *  that it's set up that way, then we need to adjust the onboarding flow."
 *
 * He was right and the data proved it: all eight of Oak Park's mobile home
 * spaces were configured for nightly and weekly stays, which nobody asked for.
 *
 * THE CAUSE was two different rules for one question, in one file. Creating a
 * unit said "nightly/weekly unless the type is short-stay-locked", and only
 * STORAGE is locked — so a mobile home, an apartment, a single-family house and
 * a commercial space all came out bookable by the night. Editing a unit's type
 * said the opposite: consult a matrix, and anything not listed falls back to
 * long-term only. The two disagreed for every type in neither list, and which
 * value a unit ended up with depended on which screen last touched it.
 *
 * This is the single answer both paths now use. Types are the real UnitType
 * values — the old matrix was keyed on 'residential' and 'short_term_cabin',
 * neither of which is a unit type the database accepts, so those keys could
 * only ever be reached as a fallback.
 */
export const LEASE_TYPES_BY_UNIT_TYPE: Record<UnitType, string[]> = {
  // A home is a home. You do not rent a mobile home space or an apartment by
  // the night, and the eight spaces that said otherwise were an accident.
  apartment:     ['month_to_month', 'long_term'],
  single_family: ['month_to_month', 'long_term'],
  mobile_home:   ['month_to_month', 'long_term'],
  commercial:    ['month_to_month', 'long_term'],
  // Storage is short-stay LOCKED (S538) — its allow-list never carries nightly.
  storage:       ['month_to_month', 'long_term'],
  // Sites and spots: rented by the night, the week, or the month.
  rv_spot:       ['nightly', 'weekly', 'month_to_month', 'long_term'],
  campsite:      ['nightly', 'weekly', 'month_to_month', 'long_term'],
  // S538: weekly-rate motels and long-term room tenants are both real —
  // Oak Park has the second kind.
  hotel_room:    ['nightly', 'weekly', 'month_to_month', 'long_term'],
  // S577: daily bookings bill 5%, a monthly rental bills $2/unit.
  parking:       ['nightly', 'weekly', 'month_to_month', 'long_term'],
  boat_slip:     ['nightly', 'weekly', 'month_to_month', 'long_term'],
  // S577: land short-term = event/vendor space.
  land_lot:      ['nightly', 'weekly', 'month_to_month', 'long_term'],
}

/**
 * Unit types that are short-stay by nature — somebody arrives with their own
 * rig, or the room IS the stay. These carry nightly and weekly without anyone
 * turning anything on.
 *
 * Everything else is somewhere a person LIVES, and Nic is explicit that the
 * long-term case is the norm: "Short term stays is not gonna be the bulk of the
 * people using this software. So they have to manually select that. It should
 * never be on by default."
 */
export const SHORT_STAY_BY_NATURE_UNIT_TYPES: readonly UnitType[] = [
  'rv_spot', 'campsite', 'hotel_room',
  // S577 (unchanged): parking, boat slips and land lots are rented by the day
  // as well as the month — a day's parking, a visiting boat, an event lot.
  'parking', 'boat_slip', 'land_lot',
] as const

/**
 * The allowed stay lengths for a unit, given its type and whether the operator
 * has turned short stays ON for it.
 *
 * S616 (Nic): a home-shaped unit — mobile home, apartment, house, commercial —
 * is long-term only until an operator deliberately opts it in. A landlord CAN
 * short-stay their single-family house; they just have to say so, which is what
 * is_bookable has meant since S538 ("is_bookable IS the short-stay gate").
 *
 * Storage never gains nightly or weekly whatever the toggle says. Nic: "storage
 * should not be short term, nightly, whatever. It's by the month lease."
 *
 * An unknown type gets the conservative answer, never the permissive one.
 */
export function leaseTypesForUnitType(
  unitType: string, shortTermEnabled = false,
): string[] {
  const base = LEASE_TYPES_BY_UNIT_TYPE[unitType as UnitType]
    ?? ['month_to_month', 'long_term']
  if ((SHORT_STAY_LOCKED_UNIT_TYPES as readonly string[]).includes(unitType)) {
    return ['month_to_month', 'long_term']
  }
  if (base.includes('nightly')) return base          // short-stay by nature
  if (!shortTermEnabled) return base                 // a home, left as a home
  return ['nightly', 'weekly', ...base]              // opted in by the operator
}

/** Does this type get short stays without anyone asking for them? */
export function isShortStayByNature(unitType: string): boolean {
  return (SHORT_STAY_BY_NATURE_UNIT_TYPES as readonly string[]).includes(unitType)
}
// Whether this unit type conceptually has bedrooms (affects UI rendering).
export const UNIT_TYPE_HAS_BEDROOMS: Record<UnitType, boolean> = {
  apartment:     true,
  single_family: true,
  rv_spot:       false,
  campsite:      false,
  mobile_home:   true,
  hotel_room:    false,
  storage:       false,
  parking:       false,
  boat_slip:     false,
  land_lot:      false,
  commercial:    false,
}

// ---------- Landlord-issued tenant account credits (S577 — Nic) ----------
// A landlord issues a credit to a tenant for any reason; it's applied to the
// tenant's next rent invoice (funded by the landlord = less rent received).
// Single source of truth for the tenant_credits.category CHECK.
export const TENANT_CREDIT_CATEGORIES = ['screening_cap', 'late_fee_refund', 'overcharge', 'goodwill', 'other'] as const
export type TenantCreditCategory = typeof TENANT_CREDIT_CATEGORIES[number]
export const TENANT_CREDIT_CATEGORY_LABEL: Record<TenantCreditCategory, string> = {
  screening_cap:   'Screening fee (state cap)',
  late_fee_refund: 'Late fee refund',
  overcharge:      'Overcharge correction',
  goodwill:        'Goodwill',
  other:           'Other',
}

// ---------- Property-scoped tenant surveys (S577 — Nic) ----------
// A landlord-authored, Google-Forms-style questionnaire sent to the tenants of
// ONE property. Responses are never mixed across properties; "same survey at
// another property" is a COPY. Question types are intentionally minimal.
// Single source of truth for the survey CHECK constraints.
export const SURVEY_QUESTION_TYPES = ['multiple_choice', 'text'] as const
export type SurveyQuestionType = typeof SURVEY_QUESTION_TYPES[number]
export const SURVEY_QUESTION_TYPE_LABEL: Record<SurveyQuestionType, string> = {
  multiple_choice: 'Multiple choice',
  text:            'Written answer',
}
export const SURVEY_STATUSES = ['draft', 'sent', 'closed'] as const
export type SurveyStatus = typeof SURVEY_STATUSES[number]
export const SURVEY_STATUS_LABEL: Record<SurveyStatus, string> = {
  draft:  'Draft',
  sent:   'Sent',
  closed: 'Closed',
}

// ---------- Owner-defined unit subtypes (S527 — replaces S526 subtype_key model) ----------
// property_unit_subtypes rows: a subtype is the OWNER's own named class of
// unit on a property ("Studio", "Riverfront pull-through", "10x10") carrying
// the type-relevant facts plus creation-time pricing. Blank per landlord
// until they add them — nothing pre-baked. Add Unit picks one and prefills;
// the unit stores its own copy (unit copy stays authoritative).
export interface PropertyUnitSubtype {
  id?: string
  propertyId?: string
  unitType: UnitType
  name: string
  bedrooms?: number | null
  bathrooms?: number | string | null
  rvSiteLayout?: string | null
  rvAmpService?: string | null
  dwellingOwnership?: string | null
  storageSize?: string | null
  rentAmount: number | string | null
  securityDeposit: number | string | null
  nightlyRate: number | string | null
  weeklyRate: number | string | null
  monthlyRate: number | string | null
  /** S613: how many live units carry this subtype (read-only, from the list). */
  unitCount?: number
}

// Human summary of a subtype's facts for chips/rows, e.g.
// "Pull-through · 50 amp", "2 bed · 1 bath", "10x10". Empty when no facts.
export function unitSubtypeFactsLabel(s: PropertyUnitSubtype): string {
  const parts: string[] = []
  if (s.bedrooms != null) parts.push(s.bedrooms === 0 ? 'Studio' : `${s.bedrooms} bed`)
  if (s.bathrooms != null && s.bathrooms !== '') parts.push(`${s.bathrooms} bath`)
  if (s.rvSiteLayout && s.rvSiteLayout !== 'none') parts.push(s.rvSiteLayout === 'pull_through' ? 'Pull-through' : 'Back-in')
  if (s.rvAmpService && s.rvAmpService !== 'none') parts.push(s.rvAmpService === 'both' ? '30/50 amp' : `${s.rvAmpService} amp`)
  if (s.storageSize?.trim()) parts.push(s.storageSize.trim())
  return parts.join(' · ')
}

// S613 (Nic): a NAME suggested from the facts the landlord just picked.
//
// He built "Back In" as a 50-amp back-in, then "Back In" as a 30-amp back-in,
// and the second silently overwrote the first — he was naming the CLASS and
// letting the dropdowns carry the variation, which is a perfectly reasonable
// way to think and which the name-keyed model cannot hold. Two subtypes need
// two names, so the form fills the name in from the facts as they are chosen
// (still free to overtype). "Back-in 50 amp" and "Back-in 30 amp" then happen
// by default instead of by warning.
export function suggestUnitSubtypeName(s: PropertyUnitSubtype): string {
  const facts = unitSubtypeFactsLabel(s).replace(/ · /g, ' ')
  return facts.trim()
}

// Single source of truth for units.rv_site_layout / unit_bookings.required_site_layout
// CHECK constraints. RV sites differ by how a rig pulls in: a pull-through lets
// you drive straight through (no reversing, easy for big rigs/trailers), a
// back-in requires reversing. 'none' = not an RV site / no preference. A
// reservation can require a specific layout; staff are WARNED (not blocked) when
// a move/edit would put it on a mismatched site (Nic 2026-06-27).
export const RV_SITE_LAYOUTS = ['none', 'back_in', 'pull_through'] as const
export type RvSiteLayout = typeof RV_SITE_LAYOUTS[number]
export const RV_SITE_LAYOUT_LABEL: Record<RvSiteLayout, string> = {
  none:         'Not specified',
  back_in:      'Back-in',
  pull_through: 'Pull-through',
}
/** True when a required layout is set and the target site's layout doesn't match.
 *  'none' on either side is treated as "no constraint" → never a mismatch. */
export function isSiteLayoutMismatch(required: string | null | undefined, actual: string | null | undefined): boolean {
  if (!required || required === 'none') return false
  if (!actual || actual === 'none') return true
  return required !== actual
}

// Single source of truth for units.rv_amp_service / unit_bookings.required_amp_service
// CHECK constraints. RV electrical pedestals provide 30-amp service, 50-amp
// service, or BOTH simultaneously. A rig needs a specific amperage; a 50-amp rig
// can't draw from a 30-amp-only pedestal (and vice versa). Owner sets the unit's
// service; a reservation can require an amperage; staff are WARNED (not blocked)
// on a mismatched move/edit (same posture as site layout — Nic 2026-06-27).
// 'none' = not an RV site / unspecified. 'both' on the UNIT satisfies either.
export const RV_AMP_SERVICES = ['none', '30', '50', 'both'] as const
export type RvAmpService = typeof RV_AMP_SERVICES[number]
export const RV_AMP_SERVICE_LABEL: Record<RvAmpService, string> = {
  none: 'Not specified',
  '30': '30 amp',
  '50': '50 amp',
  both: '30 & 50 amp',
}
/** True when a required amperage is set and the unit can't supply it.
 *  A unit set to 'both' supplies either; 'none'/unset on the unit can't be
 *  guaranteed → mismatch. 'none' required = no constraint → never a mismatch. */
export function isAmpServiceMismatch(required: string | null | undefined, actual: string | null | undefined): boolean {
  if (!required || required === 'none') return false
  if (actual === 'both') return false
  if (!actual || actual === 'none') return true
  return required !== actual
}

export enum PropertyType {
  RESIDENTIAL  = 'residential',
  RV_LONGTERM  = 'rv_longterm',   // 3+ months — On-Time Pay active
  RV_WEEKLY    = 'rv_weekly',     // weekly billing, monthly batch payout
  RV_NIGHTLY   = 'rv_nightly',   // nightly card, weekly batch payout
}

// Lease status values.
// Single source of truth for leases_status_check CHECK constraint (4 values).
export const LEASE_STATUSES = ['pending', 'active', 'expired', 'terminated'] as const
export type LeaseStatus = typeof LEASE_STATUSES[number]
export const LEASE_STATUS_LABEL: Record<LeaseStatus, string> = {
  pending:    'Pending',
  active:     'Active',
  expired:    'Expired',
  terminated: 'Terminated',
}

// S75: PaymentStatus moved to const+type pattern below alongside other
// payment-flow enums (PAYMENT_STATUSES at the S26a Invoice block).
// The pre-S75 TypeScript `enum PaymentStatus` had zero consumers.

export enum AchReturnCode {
  R01 = 'R01', // Insufficient funds
  R02 = 'R02', // Account closed
  R05 = 'R05', // Unauthorized — zero tolerance
  R07 = 'R07', // Authorization revoked — zero tolerance
  R10 = 'R10', // Customer advises not authorized — zero tolerance
  R29 = 'R29', // Corporate customer advises not authorized — zero tolerance
}

// Maintenance request status.
// Single source of truth for maintenance_requests_status_check (6 values).
// 'awaiting_approval' is set automatically when an estimate exceeds the
// landlord's configured approval threshold (see maintenance.ts PATCH logic).
export const MAINTENANCE_STATUSES = ['open', 'awaiting_approval', 'assigned', 'in_progress', 'completed', 'cancelled'] as const
export type MaintenanceStatus = typeof MAINTENANCE_STATUSES[number]
export const MAINTENANCE_STATUS_LABEL: Record<MaintenanceStatus, string> = {
  open:              'Open',
  awaiting_approval: 'Awaiting Approval',
  assigned:          'Assigned',
  in_progress:       'In Progress',
  completed:         'Completed',
  cancelled:         'Cancelled',
}

// Maintenance request priority.
// Single source of truth for maintenance_requests_priority_check (4 values).
export const MAINTENANCE_PRIORITIES = ['emergency', 'high', 'normal', 'low'] as const
export type MaintenancePriority = typeof MAINTENANCE_PRIORITIES[number]

// S76: maintenance request category. Matches maintenance_requests_category_check.
export const MAINTENANCE_CATEGORIES = [
  'general', 'plumbing', 'electrical', 'hvac', 'appliance', 'landscape',
  'pest', 'cleaning', 'roofing', 'structural', 'pool', 'locksmith',
] as const
export type MaintenanceCategory = typeof MAINTENANCE_CATEGORIES[number]
// S571: tenant-facing category labels (no-raw-enums rule). The tenant picks a
// category instead of typing a free-text title; the title is derived from this.
export const MAINTENANCE_CATEGORY_LABEL: Record<MaintenanceCategory, string> = {
  general:    'General / Other',
  plumbing:   'Plumbing',
  electrical: 'Electrical',
  hvac:       'Heating & Cooling',
  appliance:  'Appliance',
  landscape:  'Landscaping / Grounds',
  pest:       'Pest Control',
  cleaning:   'Cleaning',
  roofing:    'Roof / Ceiling',
  structural: 'Structural',
  pool:       'Pool / Spa',
  locksmith:  'Locks & Keys',
}
export const MAINTENANCE_PRIORITY_LABEL: Record<MaintenancePriority, string> = {
  emergency: 'Emergency',
  high:      'High',
  normal:    'Normal',
  low:       'Low',
}

export enum DepositStatus {
  PENDING    = 'pending',     // FlexDeposit installments in progress
  FUNDED     = 'funded',      // Fully funded
  PARTIAL    = 'partial',     // Installment defaulted — partially funded
  DISBURSED  = 'disbursed',   // Returned at move-out
  CLAIMED    = 'claimed',     // Applied to damages
}

// Document categories on the legacy `documents` table.
// Single source of truth for documents.type CHECK constraint.
// Pattern: as-const array + derived union + Record<T,...> label map.
// Adding a value: edit the array, compiler forces the label map update.
export const DOCUMENT_CATEGORIES = ['lease', 'addendum', 'move_in_checklist', 'move_out_checklist', 'notice', 'receipt', 'other'] as const
export type DocumentCategory = typeof DOCUMENT_CATEGORIES[number]
export const DOCUMENT_CATEGORY_LABEL: Record<DocumentCategory, string> = {
  lease:              'Lease',
  addendum:           'Addendum',
  move_in_checklist:  'Move-In Checklist',
  move_out_checklist: 'Move-Out Checklist',
  notice:             'Notice',
  receipt:            'Receipt',
  other:              'Other',
}

// Lease document types on the `lease_documents` table (e-sign dispatcher).
// Single source of truth for lease_documents.document_type CHECK constraint.
// S568 (Nic): STANDALONE (non-lease) e-sign documents — the generic e-sign
// engine. These bind to no lease/unit (lease_id/unit_id NULL); signers + roles
// are arbitrary. Purchase agreements for financed home sales, resident-to-
// resident sales (landlord not a party — just facilitating), business quotes/
// bids. They share the lease_documents table + signing/token flow.
export const STANDALONE_DOCUMENT_TYPES = ['purchase_agreement', 'bill_of_sale', 'general_contract'] as const
export type StandaloneDocumentType = typeof STANDALONE_DOCUMENT_TYPES[number]

// S576 (B-8): document types whose e-sign completion produces NO lease record —
// the signed PDF itself is the legal instrument. The completion path must SKIP
// buildLeaseFromDocument for these, mark the document `completed`, and still
// stamp the executed PDF. Members: the standalone contract types (bind to no
// lease/unit at all) + 'work_trade_addendum' (rides a lease send but mutates no
// lease on its own — its signed PDF is the addendum). Adding a value here that
// buildLeaseFromDocument's switch does not handle is exactly what this set
// guards against — a fully-signed doc landing in execution_failed.
export const NO_LEASE_DOCUMENT_TYPES = [...STANDALONE_DOCUMENT_TYPES, 'work_trade_addendum'] as const
export type NoLeaseDocumentType = typeof NO_LEASE_DOCUMENT_TYPES[number]

// S576 (B-8): a lease template's purpose. 'lease' = a normal lease form used
// for original leases + renewals. 'work_trade_addendum' = the landlord's own
// work-trade addendum form, auto-attached to a renewal when a paused work-trade
// agreement needs a fresh tenancy. Landlords bring their own forms (Nic).
export const LEASE_TEMPLATE_PURPOSES = ['lease', 'work_trade_addendum'] as const
export type LeaseTemplatePurpose = typeof LEASE_TEMPLATE_PURPOSES[number]
export const LEASE_TEMPLATE_PURPOSE_LABEL: Record<LeaseTemplatePurpose, string> = {
  lease:               'Lease',
  work_trade_addendum: 'Work-Trade Addendum',
}

export const LEASE_DOCUMENT_TYPES = ['original_lease', 'addendum_add', 'addendum_remove', 'addendum_terms', 'sublease_agreement',
  ...STANDALONE_DOCUMENT_TYPES, 'work_trade_addendum'] as const
export type LeaseDocumentType = typeof LEASE_DOCUMENT_TYPES[number]
export const LEASE_DOCUMENT_TYPE_LABEL: Record<LeaseDocumentType, string> = {
  original_lease:      'Original Lease',
  addendum_add:        'Add Tenant',
  addendum_remove:     'Remove Tenant',
  addendum_terms:      'Change Lease Terms',
  sublease_agreement:  'Sublease Agreement',
  purchase_agreement:  'Purchase Agreement',
  bill_of_sale:        'Bill of Sale',
  general_contract:    'Contract',
  work_trade_addendum: 'Work-Trade Addendum',
}

// Generic signer roles for standalone documents. The e-sign engine matches a
// template field's signer_role to a document signer's role, so ANY consistent
// role string works — these are the common presets (+ labels for the UI). Lease
// documents keep using landlord / witness / tenant roles.
export const GENERIC_SIGNER_ROLES = ['seller', 'purchaser', 'party_1', 'party_2', 'witness'] as const
export type GenericSignerRole = typeof GENERIC_SIGNER_ROLES[number]
export const GENERIC_SIGNER_ROLE_LABEL: Record<GenericSignerRole, string> = {
  seller:    'Seller',
  purchaser: 'Purchaser',
  party_1:   'Party 1',
  party_2:   'Party 2',
  witness:   'Witness',
}
// A signer role is valid if it's a known lease role, a generic role, or a sane
// custom label (letters/digits/underscore/space, ≤40 chars) — the generic engine
// allows arbitrary parties without an enum migration.
export function isValidSignerRole(role: string): boolean {
  if (!role || role.length > 40) return false
  return /^[a-z0-9_][a-z0-9_ ]*$/i.test(role)
}

// S212: addendum diff display constants — shared by tenant LeasePage
// (S210), landlord LeaseFormModal (S211), and the API addendum PDF
// generator (S212+). Keeps the field-label dictionary + money-field
// set in one place as the non-material edit surface grows. Field
// names mirror the snake_case columns the leases PATCH endpoint may
// modify (see leases.ts ChangeRow type).
export const ADDENDUM_DIFF_FIELD_LABEL: Record<string, string> = {
  late_fee_grace_days:     'Late fee grace period (days)',
  late_fee_initial_amount: 'Initial late fee',
  late_fee_initial_type:   'Late fee type',
  late_fee_enabled:        'Late fees enabled',
  late_fee_accrual_amount: 'Recurring late-fee accrual',
  late_fee_accrual_type:   'Recurring accrual type',
  late_fee_accrual_period: 'Recurring accrual period',
  late_fee_cap_amount:     'Maximum late-fee cap',
  late_fee_cap_type:       'Maximum cap type',
  notice_days_required:    'Notice required (days)',
  expiration_notice_days:  'Expiration notice (days)',
  security_deposit:        'Security deposit',
}
export const ADDENDUM_DIFF_MONEY_FIELDS: ReadonlySet<string> = new Set([
  'late_fee_initial_amount',
  'late_fee_accrual_amount',
  'late_fee_cap_amount',
  'security_deposit',
])

// S226: collapse all flat / percent_of_rent enum fields into one set
// so we don't grow the formatter switch as more late-fee surfaces land.
const LATE_FEE_TYPE_FIELDS: ReadonlySet<string> = new Set([
  'late_fee_initial_type', 'late_fee_accrual_type', 'late_fee_cap_type',
])

export function formatAddendumDiffValue(field: string, raw: string | null | undefined): string {
  if (raw === '' || raw == null) return '—'
  if (ADDENDUM_DIFF_MONEY_FIELDS.has(field)) {
    const n = Number(raw)
    return Number.isFinite(n) ? `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : raw
  }
  if (LATE_FEE_TYPE_FIELDS.has(field)) {
    return raw === 'flat' ? 'Flat $' : raw === 'percent_of_rent' ? '% of rent' : raw
  }
  if (field === 'late_fee_accrual_period') {
    return raw === 'daily' ? 'Daily' : raw === 'weekly' ? 'Weekly' : raw === 'monthly' ? 'Monthly' : raw
  }
  if (field === 'late_fee_enabled') {
    return raw === 'true' ? 'Yes' : raw === 'false' ? 'No' : raw
  }
  return raw
}

// ============================================================================
// LEASE COLUMN TAGS (PDF template editor → lease_template_fields.lease_column)
// ----------------------------------------------------------------------------
// Single source of truth for the lease_template_fields.lease_column CHECK (58
// values as of S24). Every tag the landlord can bind to a PDF field lives
// here. Category drives how the tag is consumed at lease-build time:
//
//   - 'writable'    → writes directly to the leases row at finalize
//   - 'identity'    → display + unit-identity validation, never written
//   - 'signature'   → pure PDF display (signatures, initials)
//   - 'fee_row'     → writes a row to lease_fees (S24+, consumed S29)
//   - 'utility_row' → writes a row to lease_utility_assignments (S24+, S29)
//
// Adding a tag: edit LEASE_COLUMNS, compiler forces CATEGORY + LABEL + INPUT
// updates. Adding a 'writable' tag: also add a WRITABLE_LEASE_COLUMN_SPECS
// entry. Adding a 'fee_row' tag: also add a FEE_ROW_SPECS entry. Adding a
// 'utility_row' tag: also add a UTILITY_ROW_SPECS entry. Object literals
// won't typecheck otherwise.
// ============================================================================

export const LEASE_COLUMNS = [
  // identity — unit + party identification
  'tenant_name', 'tenant_email', 'landlord_name',
  'unit_number', 'property_name', 'property_address',
  // signature — PDF display only
  'tenant_signature', 'landlord_signature',
  'tenant_initial', 'landlord_initial',
  'date_signed',
  // writable (leases table) — core terms
  'rent_amount', 'start_date', 'end_date', 'security_deposit',
  'rent_due_day', 'lease_type', 'auto_renew', 'auto_renew_mode',
  'notice_days_required', 'expiration_notice_days',
  // writable (leases table) — late fee snapshot columns (see S24)
  // Granular tag encoding: amount + (type, period) collapsed into tag name.
  // Parser for each tag writes BOTH the amount column AND its sibling type /
  // period column on leases. Property-level config is billing source of truth;
  // lease columns are legal/audit snapshot.
  'late_fee_grace_days',
  'late_fee_initial_flat', 'late_fee_initial_percent',
  'late_fee_accrual_flat_daily', 'late_fee_accrual_flat_weekly', 'late_fee_accrual_flat_monthly',
  'late_fee_accrual_percent_daily', 'late_fee_accrual_percent_weekly', 'late_fee_accrual_percent_monthly',
  'late_fee_cap_flat', 'late_fee_cap_percent',
  // fee_row (lease_fees table) — one row per tag at finalize
  'pet_deposit', 'key_deposit', 'cleaning_deposit',
  'move_in_fee', 'cleaning_fee', 'pet_fee', 'application_fee',
  'amenity_fee', 'hoa_transfer_fee', 'lease_prep_fee',
  'pet_rent', 'parking_rent', 'storage_rent', 'amenity_fee_monthly',
  'trash_fee', 'pest_control_fee', 'technology_fee',
  'last_month_rent', 'early_termination_fee', 'other_fee',
  // utility_row (lease_utility_assignments table) — per-utility responsibility
  'utility_water_responsibility', 'utility_gas_responsibility',
  'utility_electric_responsibility', 'utility_sewer_responsibility',
  'utility_trash_responsibility',
  // free-text escape
  'custom_text',
] as const
export type LeaseColumn = typeof LEASE_COLUMNS[number]

export type LeaseColumnCategory = 'writable' | 'identity' | 'signature' | 'fee_row' | 'utility_row'
export const LEASE_COLUMN_CATEGORY: Record<LeaseColumn, LeaseColumnCategory> = {
  // identity
  tenant_name:            'identity',
  tenant_email:           'identity',
  landlord_name:          'identity',
  unit_number:            'identity',
  property_name:          'identity',
  property_address:       'identity',
  // signature
  tenant_signature:       'signature',
  landlord_signature:     'signature',
  tenant_initial:         'signature',
  landlord_initial:       'signature',
  date_signed:            'signature',
  // writable — core
  rent_amount:            'writable',
  start_date:             'writable',
  end_date:               'writable',
  security_deposit:       'fee_row',  // S196: deprecated as a leases column; now a lease_fees row
  rent_due_day:           'writable',
  lease_type:             'writable',
  auto_renew:             'writable',
  auto_renew_mode:        'writable',
  notice_days_required:   'writable',
  expiration_notice_days: 'writable',
  // writable — late fee snapshots
  late_fee_grace_days:                  'writable',
  late_fee_initial_flat:                'writable',
  late_fee_initial_percent:             'writable',
  late_fee_accrual_flat_daily:          'writable',
  late_fee_accrual_flat_weekly:         'writable',
  late_fee_accrual_flat_monthly:        'writable',
  late_fee_accrual_percent_daily:       'writable',
  late_fee_accrual_percent_weekly:      'writable',
  late_fee_accrual_percent_monthly:     'writable',
  late_fee_cap_flat:                    'writable',
  late_fee_cap_percent:                 'writable',
  // fee_row
  pet_deposit:            'fee_row',
  key_deposit:            'fee_row',
  cleaning_deposit:       'fee_row',
  move_in_fee:            'fee_row',
  cleaning_fee:           'fee_row',
  pet_fee:                'fee_row',
  application_fee:        'fee_row',
  amenity_fee:            'fee_row',
  hoa_transfer_fee:       'fee_row',
  lease_prep_fee:         'fee_row',
  pet_rent:               'fee_row',
  parking_rent:           'fee_row',
  storage_rent:           'fee_row',
  amenity_fee_monthly:    'fee_row',
  trash_fee:              'fee_row',
  pest_control_fee:       'fee_row',
  technology_fee:         'fee_row',
  last_month_rent:        'fee_row',
  early_termination_fee:  'fee_row',
  other_fee:              'fee_row',
  // utility_row
  utility_water_responsibility:    'utility_row',
  utility_gas_responsibility:      'utility_row',
  utility_electric_responsibility: 'utility_row',
  utility_sewer_responsibility:    'utility_row',
  utility_trash_responsibility:    'utility_row',
  // signature-category catch-all
  custom_text:            'signature',
}

// ============================================================================
// SEND-TIME VALIDATION
// ============================================================================
// At POST /documents/:id/send the landlord transitions a document from draft
// to sent (signing pipeline open). Before that flip we enforce: every tagged
// field with a value-bearing category (writable / fee_row / utility_row) must
// already have a non-empty value filled in by the landlord. Identity and
// signature categories are exempt — identity gets pulled from system data at
// sign render time, signatures are filled by signers.
//
// Rationale: tenants cannot sign blank fields. Landlord must complete the
// document before tenants are invited to sign.
//
// Pure function — takes the rows, returns violations. DB query lives in caller.
// ============================================================================

export const LEASE_COLUMN_VALUE_BEARING_CATEGORIES: readonly LeaseColumnCategory[] =
  ['writable', 'fee_row', 'utility_row'] as const

export interface LeaseDocumentFieldRow {
  lease_column: LeaseColumn | null
  value: string | null
}

export interface SendTimeValidationViolation {
  lease_column: LeaseColumn
  category: LeaseColumnCategory
  reason: 'unfilled'
}

/**
 * Returns violations for send-time validation. Empty array = document is
 * data-complete and may transition to 'sent'. Non-empty array = block send,
 * surface the list to the landlord so they can fill the missing fields.
 *
 * Rule: every row with a value-bearing lease_column category must have a
 * non-null, non-empty (after-trim) value.
 */
export function validateLeaseDocumentForSend(
  rows: readonly LeaseDocumentFieldRow[]
): SendTimeValidationViolation[] {
  const violations: SendTimeValidationViolation[] = []
  for (const row of rows) {
    if (!row.lease_column) continue
    const category = LEASE_COLUMN_CATEGORY[row.lease_column]
    if (!LEASE_COLUMN_VALUE_BEARING_CATEGORIES.includes(category)) continue
    const filled = row.value != null && row.value.trim().length > 0
    if (!filled) {
      violations.push({
        lease_column: row.lease_column,
        category,
        reason: 'unfilled',
      })
    }
  }
  return violations
}

export const LEASE_COLUMN_LABEL: Record<LeaseColumn, string> = {
  tenant_name:            'Tenant name',
  tenant_email:           'Tenant email',
  landlord_name:          'Landlord name',
  unit_number:            'Unit number',
  property_name:          'Property name',
  property_address:       'Property address',
  tenant_signature:       'Tenant signature',
  landlord_signature:     'Landlord signature',
  tenant_initial:         'Tenant initial',
  landlord_initial:       'Landlord initial',
  date_signed:            'Date signed',
  rent_amount:            'Rent amount',
  start_date:             'Lease start date',
  end_date:               'Lease end date',
  security_deposit:       'Security deposit',
  rent_due_day:           'Rent due day',
  lease_type:             'Lease type',
  auto_renew:             'Auto-renew (Yes/No)',
  auto_renew_mode:        'Auto-renew mode',
  notice_days_required:   'Notice days required',
  expiration_notice_days: 'Expiration notice days',
  late_fee_grace_days:                  'Late fee grace days',
  late_fee_initial_flat:                'Late fee — initial (flat $)',
  late_fee_initial_percent:             'Late fee — initial (% of rent)',
  late_fee_accrual_flat_daily:          'Late fee — daily accrual (flat $)',
  late_fee_accrual_flat_weekly:         'Late fee — weekly accrual (flat $)',
  late_fee_accrual_flat_monthly:        'Late fee — monthly accrual (flat $)',
  late_fee_accrual_percent_daily:       'Late fee — daily accrual (% of rent)',
  late_fee_accrual_percent_weekly:      'Late fee — weekly accrual (% of rent)',
  late_fee_accrual_percent_monthly:     'Late fee — monthly accrual (% of rent)',
  late_fee_cap_flat:                    'Late fee — cap (flat $)',
  late_fee_cap_percent:                 'Late fee — cap (% of rent)',
  pet_deposit:            'Pet deposit',
  key_deposit:            'Key deposit',
  cleaning_deposit:       'Cleaning deposit',
  move_in_fee:            'Move-in fee',
  cleaning_fee:           'Cleaning fee',
  pet_fee:                'Pet fee (non-refundable)',
  application_fee:        'Application fee',
  amenity_fee:            'Amenity fee (one-time)',
  hoa_transfer_fee:       'HOA transfer fee',
  lease_prep_fee:         'Lease preparation fee',
  pet_rent:               'Pet rent (monthly)',
  parking_rent:           'Parking rent (monthly)',
  storage_rent:           'Storage rent (monthly)',
  amenity_fee_monthly:    'Amenity fee (monthly)',
  trash_fee:              'Trash fee (monthly)',
  pest_control_fee:       'Pest control fee (monthly)',
  technology_fee:         'Technology fee (monthly)',
  last_month_rent:        'Last month rent',
  early_termination_fee:  'Early termination fee',
  other_fee:              'Other fee',
  utility_water_responsibility:    'Utility — water (tenant responsible?)',
  utility_gas_responsibility:      'Utility — gas (tenant responsible?)',
  utility_electric_responsibility: 'Utility — electric (tenant responsible?)',
  utility_sewer_responsibility:    'Utility — sewer (tenant responsible?)',
  utility_trash_responsibility:    'Utility — trash (tenant responsible?)',
  custom_text:            'Custom text (entered at send time)',
}

// Input bucket for the Field Properties dropdown on the template editor.
//   - 'text' / 'date' → surfaced to landlord as a data-label option
//   - 'implicit'      → bound via field type + signer role, never in dropdown
export type LeaseColumnInput = 'text' | 'date' | 'implicit'
export const LEASE_COLUMN_INPUT: Record<LeaseColumn, LeaseColumnInput> = {
  tenant_name:            'text',
  tenant_email:           'text',
  landlord_name:          'text',
  unit_number:            'text',
  property_name:          'text',
  property_address:       'text',
  tenant_signature:       'implicit',
  landlord_signature:     'implicit',
  tenant_initial:         'implicit',
  landlord_initial:       'implicit',
  date_signed:            'date',
  rent_amount:            'text',
  start_date:             'date',
  end_date:               'date',
  security_deposit:       'text',
  rent_due_day:           'text',
  lease_type:             'text',
  auto_renew:             'text',
  auto_renew_mode:        'text',
  notice_days_required:   'text',
  expiration_notice_days: 'text',
  late_fee_grace_days:                  'text',
  late_fee_initial_flat:                'text',
  late_fee_initial_percent:             'text',
  late_fee_accrual_flat_daily:          'text',
  late_fee_accrual_flat_weekly:         'text',
  late_fee_accrual_flat_monthly:        'text',
  late_fee_accrual_percent_daily:       'text',
  late_fee_accrual_percent_weekly:      'text',
  late_fee_accrual_percent_monthly:     'text',
  late_fee_cap_flat:                    'text',
  late_fee_cap_percent:                 'text',
  pet_deposit:            'text',
  key_deposit:            'text',
  cleaning_deposit:       'text',
  move_in_fee:            'text',
  cleaning_fee:           'text',
  pet_fee:                'text',
  application_fee:        'text',
  amenity_fee:            'text',
  hoa_transfer_fee:       'text',
  lease_prep_fee:         'text',
  pet_rent:               'text',
  parking_rent:           'text',
  storage_rent:           'text',
  amenity_fee_monthly:    'text',
  trash_fee:              'text',
  pest_control_fee:       'text',
  technology_fee:         'text',
  last_month_rent:        'text',
  early_termination_fee:  'text',
  other_fee:              'text',
  utility_water_responsibility:    'text',
  utility_gas_responsibility:      'text',
  utility_electric_responsibility: 'text',
  utility_sewer_responsibility:    'text',
  utility_trash_responsibility:    'text',
  custom_text:            'text',
}

// ============================================================================
// WRITABLE LEASE COLUMN SPECS — parsers that turn collected tag values into
// SQL-ready values destined for columns on the `leases` table.
// ----------------------------------------------------------------------------
// Spec shape (S24+): parse returns Record<string, SqlValue>. A single tag may
// write multiple columns (e.g. late_fee_initial_flat → writes both
// late_fee_initial_amount and late_fee_initial_type on leases).
//
// Consumer (buildLeaseFromDocument in esign.ts) iterates spec entries, calls
// parse(vals), unpacks the returned record into INSERT columns/values.
// ============================================================================

export type WritableLeaseColumn =
  | 'rent_amount'
  | 'start_date'
  | 'end_date'
  // S196: 'security_deposit' removed — now a fee_row, not a leases column.
  | 'rent_due_day'
  | 'lease_type'
  | 'auto_renew'
  | 'auto_renew_mode'
  | 'notice_days_required'
  | 'expiration_notice_days'
  | 'late_fee_grace_days'
  | 'late_fee_initial_flat'
  | 'late_fee_initial_percent'
  | 'late_fee_accrual_flat_daily'
  | 'late_fee_accrual_flat_weekly'
  | 'late_fee_accrual_flat_monthly'
  | 'late_fee_accrual_percent_daily'
  | 'late_fee_accrual_percent_weekly'
  | 'late_fee_accrual_percent_monthly'
  | 'late_fee_cap_flat'
  | 'late_fee_cap_percent'

export type LeaseColumnVals = Partial<Record<LeaseColumn, string>>

export type WritableLeaseColumnSqlValue = string | number | boolean | null

export interface WritableLeaseColumnSpec {
  // parse returns a record of leases-table column names → SQL values.
  // A single tag may contribute multiple columns (sibling type/period writes).
  parse: (vals: LeaseColumnVals) => Record<string, WritableLeaseColumnSqlValue>
}

export const WRITABLE_LEASE_COLUMN_SPECS: Record<WritableLeaseColumn, WritableLeaseColumnSpec> = {
  rent_amount: {
    parse: (v) => {
      if (!v.rent_amount) throw new Error('Template missing rent_amount field — cannot build lease')
      return { rent_amount: v.rent_amount }
    },
  },
  start_date: {
    parse: (v) => {
      if (!v.start_date) throw new Error('Template missing start_date field — cannot build lease')
      return { start_date: v.start_date }
    },
  },
  end_date: {
    // S535 (Nic): '-' in the end-date field means MONTH-TO-MONTH — the
    // completeness gate requires every tagged field filled on a signed
    // document, so the dash is the explicit "no end date" entry.
    parse: (v) => {
      const raw = (v.end_date || '').trim()
      return { end_date: !raw || raw === '-' ? null : raw }
    },
  },
  // S196: security_deposit removed from WRITABLE specs. The fee_row
  // pipeline (FEE_ROW_SPECS) now handles it as a lease_fees row.
  rent_due_day: {
    // S582 (Nic): PLATFORM-LOCKED to the 1st. Rent is always due on the 1st of
    // the month for every lease; a mid-month move-in is prorated (moveInBundle)
    // and full months bill from the 1st. This removes per-lease due-day drift (a
    // past double-billing bug class) and preserves FlexPay's value prop — a
    // move-in-day due date would give a mid-month-paid tenant no reason to enroll.
    // Ignores any document value on purpose (the rent_due_day box is no longer
    // placed — see services/autoFieldPlacement.ts — so no signed doc conflicts).
    parse: () => ({ rent_due_day: 1 }),
  },
  lease_type: {
    // S535 (Nic): no end date ('' or '-') ⇒ the lease IS month-to-month,
    // whatever the lease-type field says — a fixed term without an end
    // date is incoherent, and the dash convention exists precisely so
    // blank-end leases resolve predictably.
    parse: (v) => {
      const rawEnd = (v.end_date || '').trim()
      if (!rawEnd || rawEnd === '-') return { lease_type: 'month_to_month' }
      return { lease_type: v.lease_type || 'fixed_term' }
    },
  },
  auto_renew: {
    parse: (v) => ({ auto_renew: v.auto_renew === 'true' || v.auto_renew === 'yes' }),
  },
  auto_renew_mode: {
    parse: (v) => {
      const autoRenew = v.auto_renew === 'true' || v.auto_renew === 'yes'
      return { auto_renew_mode: autoRenew ? (v.auto_renew_mode || 'convert_to_month_to_month') : null }
    },
  },
  notice_days_required: {
    parse: (v) => ({ notice_days_required: parseInt(v.notice_days_required || '30') }),
  },
  expiration_notice_days: {
    parse: (v) => ({ expiration_notice_days: parseInt(v.expiration_notice_days || '60') }),
  },
  late_fee_grace_days: {
    // S535: 'N/A' / '-' / blank = no late-fee policy for this unit class.
    parse: (v): Record<string, WritableLeaseColumnSqlValue> => {
      const n = parseInt(v.late_fee_grace_days || '')
      return Number.isFinite(n) ? { late_fee_grace_days: n } : {}
    },
  },
  // Late fee granular tags → each writes an amount column + its sibling
  // type/period columns on leases. Property-level config is the billing
  // source of truth; these columns are the legal snapshot of the signed PDF.
  late_fee_initial_flat: {
    parse: (v): Record<string, WritableLeaseColumnSqlValue> => v.late_fee_initial_flat != null && Number.isFinite(Number(v.late_fee_initial_flat))
      ? { late_fee_initial_amount: v.late_fee_initial_flat, late_fee_initial_type: 'flat' }
      : {},
  },
  late_fee_initial_percent: {
    parse: (v): Record<string, WritableLeaseColumnSqlValue> => v.late_fee_initial_percent != null && Number.isFinite(Number(v.late_fee_initial_percent))
      ? { late_fee_initial_amount: v.late_fee_initial_percent, late_fee_initial_type: 'percent_of_rent' }
      : {},
  },
  late_fee_accrual_flat_daily: {
    parse: (v): Record<string, WritableLeaseColumnSqlValue> => v.late_fee_accrual_flat_daily != null && Number.isFinite(Number(v.late_fee_accrual_flat_daily))
      ? { late_fee_accrual_amount: v.late_fee_accrual_flat_daily, late_fee_accrual_type: 'flat', late_fee_accrual_period: 'daily' }
      : {},
  },
  late_fee_accrual_flat_weekly: {
    parse: (v): Record<string, WritableLeaseColumnSqlValue> => v.late_fee_accrual_flat_weekly != null && Number.isFinite(Number(v.late_fee_accrual_flat_weekly))
      ? { late_fee_accrual_amount: v.late_fee_accrual_flat_weekly, late_fee_accrual_type: 'flat', late_fee_accrual_period: 'weekly' }
      : {},
  },
  late_fee_accrual_flat_monthly: {
    parse: (v): Record<string, WritableLeaseColumnSqlValue> => v.late_fee_accrual_flat_monthly != null && Number.isFinite(Number(v.late_fee_accrual_flat_monthly))
      ? { late_fee_accrual_amount: v.late_fee_accrual_flat_monthly, late_fee_accrual_type: 'flat', late_fee_accrual_period: 'monthly' }
      : {},
  },
  late_fee_accrual_percent_daily: {
    parse: (v): Record<string, WritableLeaseColumnSqlValue> => v.late_fee_accrual_percent_daily != null && Number.isFinite(Number(v.late_fee_accrual_percent_daily))
      ? { late_fee_accrual_amount: v.late_fee_accrual_percent_daily, late_fee_accrual_type: 'percent_of_rent', late_fee_accrual_period: 'daily' }
      : {},
  },
  late_fee_accrual_percent_weekly: {
    parse: (v): Record<string, WritableLeaseColumnSqlValue> => v.late_fee_accrual_percent_weekly != null && Number.isFinite(Number(v.late_fee_accrual_percent_weekly))
      ? { late_fee_accrual_amount: v.late_fee_accrual_percent_weekly, late_fee_accrual_type: 'percent_of_rent', late_fee_accrual_period: 'weekly' }
      : {},
  },
  late_fee_accrual_percent_monthly: {
    parse: (v): Record<string, WritableLeaseColumnSqlValue> => v.late_fee_accrual_percent_monthly != null && Number.isFinite(Number(v.late_fee_accrual_percent_monthly))
      ? { late_fee_accrual_amount: v.late_fee_accrual_percent_monthly, late_fee_accrual_type: 'percent_of_rent', late_fee_accrual_period: 'monthly' }
      : {},
  },
  late_fee_cap_flat: {
    parse: (v): Record<string, WritableLeaseColumnSqlValue> => v.late_fee_cap_flat != null && Number.isFinite(Number(v.late_fee_cap_flat))
      ? { late_fee_cap_amount: v.late_fee_cap_flat, late_fee_cap_type: 'flat' }
      : {},
  },
  late_fee_cap_percent: {
    parse: (v): Record<string, WritableLeaseColumnSqlValue> => v.late_fee_cap_percent != null && Number.isFinite(Number(v.late_fee_cap_percent))
      ? { late_fee_cap_amount: v.late_fee_cap_percent, late_fee_cap_type: 'percent_of_rent' }
      : {},
  },
}

// ============================================================================
// FEE ROW SPECS — tags that create a row in lease_fees at finalize (S24+).
// Consumer (buildLeaseFromDocument rebuild at S29) iterates FEE_ROW_SPECS,
// calls parse(vals), inserts one lease_fees row per non-null result.
// ============================================================================

export type FeeRowTag =
  | 'security_deposit'  // S196: was a column on leases; now a lease_fees row like the other deposits
  | 'pet_deposit' | 'key_deposit' | 'cleaning_deposit'
  | 'move_in_fee' | 'cleaning_fee' | 'pet_fee' | 'application_fee'
  | 'amenity_fee' | 'hoa_transfer_fee' | 'lease_prep_fee'
  | 'pet_rent' | 'parking_rent' | 'storage_rent' | 'amenity_fee_monthly'
  | 'trash_fee' | 'pest_control_fee' | 'technology_fee'
  | 'last_month_rent' | 'early_termination_fee' | 'other_fee'

export type FeeType = FeeRowTag
export const FEE_TYPES: readonly FeeType[] = [
  'security_deposit',
  'pet_deposit', 'key_deposit', 'cleaning_deposit',
  'move_in_fee', 'cleaning_fee', 'pet_fee', 'application_fee',
  'amenity_fee', 'hoa_transfer_fee', 'lease_prep_fee',
  'pet_rent', 'parking_rent', 'storage_rent', 'amenity_fee_monthly',
  'trash_fee', 'pest_control_fee', 'technology_fee',
  'last_month_rent', 'early_termination_fee', 'other_fee',
] as const

export type FeeDueTiming = 'move_in' | 'monthly_ongoing' | 'move_out' | 'other'
export const FEE_DUE_TIMINGS: readonly FeeDueTiming[] = ['move_in', 'monthly_ongoing', 'move_out', 'other'] as const

// Work-trade (Landlord #29, locked 2026-06-26). Rent is traded as a PERCENT
// of hours worked: each verified hour is worth 1/target of the TOTAL monthly
// invoice (rent + utilities + fees), so a full target month = 100% covered.
// The target is a per-property setting (properties.work_trade_hours_target);
// this is the default applied to new/legacy properties.
export const DEFAULT_WORK_TRADE_HOURS_TARGET = 80

// Public per-property booking sites (Walkthrough #11 + booking-sites, Nic
// 2026-06-26). The public site books short-term stays only; guests pay a
// deposit at booking. A full unit/date routes guests to the waitlist.
export const PUBLIC_BOOKING_STAY_TYPES = ['nightly', 'weekly'] as const
export type PublicBookingStayType = typeof PUBLIC_BOOKING_STAY_TYPES[number]

export const UNIT_BOOKING_WAITLIST_STATUSES = ['waiting', 'notified', 'claimed', 'expired', 'cancelled'] as const
export type UnitBookingWaitlistStatus = typeof UNIT_BOOKING_WAITLIST_STATUSES[number]

// Master Schedule change-history (Walkthrough #10).
export const UNIT_BOOKING_EVENT_TYPES = ['created', 'moved', 'dates_changed', 'status_changed', 'cancelled'] as const
export type UnitBookingEventType = typeof UNIT_BOOKING_EVENT_TYPES[number]

// Master Schedule stay pricing (Nic 2026-06-27). The rate tier is implied by
// the length of stay and prorated for odd lengths; short-term stays add a
// lodging tax, 30+ nights are tax-exempt.
//   < 7 nights  → nightly × nights
//   7–29 nights → weekly  × nights/7   (a 10-night stay = weekly + 3/7·weekly)
//   ≥ 30 nights → monthly × nights/30  (32 nights = monthly + 2/30·monthly), NO tax
// Each tier falls back to whatever rate is configured if its own is unset.
export interface StayRates { nightly?: number | null; weekly?: number | null; monthly?: number | null }
export interface StayPrice { base: number; tax: number; total: number; tier: 'nightly' | 'weekly' | 'monthly'; taxable: boolean }

export function computeStayPrice(rates: StayRates, taxRatePct: number, nights: number): StayPrice {
  const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100
  if (nights <= 0) return { base: 0, tax: 0, total: 0, tier: 'nightly', taxable: false }
  const nightly = rates.nightly != null ? Number(rates.nightly) : null
  const weekly  = rates.weekly  != null ? Number(rates.weekly)  : null
  const monthly = rates.monthly != null ? Number(rates.monthly) : null

  let base = 0
  let tier: 'nightly' | 'weekly' | 'monthly' = 'nightly'
  if (nights >= 30 && monthly != null)      { base = monthly * nights / 30; tier = 'monthly' }
  else if (nights >= 7 && weekly != null)   { base = weekly  * nights / 7;  tier = 'weekly' }
  else if (nightly != null)                 { base = nightly * nights;      tier = 'nightly' }
  // graceful fallbacks when the preferred-tier rate isn't configured
  else if (monthly != null)                 { base = monthly * nights / 30; tier = 'monthly' }
  else if (weekly != null)                  { base = weekly  * nights / 7;  tier = 'weekly' }

  base = round2(base)
  const taxable = nights < 30
  const tax = taxable ? round2(base * (taxRatePct / 100)) : 0
  return { base, tax, total: round2(base + tax), tier, taxable }
}

// ── S547: calendar-aligned monthly-stay billing (Nic) ──
// A 30+ night stay bills like a resident, not a lump sum: the arrival month
// is prorated (days × monthly/30) from check-in to the 1st, every full
// calendar month is the flat monthly rate invoiced on the 1st with all
// tenants, and a mid-month departure prorates the final month. The stay
// TOTAL is the sum of those segments — the quote and the invoice schedule
// can never disagree.
export interface MonthlyStaySegment {
  from: string          // YYYY-MM-DD inclusive
  to: string            // YYYY-MM-DD exclusive (next segment start / check-out)
  nights: number
  amount: number
  fullMonth: boolean    // true = flat monthly rate, false = prorated at monthly/30
}
export interface MonthlyStaySchedule { segments: MonthlyStaySegment[]; total: number }

export function computeMonthlyStaySchedule(checkIn: string, checkOut: string, monthlyRate: number): MonthlyStaySchedule {
  const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100
  const day = (s: string) => new Date(s.slice(0, 10) + 'T12:00:00Z')
  const iso = (d: Date) => d.toISOString().slice(0, 10)
  const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86400000)
  const nightsBetween = (a: Date, b: Date) => Math.round((b.getTime() - a.getTime()) / 86400000)
  const firstOfNextMonth = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1, 12))

  const start = day(checkIn), end = day(checkOut)
  const segments: MonthlyStaySegment[] = []
  let cur = start
  while (cur < end) {
    const boundary = firstOfNextMonth(cur)
    const segEnd = boundary < end ? boundary : end
    const nights = nightsBetween(cur, segEnd)
    // Flat month = 1st → 1st. Anything else (arrival month, departure month,
    // or a stay contained inside one month) prorates at monthly/30.
    const fullMonth = cur.getUTCDate() === 1 && segEnd.getTime() === boundary.getTime()
    segments.push({
      from: iso(cur), to: iso(segEnd), nights,
      amount: fullMonth ? round2(monthlyRate) : round2(monthlyRate * nights / 30),
      fullMonth,
    })
    cur = segEnd
  }
  return { segments, total: round2(segments.reduce((s, x) => s + x.amount, 0)) }
}

// S547 (Nic): deposit rules split by stay length. The percentage deposit
// (booking_deposit_pct) applies ONLY to short stays (<30 nights) — those
// guests are likelier to skip without money down. Monthly-tier stays owe a
// FLAT deposit: per-property booking_monthly_deposit, defaulting to this
// utility-bill-sized amount, and always HARD-CAPPED at one month's rent
// (keeps it compliant for long-term living situations).
export const BOOKING_MONTHLY_DEPOSIT_DEFAULT = 150

// How long a promoted waitlister has to claim before it rolls to the next
// person (Nic: short on purpose — high-demand next-day stays).
export const WAITLIST_CLAIM_WINDOW_MINUTES = 60

// Per-fee-type metadata: default refundability + default timing.
// Landlord can override at review page; these are starting values.
export interface FeeTypeMeta {
  isRefundable: boolean
  dueTiming: FeeDueTiming
}
export const FEE_TYPE_META: Record<FeeType, FeeTypeMeta> = {
  security_deposit:       { isRefundable: true,  dueTiming: 'move_in' },
  pet_deposit:            { isRefundable: true,  dueTiming: 'move_in' },
  key_deposit:            { isRefundable: true,  dueTiming: 'move_in' },
  cleaning_deposit:       { isRefundable: true,  dueTiming: 'move_in' },
  move_in_fee:            { isRefundable: false, dueTiming: 'move_in' },
  cleaning_fee:           { isRefundable: false, dueTiming: 'move_out' },
  pet_fee:                { isRefundable: false, dueTiming: 'move_in' },
  application_fee:        { isRefundable: false, dueTiming: 'move_in' },
  amenity_fee:            { isRefundable: false, dueTiming: 'move_in' },
  hoa_transfer_fee:       { isRefundable: false, dueTiming: 'move_in' },
  lease_prep_fee:         { isRefundable: false, dueTiming: 'move_in' },
  pet_rent:               { isRefundable: false, dueTiming: 'monthly_ongoing' },
  parking_rent:           { isRefundable: false, dueTiming: 'monthly_ongoing' },
  storage_rent:           { isRefundable: false, dueTiming: 'monthly_ongoing' },
  amenity_fee_monthly:    { isRefundable: false, dueTiming: 'monthly_ongoing' },
  trash_fee:              { isRefundable: false, dueTiming: 'monthly_ongoing' },
  pest_control_fee:       { isRefundable: false, dueTiming: 'monthly_ongoing' },
  technology_fee:         { isRefundable: false, dueTiming: 'monthly_ongoing' },
  last_month_rent:        { isRefundable: true,  dueTiming: 'move_in' },
  early_termination_fee:  { isRefundable: false, dueTiming: 'other' },
  other_fee:              { isRefundable: false, dueTiming: 'other' },
}

export interface FeeRowSpec {
  // parse returns a single lease_fees row ready to insert, or null if the
  // tag was not bound / value empty.
  parse: (vals: LeaseColumnVals) => null | {
    fee_type: FeeType
    amount: string
    is_refundable: boolean
    due_timing: FeeDueTiming
  }
}

function makeFeeRowSpec(tag: FeeType): FeeRowSpec {
  return {
    parse: (v) => {
      const val = v[tag]
      if (val == null || val === '') return null
      const meta = FEE_TYPE_META[tag]
      return {
        fee_type: tag,
        amount: val,
        is_refundable: meta.isRefundable,
        due_timing: meta.dueTiming,
      }
    },
  }
}

export const FEE_ROW_SPECS: Record<FeeRowTag, FeeRowSpec> = {
  security_deposit:       makeFeeRowSpec('security_deposit'),
  pet_deposit:            makeFeeRowSpec('pet_deposit'),
  key_deposit:            makeFeeRowSpec('key_deposit'),
  cleaning_deposit:       makeFeeRowSpec('cleaning_deposit'),
  move_in_fee:            makeFeeRowSpec('move_in_fee'),
  cleaning_fee:           makeFeeRowSpec('cleaning_fee'),
  pet_fee:                makeFeeRowSpec('pet_fee'),
  application_fee:        makeFeeRowSpec('application_fee'),
  amenity_fee:            makeFeeRowSpec('amenity_fee'),
  hoa_transfer_fee:       makeFeeRowSpec('hoa_transfer_fee'),
  lease_prep_fee:         makeFeeRowSpec('lease_prep_fee'),
  pet_rent:               makeFeeRowSpec('pet_rent'),
  parking_rent:           makeFeeRowSpec('parking_rent'),
  storage_rent:           makeFeeRowSpec('storage_rent'),
  amenity_fee_monthly:    makeFeeRowSpec('amenity_fee_monthly'),
  trash_fee:              makeFeeRowSpec('trash_fee'),
  pest_control_fee:       makeFeeRowSpec('pest_control_fee'),
  technology_fee:         makeFeeRowSpec('technology_fee'),
  last_month_rent:        makeFeeRowSpec('last_month_rent'),
  early_termination_fee:  makeFeeRowSpec('early_termination_fee'),
  other_fee:              makeFeeRowSpec('other_fee'),
}

// ============================================================================
// UTILITY ROW SPECS — tags that create a row in lease_utility_assignments
// at finalize (S24+, consumed S29). Tag value 'true'/'yes' (or any truthy)
// = tenant is responsible = row gets created. Empty/null/falsy = no row =
// landlord covers. At review page, landlord additionally selects WHICH meter
// this assignment ties to (resolved out-of-band from tag).
// ============================================================================

// S613 (Nic): propane is a utility like the rest — it can be a shared master
// split across spaces, a flat monthly charge, or a per-space tank that bills off
// deliveries. Only the third is not a meter.
export type UtilityType = 'water' | 'gas' | 'electric' | 'sewer' | 'trash' | 'propane'
export const UTILITY_TYPES: readonly UtilityType[] = ['water', 'gas', 'electric', 'sewer', 'trash', 'propane'] as const

// S613 (Nic asked whether gas and propane should stay separate): they stay
// separate because they are not measured the same way and are not delivered the
// same way. Natural gas arrives on a pipe and is read in THERMS; propane arrives
// on a truck and is measured in GALLONS in a tank. The per-tank fill model has
// no meaning for natural gas, and a merged type would put the wrong unit on
// somebody's bill — which is exactly the defect fixed this session, where a
// propane line printed "therms".
//
// The risk of two similar names is a landlord picking the wrong one, and that is
// a LABEL problem, not a modelling one. Hence these, which also retire the raw
// enum being capitalised straight into the UI.
export const UTILITY_TYPE_LABEL: Record<UtilityType, string> = {
  water:    'Water',
  sewer:    'Sewer',
  electric: 'Electric',
  gas:      'Natural gas',
  trash:    'Trash',
  propane:  'Propane',
}

/** What a unit of this utility IS, on a meter face or a delivery ticket. */
export const UTILITY_UNIT_LABEL: Record<UtilityType, string> = {
  water:    'gal',
  sewer:    'gal',
  electric: 'kWh',
  gas:      'therms',
  trash:    '',
  propane:  'gal',
}

export type UtilityRowTag =
  | 'utility_water_responsibility'
  | 'utility_gas_responsibility'
  | 'utility_electric_responsibility'
  | 'utility_sewer_responsibility'
  | 'utility_trash_responsibility'

export const UTILITY_TAG_TO_TYPE: Record<UtilityRowTag, UtilityType> = {
  utility_water_responsibility:    'water',
  utility_gas_responsibility:      'gas',
  utility_electric_responsibility: 'electric',
  utility_sewer_responsibility:    'sewer',
  utility_trash_responsibility:    'trash',
}

export interface UtilityRowSpec {
  // parse returns { utilityType, tenantResponsible } or null if unbound.
  // Meter resolution happens at review page (landlord picks which meter).
  parse: (vals: LeaseColumnVals) => null | {
    utility_type: UtilityType
    tenant_responsible: boolean
  }
}

function makeUtilityRowSpec(tag: UtilityRowTag): UtilityRowSpec {
  return {
    parse: (v) => {
      const val = v[tag]
      if (val == null || val === '') return null
      const truthy = val === 'true' || val === 'yes' || val === '1' || val.toLowerCase() === 'tenant'
      return {
        utility_type: UTILITY_TAG_TO_TYPE[tag],
        tenant_responsible: truthy,
      }
    },
  }
}

export const UTILITY_ROW_SPECS: Record<UtilityRowTag, UtilityRowSpec> = {
  utility_water_responsibility:    makeUtilityRowSpec('utility_water_responsibility'),
  utility_gas_responsibility:      makeUtilityRowSpec('utility_gas_responsibility'),
  utility_electric_responsibility: makeUtilityRowSpec('utility_electric_responsibility'),
  utility_sewer_responsibility:    makeUtilityRowSpec('utility_sewer_responsibility'),
  utility_trash_responsibility:    makeUtilityRowSpec('utility_trash_responsibility'),
}

// Utility meter configuration enums (consumed S27 utility UI + billing).
export type UtilityBillingMethod = 'submeter' | 'rubs' | 'master_bill_to_landlord'
export const UTILITY_BILLING_METHODS: readonly UtilityBillingMethod[] =
  ['submeter', 'rubs', 'master_bill_to_landlord'] as const

// S607: `rented_spaces` — an equal share across only the units currently
// LEASED. Added because some jurisdictions require that basis outright, and
// because a naive equal split hands a VACANT unit a share that then finds no
// tenant and is never billed, leaving the landlord short on a bill he has
// already paid. Counting only leased units recovers the whole pool.
// S607: widened to what landlords across the country actually use. None of
// these narrows anything — every basis stays available and each new one is
// inert until selected. Config for the ones that need it lives on
// utility_meters.rubs_weights.
//   fixture_count      — per plumbing fixture (units.water_fixture_count)
//   unit_type_weight   — landlord-set weight per unit type
//   hybrid             — a percentage blend of two other bases
//
// S607: 'equal_split' and 'weighted_occupancy' were REMOVED (Nic). equal_split
// gave a vacant unit a full share that then billed to nobody, so the landlord
// silently ate it — rented_spaces is the same idea done correctly.
// weighted_occupancy was complexity nobody would pick. Options nobody would
// choose are not flexibility; they are noise on the screen that decides how
// every tenant on a meter is charged.
export type RubsAllocationMethod =
  | 'occupant_count' | 'sqft' | 'bedrooms' | 'rented_spaces'
  | 'fixture_count' | 'unit_type_weight' | 'hybrid'
export const RUBS_ALLOCATION_METHODS: readonly RubsAllocationMethod[] =
  ['occupant_count', 'sqft', 'bedrooms', 'rented_spaces',
   'fixture_count', 'unit_type_weight', 'hybrid'] as const

// ============================================================================
// LATE FEE ENUMS (properties.* + leases.* column value domains, consumed S26)
// ============================================================================

export type LateFeeAmountType = 'flat' | 'percent_of_rent'
export const LATE_FEE_AMOUNT_TYPES: readonly LateFeeAmountType[] = ['flat', 'percent_of_rent'] as const

export type LateFeeAccrualPeriod = 'daily' | 'weekly' | 'monthly'
export const LATE_FEE_ACCRUAL_PERIODS: readonly LateFeeAccrualPeriod[] = ['daily', 'weekly', 'monthly'] as const

// ============================================================================
// DEPOSIT ENUMS (properties.deposit_* + security_deposits.held_by, S24+)
// ============================================================================

export type DepositHandlingMode = 'gam_escrow' | 'landlord_held'
export const DEPOSIT_HANDLING_MODES: readonly DepositHandlingMode[] = ['gam_escrow', 'landlord_held'] as const

export type DepositHeldBy = DepositHandlingMode
export const DEPOSIT_HELD_BY_VALUES = DEPOSIT_HANDLING_MODES

export type DepositInterestMethod = 'simple' | 'compound'
export const DEPOSIT_INTEREST_METHODS: readonly DepositInterestMethod[] = ['simple', 'compound'] as const

export type DepositInterestCadence = 'annual' | 'at_return' | 'on_anniversary'
export const DEPOSIT_INTEREST_CADENCES: readonly DepositInterestCadence[] =
  ['annual', 'at_return', 'on_anniversary'] as const

// ============================================================================
// LEASE TYPE (leases.lease_type column)
// S24: nightly + weekly removed — short-term bookings live in unit_bookings
// with their own booking_type classifier. Do not conflate.
// ============================================================================

export const LEASE_TYPES = ['month_to_month', 'fixed_term', 'nnn_commercial'] as const

// S29c — onboarding source (where the tenant entered the platform)
export type OnboardingSource = 'applied' | 'onboarded'
export const ONBOARDING_SOURCES: readonly OnboardingSource[] = ['applied', 'onboarded'] as const

// S29c — lease source (e-signed in GAM vs imported from off-platform)
export type LeaseSource = 'esigned' | 'imported'
export const LEASE_SOURCES: readonly LeaseSource[] = ['esigned', 'imported'] as const

export type LeaseType = typeof LEASE_TYPES[number]
export const LEASE_TYPE_LABEL: Record<LeaseType, string> = {
  month_to_month: 'Month-to-month',
  fixed_term:     'Fixed term',
  nnn_commercial: 'NNN Commercial',
}

// Auto-renew mode — behavior when a fixed-term lease reaches end_date.
// Single source of truth for leases_auto_renew_mode_check CHECK constraint.
// NULL is valid when auto_renew is false (enforced separately by
// leases_auto_renew_mode_required).
export const AUTO_RENEW_MODES = ['extend_same_term', 'convert_to_month_to_month'] as const
export type AutoRenewMode = typeof AUTO_RENEW_MODES[number]
export const AUTO_RENEW_MODE_LABEL: Record<AutoRenewMode, string> = {
  extend_same_term:          'Extend same term',
  convert_to_month_to_month: 'Convert to month-to-month',
}

// lease_tenants table — 5 CHECK constraints, registered here as single source
// of truth. Today these are only consumed by SQL string literals in routes —
// registering them enforces commandment 16 so future TS consumers cannot drift.

// Status of a tenant's membership on a lease.
// Single source of truth for lease_tenants_status_check (5 values).
//   pending_add    — signer row created, addendum_add not yet completed
//   active         — currently on the lease
//   pending_remove — addendum_remove in flight, still active until signed
//   removed        — off the lease (kept for history)
//   void           — row created in error, never took effect
export const LEASE_TENANT_STATUSES = ['pending_add', 'active', 'pending_remove', 'removed', 'void'] as const
export type LeaseTenantStatus = typeof LEASE_TENANT_STATUSES[number]
export const LEASE_TENANT_STATUS_LABEL: Record<LeaseTenantStatus, string> = {
  pending_add:    'Pending Add',
  active:         'Active',
  pending_remove: 'Pending Remove',
  removed:        'Removed',
  void:           'Void',
}

// Tenant role on a lease.
// Single source of truth for lease_tenants_role_check (2 values).
export const LEASE_TENANT_ROLES = ['primary', 'co_tenant'] as const
export type LeaseTenantRole = typeof LEASE_TENANT_ROLES[number]
export const LEASE_TENANT_ROLE_LABEL: Record<LeaseTenantRole, string> = {
  primary:   'Primary Tenant',
  co_tenant: 'Co-Tenant',
}

// How rent liability is split across tenants on a lease.
// Single source of truth for lease_tenants_financial_responsibility_check (3 values).
export const FINANCIAL_RESPONSIBILITIES = ['joint_several', 'split_equal', 'split_custom'] as const
export type FinancialResponsibility = typeof FINANCIAL_RESPONSIBILITIES[number]
export const FINANCIAL_RESPONSIBILITY_LABEL: Record<FinancialResponsibility, string> = {
  joint_several: 'Joint & Several',
  split_equal:   'Split Equally',
  split_custom:  'Custom Split',
}

// Why a tenant was added to a lease. Nullable.
// Single source of truth for lease_tenants_added_reason_check (3 values).
export const LEASE_TENANT_ADDED_REASONS = ['original', 'roommate_added', 'replacement'] as const
export type LeaseTenantAddedReason = typeof LEASE_TENANT_ADDED_REASONS[number]
export const LEASE_TENANT_ADDED_REASON_LABEL: Record<LeaseTenantAddedReason, string> = {
  original:       'Original Tenant',
  roommate_added: 'Roommate Added',
  replacement:    'Replacement',
}

// Why a tenant was removed from a lease. Nullable.
// Single source of truth for lease_tenants_removed_reason_check (3 values).
export const LEASE_TENANT_REMOVED_REASONS = ['moved_out', 'replaced', 'lease_ended'] as const
export type LeaseTenantRemovedReason = typeof LEASE_TENANT_REMOVED_REASONS[number]
export const LEASE_TENANT_REMOVED_REASON_LABEL: Record<LeaseTenantRemovedReason, string> = {
  moved_out:   'Moved Out',
  replaced:    'Replaced',
  lease_ended: 'Lease Ended',
}

// Lease document overall status. Tracks the dispatch lifecycle of an e-sign
// envelope from draft to terminal state.
// Single source of truth for lease_documents_status_check (5 values).
//   pending     — created, not yet dispatched
//   sent        — first signer invited
//   in_progress      — at least one signer signed, not all
//   completed        — all signers signed, execute* ran successfully
//   voided           — cancelled before completion (with void_reason)
//   execution_failed — all signed, but the post-sign execute step (lease
//                      build / cascade / move-in invoice) raised — parked
//                      for admin investigation. Cleared via void.
// S74: 'execution_failed' added to match the DB CHECK; pre-S74 the
// shared list was missing this value while esign.ts actively wrote it.
export const LEASE_DOCUMENT_STATUSES = ['pending', 'sent', 'in_progress', 'completed', 'voided', 'execution_failed'] as const
export type LeaseDocumentStatus = typeof LEASE_DOCUMENT_STATUSES[number]
export const LEASE_DOCUMENT_STATUS_LABEL: Record<LeaseDocumentStatus, string> = {
  pending:           'Pending',
  sent:              'Sent',
  in_progress:       'In Progress',
  completed:         'Completed',
  voided:            'Voided',
  execution_failed:  'Execution Failed',
}

// Per-signer status on a lease document. Drives the sequential signing flow:
// only the current signer is 'sent'; later signers remain 'pending' until
// their turn. 'declined' is terminal for that signer and voids the document.
// Single source of truth for lease_document_signers_status_check (5 values).
export const LEASE_DOCUMENT_SIGNER_STATUSES = ['pending', 'sent', 'viewed', 'signed', 'declined'] as const
export type LeaseDocumentSignerStatus = typeof LEASE_DOCUMENT_SIGNER_STATUSES[number]
export const LEASE_DOCUMENT_SIGNER_STATUS_LABEL: Record<LeaseDocumentSignerStatus, string> = {
  pending:  'Pending',
  sent:     'Sent',
  viewed:   'Viewed',
  signed:   'Signed',
  declined: 'Declined',
}


// ── CORE MODELS ────────────────────────────────────────────

export interface User {
  id: string
  email: string
  role: UserRole
  firstName: string
  lastName: string
  phone?: string
  createdAt: Date
  updatedAt: Date
}

export interface Landlord {
  id: string
  userId: string
  user?: User
  businessName?: string
  ein?: string                   // Tax ID
  // S67: bankAccountReady is server-derived from active user_bank_accounts.
  // Replaces the pre-16a stripeAccountId / stripeBankVerified fields which
  // were Stripe-Connect-specific and incorrect under the merchant-of-record
  // model.
  bankAccountReady?: boolean
  onboardingComplete: boolean
  units?: Unit[]
  createdAt: Date
  updatedAt: Date
}

export interface Tenant {
  id: string
  userId: string
  user?: User
  stripeCustomerId?: string
  achVerified: boolean           // Micro-deposit confirmed
  bankLast4?: string
  bankRoutingLast4?: string
  ssiSsdi: boolean               // SSI/SSDI income flag
  incomeArrivalDay?: number      // Day of month income arrives (e.g. 15)
  onTimePaylEnrolled: boolean    // On-Time Pay float service opted in
  floatFeeActive: boolean        // $20/mo service fee active
  creditReportingEnrolled: boolean
  flexDepositEnrolled: boolean
  latePaymentCount: number       // Trigger for On-Time Pay invitation
  createdAt: Date
  updatedAt: Date
}

export interface Property {
  id: string
  landlordId: string
  landlord?: Landlord
  name: string
  address: Address
  type: PropertyType
  units?: Unit[]
  createdAt: Date
  updatedAt: Date
}

export interface Address {
  street1: string
  street2?: string
  city: string
  state: string
  zip: string
}

export interface Unit {
  id: string
  propertyId: string
  property?: Property
  landlordId: string
  tenantId?: string
  tenant?: Tenant
  unitNumber: string
  bedrooms: number
  bathrooms: number
  sqft?: number
  status: UnitStatus
  rentAmount: number
  securityDeposit: number
  onTimePayActive: boolean       // On-Time Pay SLA active for this unit
  paymentBlock: boolean          // Eviction mode — ALL ACH hard blocked
  leases?: Lease[]
  createdAt: Date
  updatedAt: Date
}

export interface Lease {
  id: string
  unitId: string
  unit?: Unit
  tenantId: string
  tenant?: Tenant
  status: LeaseStatus
  startDate: Date
  endDate: Date
  rentAmount: number
  securityDeposit: number
  documents?: Document[]
  createdAt: Date
  updatedAt: Date
}

export interface Payment {
  id: string
  unitId: string
  unit?: Unit
  tenantId?: string
  landlordId: string
  type: 'rent' | 'fee' | 'deposit' | 'utility' | 'float_fee'
  amount: number
  status: PaymentStatus
  stripePaymentIntentId?: string
  achTraceNumber?: string
  entryDescription: AchEntryDescription
  returnCode?: AchReturnCode
  dueDate: Date
  settledAt?: Date
  notes?: string
  createdAt: Date
}

// NACHA entry descriptions — configured in Stripe
export type AchEntryDescription =
  | 'RENT'
  | 'SUBSCRIP'
  | 'DEPOSIT'
  | 'UTILITY'
  | 'ONTIMEPAY'
  | 'PROPANE'

export interface Disbursement {
  id: string
  landlordId: string
  landlord?: Landlord
  amount: number
  unitCount: number
  status: PaymentStatus
  stripePayoutId?: string
  initiatedAt?: Date
  settledAt?: Date
  fromReserve: boolean           // True if funded from operational reserve
  reserveAmount: number          // Amount drawn from reserve
  notes?: string
  createdAt: Date
}

export interface SecurityDeposit {
  id: string
  unitId: string
  leaseId: string
  tenantId: string
  totalAmount: number
  collectedAmount: number
  status: DepositStatus
  flexDepositEnabled: boolean
  installmentCount?: number      // 2–6 based on deposit amount
  installmentAmount?: number
  installmentsRemaining?: number
  custodyAccountId?: string      // Platform custody account
  interestAccrued: number        // Platform keeps per ARS 33-1321
  createdAt: Date
  updatedAt: Date
}

export interface MaintenanceRequest {
  id: string
  unitId: string
  unit?: Unit
  tenantId?: string
  landlordId: string
  title: string
  description: string
  priority: MaintenancePriority
  status: MaintenanceStatus
  assignedTo?: string            // users.id the request is routed to — in-house worker OR outside contractor (renamed from contractorId, S585)
  contractor?: Contractor
  estimatedCost?: number
  actualCost?: number
  platformFee?: number           // 5% of job value — deferred contractor marketplace (see MAINTENANCE_PCT); not billed today
  scheduledAt?: Date
  completedAt?: Date
  photos?: string[]
  createdAt: Date
  updatedAt: Date
}

export interface Contractor {
  id: string
  name: string
  businessName: string
  phone: string
  email: string
  contractorLicenseNumber: string | null  // Optional — varies by state and trade
  contractorLicenseState: string | null   // 2-letter state code of issuing regulator
  insuranceExpiry: Date
  insuranceVerified: boolean
  listingTier?: 'featured' | 'premium' | 'exclusive'
  listingFee?: number
  trades: string[]               // e.g. ['plumbing','electrical','hvac']
  rating?: number
  completedJobs: number
  createdAt: Date
  updatedAt: Date
}

export interface Document {
  id: string
  leaseId?: string
  unitId?: string
  tenantId?: string
  landlordId: string
  type: DocumentCategory
  name: string
  url: string
  signedAt?: Date
  createdAt: Date
}

export interface UtilityBill {
  id: string
  unitId: string
  tenantId: string
  utilityType: string
  openingReading: number
  closingReading: number
  openingDate: Date
  closingDate: Date
  usageAmount: number
  ratePerUnit: number
  utilityCost: number
  adminFee: number               // Landlord-configurable passthrough fee
  totalAmount: number
  status: PaymentStatus
  billedAt: Date
}

// ── PLATFORM FINANCIALS ────────────────────────────────────

export interface ReserveFund {
  id: string
  balance: number
  targetBalance: number          // 3× monthly expected defaults
  phase: 1 | 2 | 3
  reserveRate: number            // 1.0 | 0.30 | 0.15
  monthlyContribution: number
  lastUpdatedAt: Date
}

export interface FloatAccount {
  id: string
  balance: number
  seedCapital: number            // Personal savings seed
  apy: number                    // 4.5%
  monthlyInterest: number
  lastUpdatedAt: Date
}

// ── API RESPONSES ──────────────────────────────────────────

export interface ApiResponse<T> {
  success: boolean
  data?: T
  error?: string
  message?: string
}

export interface PaginatedResponse<T> {
  data: T[]
  total: number
  page: number
  pageSize: number
  totalPages: number
}

// ── STRIPE / PAYMENT CONFIG ────────────────────────────────

// GAM's COST side (what Stripe charges GAM) — distinct from PROCESSING_FEES
// below, which is what GAM charges the CUSTOMER. Do not confuse the two.
//
// S603 (Nic): ACH_RATE/ACH_CAP were 0.8% / $5.00 — Stripe's PUBLIC ACH list
// price, never GAM's. GAM is on a NEGOTIATED 0.5% capped $3.00, which is what
// the platform_processing_rates `ach` row has always carried. The stale pair
// here overstated GAM's ACH cost by up to $2.00/payment, which understated the
// net on the landlord-facing per-unit economics endpoint (routes/units.ts
// /:id/economics via calcNetPerUnit). platform_processing_rates is the SOURCE
// OF TRUTH for processing economics; these constants must mirror it.
export const STRIPE_CONFIG = {
  ACH_RATE:        0.005,   // negotiated — mirrors platform_processing_rates.ach stripe_cost_percent
  ACH_CAP:         3.00,    // negotiated — mirrors platform_processing_rates.ach stripe_cost_cap
  PAYOUT_RATE:     0.0025,
  PAYOUT_FLAT:     0.25,
  // S616 (Nic, confirmed against the Stripe contract): $1.00 per active Connect
  // account per month, NOT the $2.00 that sat here. Same failure as ACH_RATE
  // before S603 — a public list price hardcoded where a negotiated rate
  // belonged, quietly overstating GAM's own cost. Unlike the processing rates
  // there is no platform_processing_rates row for this one, so nothing
  // validates it; it is admin-only margin math (calcNetPerUnit, gated to
  // admin in units.ts /:id/economics) and never reaches a landlord or tenant.
  CONNECT_ACCT_MO: 1.00,
} as const

// S551 (Nic): the platform-wide CUSTOMER-FACING processing fee schedule —
// THE single source for every card/ACH processing fee on any service
// (rent, background checks, deposits, POS, everything). Consumers:
// services/stripeConnect.ts computePlatformCut (destination charges) and
// the platform_processing_rates DB rows (allocation engine) — the
// 20260721 migration seeds those rows from these same numbers; if these
// change, cut a new migration to match.
//   Card: 3.5% + $0.55 per transaction (+1.5% on non-US-issued cards) — S603 (Nic).
//         The old 26¢ mirrored ONLY the Stripe per-authorization fee. GAM's real
//         fixed cost per SUCCESSFUL payment is ~$0.55: $0.26 auth + $0.02 Radar +
//         interchange's own fixed leg ($0.10 credit / $0.21 regulated debit) + an
//         amortized share of authorizations that earn nothing (card-save
//         verifications and declines each cost $0.28 with no revenue).
//         3.25% left only 2.55% for interchange after Stripe's 0.7%, so every
//         commercial card (~2.70-3.15%) lost money and lost MORE as rent rose.
//         3.5% clears consumer debit and credit incl. premium (~2.40%); commercial
//         stays a small accepted loss above ~$113 (-$0.28 on a $300 booking).
//         See migration 20260812150000_card_fee_35_pct_55_flat.sql.
//   ACH:  flat $6.00 (S601, Nic). One flat bank fee at any rent — simple to state
//         honestly ("$6 flat"), no percentage. GAM nets $3–$6 after Stripe's cost
//         (0.5% capped $3): $3 at the top, more on lower rent. Tiny payments rarely
//         go ACH (a card is cheaper at that size), so the flat fee doesn't sting there.
export const PROCESSING_FEES = {
  CARD_PCT:      0.035,
  CARD_FLAT:     0.55,
  CARD_INTL_PCT: 0.015,
  ACH_PCT:       0,
  ACH_FLAT:      6.00,
  ACH_CAP:       6.00,
} as const

/**
 * S604: human-readable processing-fee labels, DERIVED from PROCESSING_FEES.
 *
 * Every repricing so far has left stale numbers in UI copy — after the S603
 * card change to 3.5% + $0.55 the landlord onboarding screen and the properties
 * fee card both still read "3.25% + 26¢", which meant a landlord was agreeing to
 * terms against a rate that no longer existed. Copy that quotes a price must be
 * generated from the constant, never typed.
 */
export function cardFeeLabel(opts: { intl?: boolean } = {}): string {
  const pct  = `${(PROCESSING_FEES.CARD_PCT * 100).toFixed(2).replace(/\.?0+$/, '')}%`
  const flat = `${Math.round(PROCESSING_FEES.CARD_FLAT * 100)}¢`
  const base = `${pct} + ${flat}`
  return opts.intl
    ? `${base} (+${(PROCESSING_FEES.CARD_INTL_PCT * 100).toFixed(1).replace(/\.0$/, '')}% on non-US-issued cards)`
    : base
}

/** S604: ACH is a flat fee (S601) — no percentage, no cap language. */
export function achFeeLabel(): string {
  return `$${PROCESSING_FEES.ACH_FLAT.toFixed(2)} flat`
}

/**
 * S607 — THE processing-fee formula. One definition, used by the code that
 * CHARGES (services/stripeConnect.computePlatformCut delegates here) and by
 * the code that QUOTES a price to a tenant before they choose a method.
 *
 * Nic asked the invoice to show what each payment method would cost. A display
 * formula written separately from the charging formula is a quote that goes
 * stale the next time either is repriced — and the tenant would have chosen a
 * method based on a number we then did not honour. Same reasoning as S604's
 * derived labels, one level deeper: derive the FIGURES too, not just the words.
 */
export function processingFeeFor(opts: {
  amount: number
  paymentMethod: 'ach' | 'card'
  cardCountry?: string | null
}): number {
  if (opts.paymentMethod === 'ach') {
    return round2(Math.min(
      opts.amount * PROCESSING_FEES.ACH_PCT + PROCESSING_FEES.ACH_FLAT,
      PROCESSING_FEES.ACH_CAP))
  }
  let pct: number = PROCESSING_FEES.CARD_PCT
  if (opts.cardCountry && opts.cardCountry !== 'US') pct += PROCESSING_FEES.CARD_INTL_PCT
  return round2(opts.amount * pct + PROCESSING_FEES.CARD_FLAT)
}

export interface PaymentMethodCost {
  method: 'ach' | 'card' | 'manual'
  /** Short label for the row, e.g. "Bank account". */
  label: string
  /** The fee added on top of the balance for this method. */
  fee: number
  /** What the tenant actually pays, all in. */
  total: number
}

/**
 * S607 (Nic): every way to pay this balance, priced, for the invoice.
 *
 * Nic: "maybe on the invoice, it can show a breakdown of what each bill would be
 * by payment method... that way they see all the avenues and the price at the
 * point the invoice comes out."
 *
 * `manualFee` is passed in rather than assumed, because whether the cash/check/
 * money-order fee applies depends on the tenant's own history and the property's
 * onboarding window — a rule this pure function has no business guessing at.
 * Pass 0 when it is waived.
 */
export function paymentMethodCosts(
  amount: number,
  opts: { manualFee?: number; cardCountry?: string | null } = {},
): PaymentMethodCost[] {
  const ach  = processingFeeFor({ amount, paymentMethod: 'ach' })
  const card = processingFeeFor({ amount, paymentMethod: 'card', cardCountry: opts.cardCountry })
  const manual = round2(opts.manualFee ?? 0)
  return [
    { method: 'ach',    label: 'Bank account',            fee: ach,    total: round2(amount + ach) },
    { method: 'card',   label: 'Card or debit',           fee: card,   total: round2(amount + card) },
    { method: 'manual', label: 'Cash, check or money order', fee: manual, total: round2(amount + manual) },
  ]
}

const round2 = (n: number) => Math.round(n * 100) / 100

export const PLATFORM_FEES = {
  // @deprecated S561 — the per-unit LANDLORD fee tiers below are RETIRED. The
  // LIVE landlord fee is LAUNCH_PLATFORM_FEE.PER_OCCUPIED_UNIT ($2/occupied
  // unit, $10/property min); calcNetPerUnit uses the live model. Do NOT use
  // ACTIVE_UNIT/DIRECT_PAY_UNIT/VACANT_UNIT/LATE_FEE for new fee math.
  ACTIVE_UNIT:     15.00,
  DIRECT_PAY_UNIT: 5.00,
  VACANT_UNIT:     0.00,
  LATE_FEE:        15.00,
  // ⚠️ STILL LIVE — the admin income projection (admin.ts /income/projection)
  // reads FLOAT_FEE_MO + BG_CHECK_NET. Keep these in sync with their real
  // sources of truth:
  FLOAT_FEE_MO:    25.00,     // FlexPay monthly fee — matches FLEXPAY_MONTHLY_FEE (services/flexpay.ts, S562: flat $25). Was 20 (stale).
  REINSTATEMENT:   25.00,     // After FlexDeposit default
  BG_CHECK_NET:     5.00,     // GAM's NET margin per background check — matches SCREENING_GAM_MARGIN_USD ($5). Applicant pays Checkr cost + $5 + processing (pass-through). Was 15 (stale — old model).

  // S536 (Nic): ALL money flows through GAM — business charges are
  // platform DESTINATION charges (GAM = merchant of record; gross
  // routes to the business's Connect balance; GAM keeps the
  // application fee below and pays Stripe's processing cost out of
  // it; businesses get Friday-batched payouts like landlords).
  // Card-present: fee 2.9% + 10¢, Stripe costs ~2.7% + 5¢ → GAM nets
  // ~0.2% + 5¢. Hosted invoice (card or ACH): fee 3.25% + 30¢, worst
  // Stripe cost (card) 2.9% + 30¢ → GAM nets ≥0.35%.
  BUSINESS_TERMINAL_APP_FEE_PCT:         0.029,  // card-present, % of sale
  BUSINESS_TERMINAL_APP_FEE_FIXED_CENTS: 10,     // card-present, fixed
  BUSINESS_INVOICE_APP_FEE_PCT:          0.0325, // hosted invoice, % of amount
  BUSINESS_INVOICE_APP_FEE_FIXED_CENTS:  30,     // hosted invoice, fixed
  // S536 (Nic): register is FREE; invoicing = $10/mo in any month the
  // business sends ≥1 invoice (usage-based). jobs/businessMonthlyFees.
  BUSINESS_INVOICING_MONTHLY:            10.00,
  MAINTENANCE_PCT: 0.05,      // 5% of job value — DEFERRED contractor-bid marketplace (Nic, S585).
                              // Model: landlords post jobs to a board; outside contractors BID
                              // directly on them; the winning contractor gives up 5% of the job
                              // price for GAM coordinating the event. This is NOT an Angi-style
                              // pay-for-leads model. NOT built + NOT billed today — landlords do
                              // in-house maintenance or contract their own outside sources. The
                              // fee is only pre-computed + stored (hidden); never charged to the
                              // landlord, who pays only actual maintenance cost. Off all surfaces.
  DEPOSIT_XFER:    15.00,     // Deposit transfer between GAM properties
} as const

// Live launch platform-fee model (S113 pricing). The PLATFORM_FEES
// ACTIVE_UNIT (15) / DIRECT_PAY_UNIT (5) tiers above are the pre-launch
// model still referenced by the admin income calc + reserve math; the
// LIVE landlord-facing fee is a flat $2 per OCCUPIED unit (vacant units
// free) with a $10/property monthly minimum. The landlord Dashboard +
// Settings already show these numbers; this is their single source so
// Reports (S512 #20) reconciles. Retiring ACTIVE_UNIT/DIRECT_PAY_UNIT in
// the admin income calc is tracked as walkthrough #34 (backend TODO).
export const LAUNCH_PLATFORM_FEE = {
  PER_OCCUPIED_UNIT: 2.00,
  PROPERTY_MIN_MO:   10.00,
  VACANT_UNIT:       0.00,
} as const

// No-double-bill onboarding grace (Nic, S600): a new landlord isn't charged the
// platform fee until they GO LIVE — the first rent settled through GAM (they're
// operating) — OR the grace cap, whichever is first. Setup + preview is free, so a
// switcher never pays two platforms for the same month. The cap is counted in
// BILLING CYCLES, not floating days, so it can never bleed into a third free cycle
// regardless of signup date: the signup (partial) cycle + this many full cycles are
// free, then billing begins the next cycle boundary. 2 → ~31–61 raw days (targets
// ~45 for a mid-month switcher; ~60-day natural ceiling). Public copy states the
// PRINCIPLE only, never this number. The stored per-landlord billing_grace_until is
// overridable (superadmin) when a large-portfolio setup runs long.
export const PLATFORM_FEE_GRACE_CYCLES = 2

// W-32 (S531, Nic-set): user-facing INSTANT withdrawal fee — 2% of the
// withdrawn amount, $5 minimum, all-in. Stripe's instant-payout cost
// (1.5%, min $0.50) comes out of this; GAM nets the spread via an
// account-debit transfer at payout time (routes/withdrawals.ts). Standard
// on-demand withdrawals stay free.
export const INSTANT_WITHDRAWAL_FEE = {
  PCT:     0.02,
  MIN_USD: 5.00,
} as const

// Portfolio-manager commission (S567). Per OCCUPIED unit/month:
//   - CLOSING 25¢ + SERVICE 25¢ = the closing agent's $0.50 recurring
//     commission, forever while the landlord stays on the platform. Closing and
//     customer service are the SAME agent — NOT splittable — EXCEPT a
//     self-closed landlord (organic signup, no closer):
//       * closing 25¢ → POT (orphaned, nobody closed it)
//       * service 25¢ → a customer-service-specialist PM who opts to take it,
//         or POT if none
//   - POT_ALWAYS 10¢ → the shared pot, EVERY occupied unit, EVERY month, no
//     matter the situation. This is NOT commission.
// The pot therefore = the always-10¢ + any orphaned closing/service 25¢ halves.
// Source of truth for jobs/commissionAccrual.ts + every admin comp surface.
export const COMMISSION_ROLES = ['closing', 'service', 'pot'] as const
export type CommissionRole = typeof COMMISSION_ROLES[number]
export const PORTFOLIO_COMMISSION = {
  CLOSING:    0.25, // → closing agent, or pot when self-closed
  SERVICE:    0.25, // → the same closing agent; a CS specialist or pot only when self-closed
  POT_ALWAYS: 0.10, // → pot, always (not commission)
  CLOSER_TOTAL: 0.50, // CLOSING + SERVICE — what one closing agent earns per occupied unit/mo
} as const
export const COMMISSION_ROLE_LABEL: Record<CommissionRole, string> = {
  closing: 'Closing',
  service: 'Customer Service',
  pot:     'Pot (platform)',
}

/**
 * Monthly GAM platform fee for one property under the live model:
 * $2 × occupied units, floored at the $10 PER-PROPERTY MINIMUM — full stop.
 * Every property is charged at least $10/month whether or not any unit is
 * occupied (the minimum is for having the property on the platform). Authoritative
 * per-property billing (incl. short-stay nights) lives in
 * services/platformFee.ts → platformFeesByProperty; this is the simple
 * occupied-unit form used where only an occupied count is known.
 */
export function launchPlatformFeeForProperty(occupiedUnits: number): number {
  return Math.max(occupiedUnits * LAUNCH_PLATFORM_FEE.PER_OCCUPIED_UNIT, LAUNCH_PLATFORM_FEE.PROPERTY_MIN_MO)
}

export const RESERVE_CONFIG = {
  PHASE1_MAX:      1000,
  PHASE1_RATE:     1.00,
  PHASE2_MAX:      5000,
  PHASE2_RATE:     0.30,
  PHASE3_RATE:     0.15,
  TARGET_MONTHS:   3,
  DEFAULT_RATE:    0.03,
} as const

// FlexDeposit tier matrix (S246; re-tiered S514 to the 2–6 range the live
// Consumer ToS § 9.1.1 discloses). Under the custody model GAM advances/
// floats NOTHING, so there is no GAM exposure to cap — the only thing that
// matters is tenant affordability. BIGGER deposits get MORE installments
// (they are the ones that need spreading); a small deposit is affordable in
// fewer payments.
//   $0 – $500      → 2 installments max
//   $501 – $1000   → 3 installments max
//   $1001 – $1500  → 4 installments max
//   $1501 – $2000  → 5 installments max
//   $2001+         → 6 installments max
// The risk_level from the Checkr BG report further constrains:
//   low risk      → max for the band
//   medium risk   → max − 1 (floor 2)
//   high+         → 2 only
export const FLEX_DEPOSIT_TIERS = [
  { maxDeposit: 500,     maxInstallments: 2 },
  { maxDeposit: 1000,    maxInstallments: 3 },
  { maxDeposit: 1500,    maxInstallments: 4 },
  { maxDeposit: 2000,    maxInstallments: 5 },
  { maxDeposit: Infinity, maxInstallments: 6 },
] as const

export const FLEX_DEPOSIT_CUSTODY_FEE = 3       // $/month while GAM holds the deposit in custody
// S565: FlexCredit (rent credit reporting) tenant subscription. Sell $5/mo;
// ~$1.50/enrollment goes to the provider (Esusu) with a ~$500/mo provider
// minimum → ~$3.50 GAM net/enrollment once past breakeven. FLEX_CREDIT_FEE is
// what the TENANT is billed; FLEX_CREDIT_PROVIDER_COST is GAM's per-enrollment
// cost to the provider (for net/COGS reporting — the actual Esusu payout is an
// external integration, not wired yet).
export const FLEX_CREDIT_FEE = 5
export const FLEX_CREDIT_PROVIDER_COST = 1.5
export const FLEX_CREDIT_PROVIDER_MIN_MONTHLY = 500
// S514: the 60-day NSF cooldown was removed with the advance/default model.
// Under the custody model (Consumer ToS § 9.1.5) a missed installment only
// leaves the deposit under-funded; re-enrollment restriction is "until
// current," not a fixed cooldown. See getFlexDepositEligibility.

// FlexCharge (S252+). Consolidated POS charge-account with a monthly
// statement. S583 (Nic) revenue/structure model:
//  - GAM charges the MERCHANT a flat 1.5% SUBSCRIPTION on the cycle
//    credit VOLUME (the purchase balance) — deducted from the merchant's
//    payout, NEVER added to the borrower's statement. Flat % of volume,
//    not APY/interest → GAM is the software vendor, not the lender.
//  - The MERCHANT (the lender) may set their OWN finance charge, a flat
//    per-statement % of the balance, capped at FLEX_CHARGE_MAX_FINANCE_PCT.
//    The customer pays balance + that finance charge; the merchant keeps it
//    (minus GAM's 1.5%). Merchants must set a rate compliant with their
//    local usury / retail-installment law (no state logic baked in).
export const FLEX_CHARGE_STATEMENT_FEE_PCT = 0.015
// Hard cap on the merchant-set finance charge — an ANNUAL APR (S583 revolving
// model). Mirrored by a CHECK on properties.flex_charge_finance_pct. 6%/YEAR is
// under every state usury cap; the merchant is the lender and sets a compliant APR.
export const FLEX_CHARGE_MAX_FINANCE_PCT = 0.06
// S583 revolving-credit terms (see REVOLVING_CREDIT_SPEC.md).
// Minimum payment each cycle = greater of the floor or MIN_PAYMENT_PCT × balance.
export const FLEX_CHARGE_MIN_PAYMENT_PCT = 0.03
export const FLEX_CHARGE_MIN_PAYMENT_FLOOR = 25
// Flat late fee when the customer pays less than the minimum by the due date.
// $10/mo is simple and legal everywhere.
export const FLEX_CHARGE_LATE_FEE = 10
export const FLEX_CHARGE_DEFAULT_CREDIT_LIMIT = 500
export const FLEX_CHARGE_ACCOUNT_STATUSES = ['active', 'suspended', 'disqualified'] as const
export type FlexChargeAccountStatus = typeof FLEX_CHARGE_ACCOUNT_STATUSES[number]
export const FLEX_CHARGE_TRANSACTION_STATUSES = ['pending', 'billed', 'paid', 'disputed', 'refunded'] as const
export type FlexChargeTransactionStatus = typeof FLEX_CHARGE_TRANSACTION_STATUSES[number]
export const FLEX_CHARGE_STATEMENT_STATUSES = ['open', 'billed', 'paid', 'failed', 'voided'] as const
export type FlexChargeStatementStatus = typeof FLEX_CHARGE_STATEMENT_STATUSES[number]

// ACH return codes with zero-tolerance flag
// S124: extended ACH return code classification with NACHA-compliant
// retryability. NACHA permits up to 2 retries per failed transaction, but
// only on certain return codes — account-related failures (closed,
// invalid, no account) are NOT retry-eligible because retrying won't
// change the outcome. Zero-tolerance codes obviously can't retry.
export const ACH_RETURN_CONFIG: Record<string, { zeroTolerance: boolean; retryEligible: boolean; description: string }> = {
  R05: { zeroTolerance: true,  retryEligible: false, description: 'Unauthorized debit to consumer account' },
  R07: { zeroTolerance: true,  retryEligible: false, description: 'Authorization revoked by customer' },
  R10: { zeroTolerance: true,  retryEligible: false, description: 'Customer advises not authorized' },
  R29: { zeroTolerance: true,  retryEligible: false, description: 'Corporate customer advises not authorized' },
  R01: { zeroTolerance: false, retryEligible: true,  description: 'Insufficient funds' },
  R09: { zeroTolerance: false, retryEligible: true,  description: 'Uncollected funds' },
  R02: { zeroTolerance: false, retryEligible: false, description: 'Account closed' },
  R03: { zeroTolerance: false, retryEligible: false, description: 'No account / unable to locate' },
  R04: { zeroTolerance: false, retryEligible: false, description: 'Invalid account number' },
}

// ── UTILITY FUNCTIONS ──────────────────────────────────────

export function calcStripePerUnit(rentAmount: number) {
  const ach     = Math.min(rentAmount * STRIPE_CONFIG.ACH_RATE, STRIPE_CONFIG.ACH_CAP)
  const payout  = rentAmount * STRIPE_CONFIG.PAYOUT_RATE + STRIPE_CONFIG.PAYOUT_FLAT
  const connect = STRIPE_CONFIG.CONNECT_ACCT_MO / 50 // avg 50 units per landlord
  return { ach, payout, connect, total: ach + payout + connect }
}

export function calcNetPerUnit(rentAmount: number, reserveRate: number) {
  const stripe = calcStripePerUnit(rentAmount)
  // S561: retired the stale pre-launch $15 tier (PLATFORM_FEES.ACTIVE_UNIT).
  // The live landlord fee is the flat $2/occupied-unit launch model, so reserve
  // + admin-income math must use it (walkthrough #34).
  const gross  = LAUNCH_PLATFORM_FEE.PER_OCCUPIED_UNIT
  const netBR  = gross - stripe.total
  const reserve = netBR * reserveRate
  return { gross, stripe: stripe.total, netBR, reserve, netKept: netBR - reserve }
}

export function getReservePhase(occupiedUnits: number): { phase: 1|2|3; rate: number } {
  if (occupiedUnits <= RESERVE_CONFIG.PHASE1_MAX) return { phase: 1, rate: RESERVE_CONFIG.PHASE1_RATE }
  if (occupiedUnits <= RESERVE_CONFIG.PHASE2_MAX) return { phase: 2, rate: RESERVE_CONFIG.PHASE2_RATE }
  return { phase: 3, rate: RESERVE_CONFIG.PHASE3_RATE }
}

/**
 * S246: max installments allowed given a deposit amount and the
 * tenant's Checkr BG risk_level. Returns NULL if the tenant has no
 * BG result or risk_level is unknown — UI surfaces a "background
 * check pending / required" state in that case. Tier floor is 2
 * installments regardless of risk.
 */
export type FlexDepositRiskLevel = 'low' | 'medium' | 'high' | 'very_high'

export function getFlexDepositMaxInstallments(
  depositAmount: number,
  riskLevel: FlexDepositRiskLevel | null | undefined,
): number | null {
  if (!riskLevel) return null
  const band = FLEX_DEPOSIT_TIERS.find(t => depositAmount <= t.maxDeposit) ?? FLEX_DEPOSIT_TIERS[FLEX_DEPOSIT_TIERS.length - 1]
  const downgrade = riskLevel === 'low' ? 0 : riskLevel === 'medium' ? 1 : 99
  return Math.max(2, band.maxInstallments - downgrade)
}

/** Backwards-compatible shim — returns the band's max-installment
 *  number assuming low-risk tenant. Used only by pre-S246 callers
 *  that don't have a risk_level in hand. New code should call
 *  getFlexDepositMaxInstallments instead. */
export function getFlexDepositTier(depositAmount: number) {
  const band = FLEX_DEPOSIT_TIERS.find(t => depositAmount <= t.maxDeposit) ?? FLEX_DEPOSIT_TIERS[FLEX_DEPOSIT_TIERS.length - 1]
  return { maxDeposit: band.maxDeposit, installments: band.maxInstallments }
}

export function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount)
}



// === S25: businessDay + paymentAllocation re-exports ===
export * from './businessDay'
// === S617: one definition of how fast an agent reads and types ===
export * from './chatCadence'
export * from './paymentAllocation'
export * from './camelize'
export * from './versionWatch'
export * from './autoPlaceEstimate'

// ============================================================
// S26a: Invoice types
// ============================================================

export const INVOICE_STATUSES = ['pending', 'partial', 'settled', 'void'] as const
export type InvoiceStatus = typeof INVOICE_STATUSES[number]

// S75: payment-flow enums centralized for Item 18 Batch 4. Single source of
// truth for payments.{status,type,entry_description}, disbursements.{status,
// trigger_type}, and security_deposits.{held_by,status} CHECKs.

// S180: 'paid_via_deposit' added for the move-out deposit sweep.
// Distinct from 'settled' (real money in) and 'failed' (still owed).
export const PAYMENT_STATUSES = ['pending', 'processing', 'settled', 'failed', 'returned', 'paid_via_deposit'] as const
export type PaymentStatus = typeof PAYMENT_STATUSES[number]

// S568: 'home_payment' = amortized financed-home-sale installment (routes to the
// landlord/seller like rent; billed as its own line, auto-stops at term). Kept
// separate from 'rent' so rent late-fee/eviction/idempotency logic never applies.
export const PAYMENT_TYPES = ['rent', 'fee', 'deposit', 'utility', 'float_fee', 'late_fee', 'platform_fee', 'home_payment'] as const
export type PaymentType = typeof PAYMENT_TYPES[number]

// NACHA CCD/PPD entry description field — uppercase, max 10 chars per spec.
// S561: 'RETURNFEE' (9 chars) added for the pass-through Stripe reversal fee
// ($4 ACH / $15 card) billed to the tenant on a post-settlement reversal.
// S562: 'MANUALPAY' (9 chars) for the $10 manual-payment fee; 'FLEXPAY' added
// to close a long-standing drift (the DB CHECK always carried it).
// S583: 'FCPAYDOWN' — a customer FlexCharge revolving-balance pay-down.
// S603: 'DECLINEFEE' (10 chars — the NACHA field limit exactly) for the flat
// $1.00 declined-card-attempt fee. Distinct from RETURNFEE: that one covers a
// payment that SETTLED then reversed; this one covers a payment the bank refused
// outright. See CARD_DECLINE_FEE below.
// S605: 'BALANCE' — arrears carried in from the landlord's previous system.
// Its own descriptor rather than 'RENT': this is what the tenant sees on their
// bank statement, and a debt they recognise as an old balance should not appear
// as a rent charge they might read as a duplicate.
export const PAYMENT_ENTRY_DESCRIPTIONS = ['RENT', 'SUBSCRIP', 'DEPOSIT', 'UTILITY', 'ONTIMEPAY', 'LATEFEE', 'FLEXPAY', 'PROPANE', 'RETURNFEE', 'MANUALPAY', 'HOMEPMT', 'FCPAYDOWN', 'DECLINEFEE', 'BALANCE'] as const
export type PaymentEntryDescription = typeof PAYMENT_ENTRY_DESCRIPTIONS[number]

// S562: manual (off-platform) rent payment recording. A landlord/staff records
// receipt of cash/check/money-order; the rent row is marked settled with
// platform_held=false (GAM disburses nothing — the landlord already holds the
// cash). Each manual payment carries a flat fee EXCEPT the tenant's first rent
// payment on the lease (waived to give them time to onboard ACH). The fee is
// GAM revenue (a tenant-owed type='fee' row, entry_description 'MANUALPAY').
export const MANUAL_PAYMENT_METHODS = ['cash', 'check', 'money_order'] as const
export type ManualPaymentMethod = typeof MANUAL_PAYMENT_METHODS[number]
export const MANUAL_PAYMENT_METHOD_LABELS: Record<ManualPaymentMethod, string> = {
  cash: 'Cash',
  // S607 (Nic): a cashier's check is a CHECK. Deliberately NOT its own value —
  // the fee is for a payment handled and recorded BY HAND, not for the paper it
  // arrived on, so splitting instruments would create work with no difference in
  // outcome and simply move the argument to the next one (certified check, bank
  // draft, traveller's cheque). The label names the common variants instead, so
  // "it doesn't say cashier's check" is not an argument anyone can make.
  check: 'Check (incl. cashier\'s or certified)',
  money_order: 'Money order',
}
export const MANUAL_PAYMENT_FEE = 10.00

/** S607 (Nic): the ONE description of what the manual-payment fee covers, so no
 *  surface can quietly disagree with another. Category first, examples second,
 *  explicitly open-ended — the fee attaches to how the payment is handled, never
 *  to which instrument it happens to be. */
export const MANUAL_PAYMENT_FEE_SCOPE =
  'any payment handed to the office instead of made in the app — cash, a personal, ' +
  'cashier\'s or certified check, a money order, or a bank draft'

// S603 (Nic): flat $1.00 fee on a DECLINED CARD ATTEMPT (entry_description
// 'DECLINEFEE'). Stripe bills GAM per AUTHORIZATION, not per successful payment,
// so a decline costs $0.28 ($0.26 per-auth + $0.02 Radar) with no revenue against
// it — and the identical $0.28 is spent every time a card is saved or re-saved
// after being lost, stolen, or reissued. The ~$0.72 surplus over the decline's own
// cost funds those save authorizations, which is what lets GAM keep card-on-file
// (and therefore autopay) enabled instead of dropping it to stop the bleed.
//
// This is a FLAT FEE, not a pass-through — do NOT describe it to a tenant as
// "our cost" or "passed through at cost" (the $4 ACH return fee is roughly at
// cost; this one is not). Tenant-facing wording: "declined-payment fee".
//
// CARD ONLY. ACH keeps its own $4.00 return fee (FLEXPAY_ACH_RETURN_FEE).
export const CARD_DECLINE_FEE = 1.00

// S568 (Nic): the onboarding-transition "prior arrangement" settlement. During
// a landlord's move onto GAM, an IMPORTED tenant may have already paid the FIRST
// period's rent through the prior software/arrangement, off-platform. The
// landlord marks that first invoice as paid via prior arrangement — it comes off
// the books, NO money moves, NO manual-payment fee. Gating (route-enforced):
// FIRST rent charge only, lease_source='imported' only, within
// PRIOR_ARRANGEMENT_TRANSITION_DAYS of onboarding. Not a general cash method —
// it is its own `payments.manual_method` value, kept out of MANUAL_PAYMENT_METHODS.
export const PRIOR_ARRANGEMENT_METHOD = 'prior_arrangement' as const
export const PRIOR_ARRANGEMENT_TRANSITION_DAYS = 21

// Friendly labels for NACHA entry-description codes shown to tenants (no raw
// enums in the UI). Codes that just restate the payment type (RENT/DEPOSIT/…)
// are omitted — callers already hide those; only the fee-style codes need a
// human name. `humanizeEntryDescription` falls back to the raw code.
export const PAYMENT_ENTRY_DESCRIPTION_LABELS: Partial<Record<PaymentEntryDescription, string>> = {
  LATEFEE:    'Late fee',
  RETURNFEE:  'Returned-payment fee',
  MANUALPAY:  'Manual-payment fee',
  DECLINEFEE: 'Declined-payment fee',
  ONTIMEPAY: 'On-time pay',
  FLEXPAY:   'FlexPay',
  HOMEPMT:   'Home payment',
}

// S568: financed home-sale contract lifecycle.
export const HOME_SALE_STATUSES = ['active', 'paid_off', 'cancelled'] as const
export type HomeSaleStatus = typeof HOME_SALE_STATUSES[number]

// S594: how the landlord→tenant sale installments are shaped. 'amortized' =
// classic price + interest + term (principal/interest split). 'flat' = a plain
// recurring charge ($X × N payments, no interest) that auto-ends after N — the
// "recurring invoice that ends after a set number of payments" model.
export const HOME_SALE_PLAN_TYPES = ['amortized', 'flat'] as const
export type HomeSalePlanType = typeof HOME_SALE_PLAN_TYPES[number]
export const HOME_SALE_PLAN_TYPE_LABEL: Record<HomeSalePlanType, string> = {
  amortized: 'Amortized (price + interest)',
  flat: 'Flat monthly',
}

// Level-payment amortization for a financed home/RV sale. Returns the monthly
// payment and a per-installment principal/interest/balance schedule. The final
// installment absorbs rounding so the ending balance is exactly 0. rate is an
// ANNUAL percent (e.g. 7.5). termMonths > 0. Zero-interest → equal principal.
export interface AmortizationRow {
  installmentNumber: number
  amount: number
  principalPortion: number
  interestPortion: number
  remainingBalance: number
}
export function computeAmortization(financedAmount: number, annualRatePercent: number, termMonths: number): {
  monthlyPayment: number
  schedule: AmortizationRow[]
} {
  const P = Math.round(financedAmount * 100) / 100
  const n = Math.max(1, Math.floor(termMonths))
  const r = (annualRatePercent / 100) / 12
  const round2 = (x: number) => Math.round(x * 100) / 100

  let monthlyPayment: number
  if (r === 0) {
    monthlyPayment = round2(P / n)
  } else {
    monthlyPayment = round2((P * r) / (1 - Math.pow(1 + r, -n)))
  }

  const schedule: AmortizationRow[] = []
  let balance = P
  for (let i = 1; i <= n; i++) {
    const interest = round2(balance * r)
    let principal = round2(monthlyPayment - interest)
    let amount = monthlyPayment
    // Final installment: pay off whatever principal remains (absorb rounding).
    if (i === n) {
      principal = round2(balance)
      amount = round2(principal + interest)
    }
    balance = round2(balance - principal)
    if (balance < 0) balance = 0
    schedule.push({
      installmentNumber: i,
      amount,
      principalPortion: principal,
      interestPortion: interest,
      remainingBalance: balance,
    })
  }
  return { monthlyPayment, schedule }
}
export function humanizeEntryDescription(code: string): string {
  return PAYMENT_ENTRY_DESCRIPTION_LABELS[code as PaymentEntryDescription] ?? code
}

/**
 * S607 (Nic) — what a charge should be CALLED on a tenant's bill.
 *
 * entry_description is a NACHA transaction code ('SUBSCRIP', 'RENT'), useful to
 * a bank and meaningless to a person. Every landlord-billed charge already
 * carries the landlord's own wording in `notes`, stamped by
 * createLeaseFeePayment as "admin-billed: <type> — <description>". Showing the
 * bank code instead was fine while every fee was a known kind; it stops being
 * fine the moment a landlord can post "Parking violation — gate arm" as a
 * one-off, which is exactly the charge a tenant will ring up about.
 *
 * Falls back to the humanised code whenever there is no landlord wording, so
 * rent, late fees and everything predating this read exactly as before.
 */
export function chargeLabel(entryDescription?: string | null, notes?: string | null): string {
  const m = notes ? /^[a-z]+-billed:\s*[a-z_]+\s*—\s*(.+)$/i.exec(notes.trim()) : null
  const landlordWording = m?.[1]?.trim()
  if (landlordWording) return landlordWording
  return humanizeEntryDescription(entryDescription ?? '')
}

export const DISBURSEMENT_STATUSES = ['pending', 'processing', 'settled', 'failed'] as const
export type DisbursementStatus = typeof DISBURSEMENT_STATUSES[number]

// trigger_type is nullable in DB; null = legacy row pre-S64.
// 'otp_legacy' is reserved for the pre-16a OTP cycle and isn't actively
// written under the current model — kept in the union to match DB CHECK.
export const DISBURSEMENT_TRIGGER_TYPES = ['auto_friday', 'manual_on_demand', 'otp_legacy'] as const
export type DisbursementTriggerType = typeof DISBURSEMENT_TRIGGER_TYPES[number]

// Note: distinct from properties.deposit_handling_mode (which uses
// 'landlord_held'). security_deposits.held_by uses bare 'landlord'.
// Both centralizations exist and are NOT interchangeable.
export const SECURITY_DEPOSIT_HELD_BY_VALUES = ['gam_escrow', 'landlord'] as const
export type SecurityDepositHeldBy = typeof SECURITY_DEPOSIT_HELD_BY_VALUES[number]

export const SECURITY_DEPOSIT_STATUSES = ['pending', 'funded', 'partial', 'disbursed', 'claimed'] as const
export type SecurityDepositStatus = typeof SECURITY_DEPOSIT_STATUSES[number]

// ── PM (third-party property-management) companies — S108 ────────────────
// Distinct from the OWNER's in-house property managers (those live in
// property_manager_scopes). pm_companies are external orgs that contract
// with owners, employ multiple staff, take a fee cut from rent collections,
// and need their own dispatch + visibility surface.

export const PM_COMPANY_STATUSES = ['active', 'inactive', 'suspended'] as const
export type PmCompanyStatus = typeof PM_COMPANY_STATUSES[number]

// Internal-to-the-PM-org role. Distinct from the platform-level user role
// (which stays 'pm_staff' or whatever the auth role becomes — TBD product
// call). 'owner' = founder/admin of the PM org, can manage staff + plans.
// 'manager' = can assign properties + view all reports. 'staff' = view
// limited to assigned properties; can act on maintenance, etc.
export const PM_STAFF_ROLES = ['owner', 'manager', 'staff'] as const
export type PmStaffRole = typeof PM_STAFF_ROLES[number]

export const PM_STAFF_STATUSES = ['active', 'inactive', 'removed'] as const
export type PmStaffStatus = typeof PM_STAFF_STATUSES[number]

// Fee-cut taxonomy. Mirrors the per-property allocation rule shapes from
// 16a (DEFERRED.md item 16a) so a pm_fee_plan composes cleanly with the
// allocation engine when S109 wires the cut.
//   percent_of_rent     — % of collected rent each month
//   flat_monthly        — fixed dollar amount each month per property
//   percent_with_floor  — % of rent, but never less than floor_amount
//   percent_with_ceiling— % of rent, but never more than ceiling_amount
//   per_unit            — fixed dollar amount per occupied unit per month
//   leasing_fee         — one-time on new lease signed
//   maintenance_markup_pct — % added on top of vendor invoices
export const PM_FEE_TYPES = [
  'percent_of_rent',
  'flat_monthly',
  'percent_with_floor',
  'percent_with_ceiling',
  'per_unit',
  'leasing_fee',
  'maintenance_markup_pct',
] as const
export type PmFeeType = typeof PM_FEE_TYPES[number]

export const PM_FEE_PLAN_STATUSES = ['active', 'inactive', 'deprecated'] as const
export type PmFeePlanStatus = typeof PM_FEE_PLAN_STATUSES[number]

// S157: pm_property_invitations — bidirectional consent handshake before
// a property's pm_company_id flips from null to a real assignment.
//   owner_to_pm — owner offers a PM company management of property X
//   pm_to_owner — PM company invites owner to view/connect property X
export const PM_PROPERTY_INVITE_DIRECTIONS = ['owner_to_pm', 'pm_to_owner'] as const
export type PmPropertyInviteDirection = typeof PM_PROPERTY_INVITE_DIRECTIONS[number]

// pm_property_invitations.status flow:
//   pending → accepted (recipient approves; properties.pm_company_id is set)
//   pending → rejected (recipient declines with optional reason)
//   pending → expired  (cron sweeps when expires_at passes)
//   pending → revoked  (sender pulls back before action)
export const PM_PROPERTY_INVITE_STATUSES = [
  'pending', 'accepted', 'rejected', 'expired', 'revoked',
] as const
export type PmPropertyInviteStatus = typeof PM_PROPERTY_INVITE_STATUSES[number]

// pm_property_invitations.proposed_scope — the rights the linkage grants
// the PM company over the property.
//   manage — full management; pm_company_id + pm_fee_plan_id wired into
//     allocation, maintenance routing, owner views the cut
//   view   — PM owner-relationship side of the handshake (PM was hired
//     off-platform; owner is just exposing the property to GAM via the PM)
export const PM_LINK_SCOPES = ['manage', 'view'] as const
export type PmLinkScope = typeof PM_LINK_SCOPES[number]

export interface Invoice {
  id: string
  landlord_id: string
  tenant_id: string | null
  lease_id: string
  unit_id: string
  invoice_number: string
  due_date: string  // YYYY-MM-DD
  subtotal_rent: string       // numeric -> string from pg
  subtotal_fees: string
  subtotal_utilities: string
  subtotal_deposits: string
  subtotal_late_fees: string
  total_amount: string
  status: InvoiceStatus
  sent_at: string | null
  viewed_at: string | null
  pdf_url: string | null
  notes: string | null
  created_at: string
  updated_at: string
}

/**
 * Format an invoice number from its year + sequence number.
 * Format: INV-YYYY-NNNNN (5-digit zero-padded sequence).
 * Example: formatInvoiceNumber(2026, 42) === 'INV-2026-00042'
 */
export function formatInvoiceNumber(year: number, sequence: number): string {
  return `INV-${year}-${String(sequence).padStart(5, '0')}`
}

export * from './lateFees';
export * from './autopaySchedule';

// ============================================================================
// Pending tenant intent parser types (S29c-2-A backend, S29c-2-B UI)
//
// Single source of truth for parser_status, parser flag categories, and
// parser flag severities. DB CHECK constraints, API validators, and UI
// rendering all import from here. Adding a value = edit one place.
//
// ParserOutput defines the shape the parser must produce. The parser plugs
// in later (S29c-2-C+); this contract is locked now so UI can render against
// it without waiting on the parser.
// ============================================================================

export const PARSER_STATUSES = [
  'not_uploaded',
  'parsing',
  'parsed',
  'mismatch',
  'error',
  'resolved',
] as const
export type ParserStatus = typeof PARSER_STATUSES[number]

export const PARSER_STATUS_META: Record<ParserStatus, { label: string; tone: 'muted'|'amber'|'green'|'red'|'gold'; description: string }> = {
  not_uploaded: { label: 'No document',     tone: 'muted', description: 'Lease PDF not yet uploaded.' },
  parsing:      { label: 'Parsing',         tone: 'amber', description: 'Parser is reading the document.' },
  parsed:       { label: 'Ready to review', tone: 'green', description: 'Parser finished cleanly. Confirm and build the lease.' },
  mismatch:     { label: 'Needs attention', tone: 'amber', description: 'Parser flagged issues that require landlord review.' },
  error:        { label: 'Parse failed',    tone: 'red',   description: 'Parser could not read the document. Re-upload or fix.' },
  resolved:     { label: 'Onboarded',       tone: 'gold',  description: 'Lease created. This intent is closed.' },
}

export const PARSER_FLAG_CATEGORIES = [
  'identity_mismatch',
  'unit_not_found',
  'field_missing',
  'field_suspect',
  'field_low_confidence',
  'unattributed_amount',
] as const
export type ParserFlagCategory = typeof PARSER_FLAG_CATEGORIES[number]

export const PARSER_FLAG_CATEGORY_META: Record<ParserFlagCategory, { label: string; description: string }> = {
  identity_mismatch:    { label: 'Identity mismatch',    description: 'Tenant on the lease does not match the tenant landlord typed. Possible wrong file.' },
  unit_not_found:       { label: 'Unit not found',       description: 'Unit named on the lease is not in this landlord\'s portfolio.' },
  field_missing:        { label: 'Missing field',        description: 'Lease term could not be located in the document.' },
  field_suspect:        { label: 'Suspect value',        description: 'Lease term was extracted but the value looks wrong (zero rent, dates far in future, etc.).' },
  field_low_confidence: { label: 'Low confidence',       description: 'Parser is not confident in this extraction. Landlord should verify.' },
  unattributed_amount:  { label: 'Unrecognized dollar amount', description: 'The document mentions a dollar amount the parser could not attribute to any known charge — review the clause so no financial obligation is missed.' },
}

export const PARSER_FLAG_SEVERITIES = ['block', 'confirm'] as const
export type ParserFlagSeverity = typeof PARSER_FLAG_SEVERITIES[number]

// One extracted field: value plus parser's confidence and the raw text it saw.
// Generic so number / string / boolean fields share the same shape.
export type ParserExtractedField<T> = {
  value: T            // non-null by contract; if extraction failed, the whole field is null
  confidence: number   // 0..1; <0.7 typically triggers field_low_confidence
  rawText?: string     // verbatim text the parser pulled (for landlord audit)
}

// Single tenant party on a lease as extracted by the parser.
export type ParserExtractedTenant = {
  firstName: ParserExtractedField<string>
  lastName:  ParserExtractedField<string>
  email:     ParserExtractedField<string>
  phone:     ParserExtractedField<string>
  dateOfBirth?:     ParserExtractedField<string>   // ISO date
  mailingAddress?:  ParserExtractedField<string>
  identifications?:    ParserExtractedIdentification[]
  emergencyContacts?:  ParserExtractedEmergencyContact[]
  isPrimary?: boolean
}

// Unit identifier as extracted by the parser. Matches the resolveUnitFromPrefill
// strategy from S23c — propertyName + unitNumber, optionally a composed address.
export type ParserExtractedUnit = {
  propertyName:    ParserExtractedField<string>
  unitNumber:      ParserExtractedField<string>
  propertyAddress?: ParserExtractedField<string>
  unitType?:        ParserExtractedField<string>   // UNIT_TYPES value (apartment/single_family/rv_spot/mobile_home/storage/commercial)
}

// Lease terms as extracted by the parser. Field names match the existing
// CSV row shape so resolve-time mapping is trivial.
export type ParserExtractedLease = {
  leaseType:           ParserExtractedField<string>   // LEASE_TYPES value (month_to_month/fixed_term/nnn_commercial)
  leaseStart:          ParserExtractedField<string>   // ISO date
  leaseEnd:            ParserExtractedField<string>   // ISO date or null for m2m
  monthlyRent:         ParserExtractedField<number>
  securityDeposit:     ParserExtractedField<number>
  lateFeeAmount:       ParserExtractedField<number>
  lateFeeGraceDays:    ParserExtractedField<number>
  autoRenew:           ParserExtractedField<boolean>
  autoRenewMode:       ParserExtractedField<string>   // 'extend_same_term' | 'convert_to_month_to_month'
  noticeDaysRequired:  ParserExtractedField<number>
  subleasingAllowed?:  ParserExtractedField<string>   // SUBLEASING_POLICIES value
}

// S550: a conditional fee the parser detected — "if you don't do X (or do
// X), then $Y". Lease-is-law: only ever created from a clause that PRINTS in
// the document; conditionText carries that clause verbatim. Resolve-time
// logic writes these to lease_fees with condition_text set; they charge only
// when the move-out inspection assesses the condition as failed.
export type ParserExtractedConditionalFee = {
  label: string          // short human label, e.g. 'Carpet cleaning'
  amount: number
  conditionText: string  // the clause from the lease (verbatim, trimmed)
  confidence: number     // 0..1
  rawText: string
}

// Full parser output — written to pending_tenant_intents.parser_output (JSONB).
// Stored as-is; resolve-time logic reads from this shape.
export type ParserOutput = {
  tenants: ParserExtractedTenant[]
  unit:    ParserExtractedUnit
  lease:   ParserExtractedLease
  // Lease-attached entities. Each is optional — parser populates only
  // what it finds in the document. Resolve-time logic translates these
  // to rows in lease_vehicles / rvs / mobile_homes / lease_pets /
  // lease_occupants / liability_insurance_policies / subleases.
  vehicles?:            ParserExtractedVehicle[]
  rvs?:                 ParserExtractedRv[]
  mobileHome?:          ParserExtractedMobileHome
  pets?:                ParserExtractedPet[]
  additionalOccupants?: ParserExtractedOccupant[]
  liabilityInsurance?:  ParserExtractedLiabilityInsurance
  sublease?:            ParserExtractedSublease
  // S550: conditional fees ("if not X, then $Y") — written to lease_fees
  // with condition_text at resolve time; never auto-charged until assessed.
  conditionalFees?:     ParserExtractedConditionalFee[]
  // Catchall for fields the parser pulls out but we have not yet
  // promoted to typed columns. Written to leases.extraction_extras
  // (JSONB) at resolve time.
  extractionExtras?:    Record<string, unknown>
  parserVersion: string  // e.g. 'gam-parser-0.1.0' — pinned for audit
  parsedAt: string       // ISO timestamp
}

// One flag emitted by the parser. Written to pending_tenant_intents.parser_flags
// (JSONB array). UI groups by category, sorts by severity (block first).
export type ParserFlag = {
  category: ParserFlagCategory
  severity: ParserFlagSeverity
  field?: string         // dot-path into ParserOutput, e.g. 'lease.monthlyRent', 'tenants.0.email'
  message: string        // human-readable, surfaced directly to landlord
  expected?: string      // what landlord typed (for identity_mismatch / unit_not_found)
  found?: string         // what parser saw
}

// Runtime guards — used by API validators and frontend before write.
export const isParserStatus = (v: unknown): v is ParserStatus =>
  typeof v === 'string' && (PARSER_STATUSES as readonly string[]).includes(v)
export const isParserFlagCategory = (v: unknown): v is ParserFlagCategory =>
  typeof v === 'string' && (PARSER_FLAG_CATEGORIES as readonly string[]).includes(v)
export const isParserFlagSeverity = (v: unknown): v is ParserFlagSeverity =>
  typeof v === 'string' && (PARSER_FLAG_SEVERITIES as readonly string[]).includes(v)

// =====================================================================
// S29c-2-C: Onboarding Entity Types (April 28, 2026)
//
// New ParserExtracted* types for entities the parser pulls out of lease
// PDFs and writes to typed tables at resolve time. Const arrays mirror
// the DB CHECK constraints so frontend dropdowns and parser validation
// share one source of truth — drift = bug.
// =====================================================================

// Mirror of lease_vehicles.vehicle_type CHECK
export const VEHICLE_TYPES = [
  'car', 'truck', 'suv', 'van', 'motorcycle',
  'scooter', 'utility_trailer', 'boat', 'other',
] as const
export type VehicleType = typeof VEHICLE_TYPES[number]

// Mirror of lease_pets.species CHECK
export const PET_SPECIES = [
  'dog', 'cat', 'bird', 'reptile', 'fish',
  'small_mammal', 'livestock', 'other',
] as const
export type PetSpecies = typeof PET_SPECIES[number]

// Mirror of rvs.hookup_class CHECK
export const RV_HOOKUP_CLASSES = ['20amp', '30amp', '50amp', 'shore_only', 'none'] as const
export type RvHookupClass = typeof RV_HOOKUP_CLASSES[number]

// Mirror of tenant_identifications.id_type CHECK
export const ID_TYPES = [
  'drivers_license', 'state_id', 'passport',
  'military_id', 'tribal_id', 'permanent_resident_card', 'other',
] as const
export type IdType = typeof ID_TYPES[number]

// Mirror of leases.subleasing_allowed CHECK
export const SUBLEASING_POLICIES = ['prohibited', 'with_consent', 'allowed'] as const
export type SubleasingPolicy = typeof SUBLEASING_POLICIES[number]

// ---------------------------------------------------------------------
// Per-entity extracted shapes. Every field uses ParserExtractedField<T>
// so confidence and rawText are preserved per S29c-2-B contract.
// ---------------------------------------------------------------------

export type ParserExtractedVehicle = {
  vehicleType:    ParserExtractedField<string>   // VEHICLE_TYPES value
  year?:          ParserExtractedField<number>
  make?:          ParserExtractedField<string>
  model?:         ParserExtractedField<string>
  color?:         ParserExtractedField<string>
  licensePlate?:  ParserExtractedField<string>
  plateState?:    ParserExtractedField<string>
}

export type ParserExtractedRv = {
  year?:         ParserExtractedField<number>
  make?:         ParserExtractedField<string>
  model?:        ParserExtractedField<string>
  vin?:          ParserExtractedField<string>
  lengthFt?:     ParserExtractedField<number>
  numSlides?:    ParserExtractedField<number>
  hookupClass?:  ParserExtractedField<string>    // RV_HOOKUP_CLASSES value
  licensePlate?: ParserExtractedField<string>
  plateState?:   ParserExtractedField<string>
}

export type ParserExtractedMobileHome = {
  year?:             ParserExtractedField<number>
  make?:             ParserExtractedField<string>
  model?:            ParserExtractedField<string>
  serialNumber?:     ParserExtractedField<string>
  hudLabelNumber?:   ParserExtractedField<string>
  lengthFt?:         ParserExtractedField<number>
  widthFt?:          ParserExtractedField<number>
  manufacturedDate?: ParserExtractedField<string>  // ISO date
}

export type ParserExtractedPet = {
  name?:               ParserExtractedField<string>
  species:             ParserExtractedField<string>   // PET_SPECIES value
  breed?:              ParserExtractedField<string>
  color?:              ParserExtractedField<string>
  ageYears?:           ParserExtractedField<number>
  weightLbs?:          ParserExtractedField<number>
  isServiceAnimal?:    ParserExtractedField<boolean>
  isEmotionalSupport?: ParserExtractedField<boolean>
}

export type ParserExtractedOccupant = {
  fullName:                     ParserExtractedField<string>
  relationshipToPrimaryTenant?: ParserExtractedField<string>
  dateOfBirth?:                 ParserExtractedField<string>   // ISO date
  isMinor?:                     ParserExtractedField<boolean>
}

export type ParserExtractedIdentification = {
  idType:          ParserExtractedField<string>   // ID_TYPES value
  idNumber:        ParserExtractedField<string>
  issuingState?:   ParserExtractedField<string>   // USPS code for US-issued
  issuingCountry?: ParserExtractedField<string>   // defaults 'US' at write time
  expiryDate?:     ParserExtractedField<string>   // ISO date
}

export type ParserExtractedEmergencyContact = {
  name:          ParserExtractedField<string>
  phone?:        ParserExtractedField<string>
  email?:        ParserExtractedField<string>
  relationship?: ParserExtractedField<string>     // free text
}

export type ParserExtractedLiabilityInsurance = {
  carrierName?:  ParserExtractedField<string>
  policyNumber?: ParserExtractedField<string>
  expiryDate?:   ParserExtractedField<string>     // ISO date
}

// Sublease detection only — the full sublease subsystem (payment splitter,
// sublessor portal, sublease document parsing) is deferred. When the parser
// detects sublease language in the document, it sets `detected=true` and
// writes any sub-rent / dates it can find. Resolve does NOT auto-create a
// subleases row; landlord confirms before the sublease becomes real.
export type ParserExtractedSublease = {
  detected:           ParserExtractedField<boolean>
  subMonthlyAmount?:  ParserExtractedField<number>
  startDate?:         ParserExtractedField<string>  // ISO date
  endDate?:           ParserExtractedField<string>  // ISO date
}

// Runtime guards for the new const arrays.
export const isVehicleType = (v: unknown): v is VehicleType =>
  typeof v === 'string' && (VEHICLE_TYPES as readonly string[]).includes(v)
export const isPetSpecies = (v: unknown): v is PetSpecies =>
  typeof v === 'string' && (PET_SPECIES as readonly string[]).includes(v)
export const isRvHookupClass = (v: unknown): v is RvHookupClass =>
  typeof v === 'string' && (RV_HOOKUP_CLASSES as readonly string[]).includes(v)
export const isIdType = (v: unknown): v is IdType =>
  typeof v === 'string' && (ID_TYPES as readonly string[]).includes(v)
export const isSubleasingPolicy = (v: unknown): v is SubleasingPolicy =>
  typeof v === 'string' && (SUBLEASING_POLICIES as readonly string[]).includes(v)

// ── BACKGROUND CHECK SUBSYSTEM ────────────────────────────────
// Source of truth for the four CHECK constraints in
// 20260430204722_background_check_subsystem.sql. Any consumer that writes
// status values must validate against these arrays — do NOT inline.

export const BACKGROUND_CHECK_STATUSES = [
  'pending',
  'awaiting_applicant',
  'submitted',
  'processing',
  'complete',
  'failed',
  'cancelled',
  'approved',
  'denied',
  'expired',
] as const
export type BackgroundCheckStatus = typeof BACKGROUND_CHECK_STATUSES[number]
export const isBackgroundCheckStatus = (v: unknown): v is BackgroundCheckStatus =>
  typeof v === 'string' && (BACKGROUND_CHECK_STATUSES as readonly string[]).includes(v)

export const TENANT_BACKGROUND_CHECK_STATUSES = [
  'not_started',
  'submitted',
  'approved',
  'denied',
  'cancelled',
  'expired',
] as const
export type TenantBackgroundCheckStatus = typeof TENANT_BACKGROUND_CHECK_STATUSES[number]
export const isTenantBackgroundCheckStatus = (v: unknown): v is TenantBackgroundCheckStatus =>
  typeof v === 'string' && (TENANT_BACKGROUND_CHECK_STATUSES as readonly string[]).includes(v)

// S76: tenant onboarding provenance and platform-status enums.
// onboarding_source: 'applied' = walked in via public listing application;
//                    'onboarded' = added directly by landlord (CSV / invite).
// platform_status: gates ACH pulls + portal access. 'blocked' is a hard
// stop set by eviction-mode + return-code workflows.
export const TENANT_ONBOARDING_SOURCES = ['applied', 'onboarded'] as const
export type TenantOnboardingSource = typeof TENANT_ONBOARDING_SOURCES[number]

export const TENANT_PLATFORM_STATUSES = ['active', 'suspended', 'blocked'] as const
export type TenantPlatformStatus = typeof TENANT_PLATFORM_STATUSES[number]

export const APPLICATION_POOL_STATUSES = [
  'available',
  'matched',
  'inactive',
  'expired',
] as const
export type ApplicationPoolStatus = typeof APPLICATION_POOL_STATUSES[number]
export const isApplicationPoolStatus = (v: unknown): v is ApplicationPoolStatus =>
  typeof v === 'string' && (APPLICATION_POOL_STATUSES as readonly string[]).includes(v)

export const POOL_MATCH_STATUSES = [
  'pending',
  'interested',
  'not_interested',
  'report_purchased',
  'expired',
] as const
export type PoolMatchStatus = typeof POOL_MATCH_STATUSES[number]
export const isPoolMatchStatus = (v: unknown): v is PoolMatchStatus =>
  typeof v === 'string' && (POOL_MATCH_STATUSES as readonly string[]).includes(v)

export const BACKGROUND_RISK_LEVELS = ['low', 'medium', 'high', 'very_high'] as const
export type BackgroundRiskLevel = typeof BACKGROUND_RISK_LEVELS[number]
export const isBackgroundRiskLevel = (v: unknown): v is BackgroundRiskLevel =>
  typeof v === 'string' && (BACKGROUND_RISK_LEVELS as readonly string[]).includes(v)


// =============================================================================
// 16a allocation rules (S64) — single source of truth for property allocation
// =============================================================================

// S116: generic FEE_PAYER_VALUES — used by all three independent toggles
// (ach_fee_payer / card_fee_payer / platform_fee_payer) introduced at
// S114. Single union retained for ease of validation; the prior
// BANKING_FEE_PAYER_VALUES alias is kept for backward compat one cycle.
export const FEE_PAYER_VALUES = ['landlord', 'tenant'] as const
export type FeePayer = typeof FEE_PAYER_VALUES[number]

/** @deprecated S116 — use FEE_PAYER_VALUES instead. Will be removed once
 *  all callers update. */
export const BANKING_FEE_PAYER_VALUES = FEE_PAYER_VALUES
/** @deprecated S116 — use FeePayer instead. */
export type BankingFeePayer = FeePayer

export const PLACEMENT_FEE_TYPE_VALUES = ['flat', 'percent_of_first_month'] as const
export type PlacementFeeType = typeof PLACEMENT_FEE_TYPE_VALUES[number]

/**
 * Required payload on POST /api/properties.
 * banking_fee_payer is required; all PM fee fields optional (owner-self-managed
 * properties send all fees null).
 *
 * owner_bank_account_id (S66): optional bank account routing target. Snapshotted
 * onto each ledger row at allocation time. Multiple properties can share one
 * bank account — they collapse into a single Friday disbursement. NULL = no
 * routing yet; ledger rows still write but autoPayouts skips them.
 */
export interface AllocationRuleInput {
  banking_fee_payer: BankingFeePayer
  rent_percent?: number | null
  rent_percent_floor?: number | null
  rent_percent_ceiling?: number | null
  flat_monthly_fee?: number | null
  per_unit_fee?: number | null
  placement_fee_type?: PlacementFeeType | null
  placement_fee_value?: number | null
  maintenance_markup_percent?: number | null
  owner_bank_account_id?: string | null
}


// =============================================================================
// User bank accounts (S66) — per-user catalog, per-property routing
// =============================================================================

// =============================================================================
// Properties review status (S73) — admin moderation lifecycle
// =============================================================================

export const PROPERTY_REVIEW_STATUSES = ['active', 'pending_review', 'rejected'] as const
export type PropertyReviewStatus = typeof PROPERTY_REVIEW_STATUSES[number]


export const ACCOUNT_TYPE_VALUES = ['checking', 'savings'] as const
export type AccountType = typeof ACCOUNT_TYPE_VALUES[number]

export const ACCOUNT_HOLDER_TYPE_VALUES = ['individual', 'business'] as const
export type AccountHolderType = typeof ACCOUNT_HOLDER_TYPE_VALUES[number]

export const BANK_ACCOUNT_STATUS_VALUES = ['active', 'archived'] as const
export type BankAccountStatus = typeof BANK_ACCOUNT_STATUS_VALUES[number]

/**
 * POST /api/bank-accounts payload. routing_number + account_number raw on
 * the wire (TLS only); server encrypts at rest and only ever returns last4.
 */
export interface BankAccountInput {
  nickname: string
  account_holder_name: string
  account_holder_type: AccountHolderType
  account_type: AccountType
  routing_number: string
  account_number: string
}

/**
 * Returned by GET /api/bank-accounts. account_number_last4 is the only
 * representation of the account number ever sent to a client; full number
 * is decrypted server-side at payout fire time, never UI-bound.
 */
export interface BankAccountSummary {
  id: string
  nickname: string
  account_holder_name: string
  account_holder_type: AccountHolderType
  account_type: AccountType
  routing_number: string
  account_number_last4: string
  status: BankAccountStatus
  created_at: string
  updated_at: string
}

// ============================================================
// CREDIT LEDGER v1
// Hash-chained, Merkle-anchored event ledger spanning tenants,
// landlords, managers, and properties. Score is internal-only
// (gated to GAM lending services). See CREDIT_LEDGER_V1.md.
// ============================================================

export const CREDIT_SUBJECT_TYPES = ['tenant', 'landlord', 'manager', 'property'] as const
export type CreditSubjectType = typeof CREDIT_SUBJECT_TYPES[number]

// CreditEventType is the full v1 catalog. Forward-compat life-event
// types (utility_*, telecom_*, auto_loan_*, insurance_*, child_support_*,
// medical_*, subscription_*, bill_pay_*) are listed here so scoring
// values in the v1.0.0 formula seed have matching keys. They are not
// emitted in v1 — integrations land in v1.5 (Plaid Liabilities) and
// v2.0 (GAM bill-pay product).
//
// Inspection / entry-request / eviction event types are also listed:
// inspection workflow does not yet exist (build deferred); entry-request
// flow is being scoped; eviction events are landlord-self-attested
// in v1 via manual UI.
export const CREDIT_EVENT_TYPES = [
  // Payment events (auto-attested via Stripe webhooks)
  'payment_received_on_time',
  'payment_received_late_grace',
  'payment_received_late_minor',
  'payment_received_late_major',
  'payment_received_late_severe',
  'payment_failed_nsf',
  'payment_partial',
  'payment_skipped',
  'payment_refunded',

  // Lease events (auto-attested via e-sign)
  'lease_signed',
  'lease_renewed',
  'lease_modified',
  'lease_assigned',
  'lease_anniversary',
  'lease_terminated_natural',
  'lease_terminated_early_by_tenant',
  'lease_terminated_early_by_landlord',
  'lease_abandoned',
  'proper_notice_given_for_move_out',

  // Move-in / move-out (inspection workflow — deferred build)
  'move_in_inspection_completed',
  'move_out_inspection_completed',
  'move_out_condition_matches_move_in',
  'move_out_condition_damage_documented',
  'move_in_photos_submitted',
  'move_out_photos_submitted',
  'deposit_returned_full',
  'deposit_returned_partial',
  'deposit_returned_zero',
  'deposit_returned_within_state_window',
  'deposit_returned_late',
  'deposit_interest_paid',  // S193 — statutory interest settled at lease end
  'deposit_dispute_opened',
  'deposit_dispute_resolved_for_tenant',

  // Sublease lifecycle (S199). Recorded against the sublessor.
  // Sublessee gets their own scoring signal via the master payment
  // events when they pay their portion; these events capture the
  // sublessor's behavior in subletting.
  'sublease_requested',
  'sublease_approved',
  'sublease_denied',
  'sublease_completed_natural',     // ended at end_date as planned
  'sublease_terminated_early',      // ended before end_date by any party

  // S202: lease amendment via addendum (B1+B2 phase 2A). Recorded
  // against the tenant subject. event_data carries the field-by-
  // field diff so the tenant's lease history surfaces what changed.
  // Not scored in v1.0.0 — informational audit trail only.
  'lease_addendum_recorded',
  'unit_ready_on_move_in_date',
  'utilities_transferred_at_move_in',
  'renters_insurance_verified',

  // Maintenance + cooperation
  'maintenance_request_submitted',
  'maintenance_request_acknowledged',
  'maintenance_request_resolved',
  'maintenance_response_within_sla',
  'maintenance_response_24h',
  'maintenance_response_72h',
  'maintenance_response_breach_sla',
  'maintenance_resolution_confirmed',
  'repair_quality_held_30d',
  'recurring_repair_same_issue',
  'entry_request_made',
  'entry_request_granted_within_window',
  'entry_request_denied',
  'entry_compliance_breach',
  'proper_entry_notice_given',
  'habitability_complaint_unresolved_30d',

  // Conduct (manual attestation, evidence required)
  'noise_complaint_logged',
  'lease_violation_notice_issued',
  'lease_violation_cured',
  'recurring_lease_violation',
  'property_damage_event_documented',
  'nuisance_event_documented',
  'rent_increase_with_proper_notice',
  'rent_increase_without_proper_notice',

  // Eviction + balance (landlord-attested in v1 via manual UI)
  'eviction_notice_filed',
  'eviction_hearing_scheduled',
  'eviction_hearing_continued',
  'eviction_hearing_dismissed',
  'eviction_hearing_judgment_issued',
  'eviction_settled',
  'eviction_withdrawn',
  'tenant_moved_before_judgment',
  'tenancy_ended_with_balance',
  'balance_paid_post_move',
  'balance_sent_to_collections',
  'utility_balance_unpaid_at_move_out',

  // Network signals (cross-landlord)
  'multi_landlord_history_clean',

  // Self-attested
  'hardship_period_started',
  'hardship_period_ended',
  'hardship_context_added',
  'subject_added_event_context',

  // Dispute (system-recorded)
  'dispute_opened',
  'dispute_evidence_submitted',
  'dispute_resolved_upheld',
  'dispute_resolved_corrected',
  'dispute_resolved_no_change',

  // External life events — utility (v1.5+ Plaid/aggregator)
  'utility_payment_on_time',
  'utility_payment_late_grace',
  'utility_payment_late',
  'utility_payment_missed',
  'utility_disconnect_for_nonpayment',

  // External life events — telecom (v1.5+)
  'telecom_payment_on_time',
  'telecom_payment_missed',
  'telecom_disconnect_for_nonpayment',

  // External life events — auto loan (v1.5+)
  'auto_loan_payment_on_time',
  'auto_loan_payment_late_grace',
  'auto_loan_payment_late',
  'auto_loan_payment_missed',
  'auto_loan_default',

  // External life events — insurance (v1.5+)
  'insurance_premium_on_time',
  'insurance_lapsed_nonpayment',
  'insurance_lapsed_voluntary',

  // External life events — child support (v2+)
  'child_support_paid_on_time',
  'child_support_missed',
  'child_support_arrears',

  // External life events — medical (v1.5+)
  'medical_payment_plan_on_time',
  'medical_collections_event',

  // External life events — subscription (v1.5+)
  'subscription_payment_on_time',
  'subscription_canceled_nonpayment',

  // Bill-pay product (v2.0+)
  'bill_pay_payment_initiated',
  'bill_pay_payment_settled',
  'bill_pay_payment_failed',
  'bill_pay_account_linked',
  'bill_pay_account_unlinked',

  // External-account consent events (v1.5+ aggregator integrations)
  'external_data_consent_granted',
  'external_data_consent_revoked',

  // Reserved for v2+ (in enum, not emitted in v1 — kept here so future
  // event_data writers don't accidentally collide on a reserved name)
  'court_ruling_received',
  'police_report_filed',
  'police_report_outcome',
  'medical_event_attested',
  'bond_posted',
  'bond_released',
  'score_disclosed_to_third_party',
  'credential_shared_with_third_party',
  'biometric_anchor_established',
  'balance_settled_voluntarily',
  'balance_settled_via_partner',
  'balance_recovery_received',
  'settlement_offer_made',
  'settlement_offer_accepted',
  'settlement_offer_declined',
  'partial_payment_received_post_move',
  'partner_legal_action_initiated',
  'partner_judgment_obtained',
] as const
export type CreditEventType = typeof CREDIT_EVENT_TYPES[number]

export const CREDIT_ATTESTATION_SOURCES = [
  'gam_workflow_auto',
  'stripe_attested',
  'gam_bill_pay_attested',
  'plaid_attested',
  'aggregator_attested',
  'carrier_attested',
  'lender_attested',
  'partner_cra',
  'court_record',
  'police_record',
  'medical_record_self_attested',
  'landlord_self_reported_with_evidence',
  'tenant_self_reported_with_doc_verified',
  'tenant_self_reported',
  'system_derived',
] as const
export type CreditAttestationSource = typeof CREDIT_ATTESTATION_SOURCES[number]

export const CREDIT_SCORE_DIMENSIONS = [
  'payment_reliability',
  'property_care',
  'tenancy_stability',
  'community_fit',
  'cooperation',
] as const
export type CreditScoreDimension = typeof CREDIT_SCORE_DIMENSIONS[number]

export const CREDIT_NETWORK_VISIBILITY = [
  'private_to_subject',
  'visible_to_current_landlord',
  'visible_to_gam_network',
] as const
export type CreditNetworkVisibility = typeof CREDIT_NETWORK_VISIBILITY[number]

export const CREDIT_DISCLOSURE_SCOPES = ['gam_internal_only'] as const
export type CreditDisclosureScope = typeof CREDIT_DISCLOSURE_SCOPES[number]

export const CREDIT_DISPUTE_STATUSES = [
  'open',
  'evidence_pending',
  'resolved_upheld',
  'resolved_corrected',
  'resolved_no_change',
] as const
export type CreditDisputeStatus = typeof CREDIT_DISPUTE_STATUSES[number]

export const CREDIT_DISPUTE_REASONS = [
  'factual_inaccuracy',
  'attestation_invalid',
  'identity_mismatch',
  'other',
] as const
export type CreditDisputeReason = typeof CREDIT_DISPUTE_REASONS[number]

export const CREDIT_HARDSHIP_CATEGORIES = [
  'medical',
  'job_loss',
  'family_death',
  'natural_disaster',
  'military_deployment',
  'other',
] as const
export type CreditHardshipCategory = typeof CREDIT_HARDSHIP_CATEGORIES[number]

export const CREDIT_SUPERSEDE_REASONS = [
  'correction_after_dispute',
  'data_entry_error_corrected',
  'attestation_invalidated',
] as const
export type CreditSupersedeReason = typeof CREDIT_SUPERSEDE_REASONS[number]

export const CREDIT_NETWORK_TIERS = ['tier_2_full'] as const
export type CreditNetworkTier = typeof CREDIT_NETWORK_TIERS[number]

export const EXTERNAL_ACCOUNT_CATEGORIES = [
  'utility',
  'telecom',
  'auto_loan',
  'insurance',
  'child_support',
  'medical',
  'subscription',
  'bank_account',
  'credit_card',
  'student_loan',
  'mortgage',
] as const
export type ExternalAccountCategory = typeof EXTERNAL_ACCOUNT_CATEGORIES[number]

export const EXTERNAL_ACCOUNT_PROVIDER_KINDS = [
  'plaid',
  'mx',
  'finicity',
  'carrier_direct',
  'lender_direct',
  'gam_bill_pay',
  'manual_upload',
] as const
export type ExternalAccountProviderKind = typeof EXTERNAL_ACCOUNT_PROVIDER_KINDS[number]

// S207: state_tax_forms.filing_method — distinguishes paper-form filings
// (form_code is the official IRS/state code) from online-portal-only
// filings (form_code is a descriptive label; landlord files via agency_url
// portal, no paper form to look up). Conservative posture from S205/S206:
// fabricating a paper form code for portal-only states (MN, SD, WY, AK)
// would mislead landlords; this column lets us catalog those states
// without that hazard.
export const FILING_METHOD_VALUES = ['paper_form', 'online_portal'] as const
export type FilingMethod = typeof FILING_METHOD_VALUES[number]

// state_law_section_texts.law_category — the broad real-estate-law area a
// statute section belongs to. GAM's full-text statute corpus started as
// landlord/tenant-only (the live agent surface), but the product needs ALL
// real-estate law over time (for fix-and-flip investors, commercial operators,
// agents). This column keeps the broader corpus in one table while letting the
// landlord/tenant agent retrieval filter to `landlord_tenant` so its answers
// stay clean. Single source of truth — the migration CHECK lists the same
// values; ingesters import from here. Still the sanctioned retrieve+cite+date
// carve-out (never advice). Add a value here AND in a fix-forward migration.
export const LAW_CATEGORY_VALUES = [
  'landlord_tenant', // residential/commercial tenancy, eviction, MH/RV parks (the live agent domain)
  'conveyancing_title', // deeds, conveyances, recording, title, escrow
  'condo_coop', // condominium + cooperative ownership
  'broker_licensing', // real estate brokers, salespersons, appraisers
  'mortgage_lien_foreclosure', // mortgages, mechanic's/other liens, foreclosure, partition
  'property_tax', // real property assessment + taxation
  'land_use_zoning', // zoning, subdivision, planning, building/housing codes
  'environmental_disclosure', // property-condition + environmental disclosure duties
  'general_real_property', // catch-all real property statutes not in the above
] as const
export type LawCategory = typeof LAW_CATEGORY_VALUES[number]

// state_property_tax_provisions — STRUCTURED per-state property-tax facts (powers
// a near-term GAM property-tax feature; sits beside the verbatim property_tax
// statute text in state_law_section_texts). Single source of truth: the
// migration CHECKs list the same topic + jurisdiction sets. Sourced + dated +
// factual (the sanctioned no-state-legal carve-out), annual-refresh.
export const PROPERTY_TAX_TOPIC_VALUES = [
  'exemption', // a tax-relief program (homestead, senior, veteran, disability, ag, school relief…)
  'assessment', // how property is assessed (ratio/level, reassessment cycle, valuation standard)
  'assessment_appeal', // grievance/protest/appeal — deadline + review body
  'payment', // when tax is due (installments, grace)
  'delinquency_redemption', // late penalty/interest, tax-lien/deed sale, redemption period
] as const
export type PropertyTaxTopic = typeof PROPERTY_TAX_TOPIC_VALUES[number]

export const PROPERTY_TAX_JURISDICTION_LEVELS = ['state', 'county', 'municipal'] as const
export type PropertyTaxJurisdictionLevel = typeof PROPERTY_TAX_JURISDICTION_LEVELS[number]

// Documented shapes for the `params` jsonb, by topic. Property tax is largely
// LOCAL: state statute often sets a framework/ceiling that localities vary —
// set `locally_variable: true` so the feature can say so honestly rather than
// implying a single statewide number.
export interface PropertyTaxExemptionParams {
  age_min?: number
  income_max?: number
  income_unit?: 'usd_per_year'
  ownership_required?: boolean
  primary_residence_required?: boolean
  benefit_kind?: 'fixed_amount' | 'pct_reduction' | 'assessment_freeze' | 'exempt_value_cap'
  benefit_value?: number
  benefit_unit?: 'usd' | 'pct'
  locally_variable?: boolean
  notes?: string
}
export interface PropertyTaxAssessmentParams {
  assessment_ratio_pct?: number
  market_value_standard?: boolean
  reassessment_cycle_years?: number
  locally_variable?: boolean
}
export interface PropertyTaxAppealParams {
  deadline_kind?: 'fixed_date' | 'relative_to_roll' | 'window'
  deadline_month?: number // 1-12
  deadline_day?: number
  deadline_desc?: string // e.g. "fourth Tuesday in May"
  review_body?: string // e.g. "Board of Assessment Review", "Appraisal Review Board"
  locally_variable?: boolean
}
export interface PropertyTaxPaymentParams {
  installments?: { label?: string; due_month?: number; due_day?: number }[]
  delinquent_after_desc?: string
  grace_days?: number
  locally_variable?: boolean
}
export interface PropertyTaxDelinquencyParams {
  late_penalty_pct?: number
  late_interest_pct_per_year?: number
  redemption_period_months?: number
  tax_sale_kind?: 'tax_lien' | 'tax_deed' | 'hybrid' | 'other'
  locally_variable?: boolean
}
export type PropertyTaxProvisionParams =
  | PropertyTaxExemptionParams
  | PropertyTaxAssessmentParams
  | PropertyTaxAppealParams
  | PropertyTaxPaymentParams
  | PropertyTaxDelinquencyParams

// ── W-9: date-picker auto-close ──────────────────────────────────────────────
// Every date field in the portals is a native <input type="date|datetime-local">.
// Some native calendar popovers (Safari date; datetime-local pickers) stay open
// after a day is clicked, forcing an annoying extra click-off. Blurring the
// input when its value commits dismisses the popover in every browser.
// Call once at portal startup (main.tsx) — one global capture listener.
const DATE_PICKER_INPUT_TYPES = ['date', 'datetime-local', 'month', 'week', 'time']
export function installDatePickerAutoClose(): void {
  if (typeof document === 'undefined') return
  document.addEventListener(
    'change',
    (e) => {
      const t = e.target as HTMLInputElement | null
      if (t && t.tagName === 'INPUT' && DATE_PICKER_INPUT_TYPES.includes(t.type)) t.blur()
    },
    true
  )
}

// ── Utility meter reads (S533) ───────────────────────────────────────────────
// Meter reads are odometer values entered with leading zeros (a cycled-over
// 6-digit meter reads 000133). The digit WIDTH is a per-meter landlord
// setting (utility_meters.digits — water meters are often 4, some are 7+);
// these options are the ONE definition the meter form, the API clamp, the
// walk input, and the migration CHECK all share.
//
// Rollover is AUTOMATIC (Nic, S533): a read below the previous one bills
// wrap-around usage = (10^digits − prior) + current, e.g. 999822 → 000138
// = 316 — no double-check, RV parks roll meters constantly. The one guard:
// a wrap that exceeds HALF the meter's range is almost certainly a typo or
// a meter swap, not a rollover — those flag for the landlord double-check
// instead of auto-billing a monster charge.
export const METER_READING_DIGIT_OPTIONS = [4, 5, 6, 7, 8] as const
export type MeterReadingDigits = typeof METER_READING_DIGIT_OPTIONS[number]
export const METER_READING_DEFAULT_DIGITS = 6
export const meterReadingModulus = (digits: number) => 10 ** digits

// Suspicious-usage thresholds per utility type (Nic, S533) — INDIVIDUAL
// SUB-METERS ONLY. A submeter whose computed monthly usage (wrap-aware)
// exceeds its type's threshold is silently flagged for the landlord
// double-check and does NOT bill until confirmed — a misread that
// slipped past the rollover guard could otherwise put a huge charge on
// a tenant's invoice. Numbers are Nic's first guesses ("kwh ive never
// seen over 1500 so over 5k"; water unsure) — tune freely, they only
// gate the review flag, not the billing math. null = never flag.
export const METER_USAGE_ALERT_THRESHOLDS: Record<string, number | null> = {
  electric: 5000,   // kWh
  water: 10000,     // gallons
  gas: 1000,        // therms
  sewer: 10000,     // gallons (mirrors water)
  trash: null,
}

// RUBS master plausibility factor (S607). A master's monthly entry is a USAGE
// TOTAL off the utility's own bill, not an odometer read — the billing engine
// bills reading_value directly — so none of the odometer guards apply to it. A
// total LOWER than last month just means the park used less water; treating
// that as a rollover held every RUBS tenant's whole invoice for nothing.
//
// What a master does need is a typo guard, because it is the one reading with
// no second look behind it: the blind verification walk is submeters only, and
// one number prices every unit on the pool. 900000 typed for 90000 bills the
// whole park ten times over. A total above this multiple of the master's own
// previous total is flagged for the landlord to confirm or correct. Set wide
// enough that a real seasonal swing (a snowbird park filling in November)
// passes untouched — this is catching a slipped digit, not a busy month.
//
// S607 (Nic): widened 5× → 10×. A master pool legitimately swings far harder
// than any one submeter — a park fills for the season, and a single leak (a
// running toilet in one camper) moves the whole master with no entry error at
// all. Under RUBS that leak already spreads across every space, so flagging it
// here would hold the park's rent over something the flag cannot fix. 10× still
// catches the failure this guard exists for: a slipped digit. Finding the leak
// is a usage-anomaly job, not an entry-validation job.
export const MASTER_TOTAL_JUMP_FACTOR = 10
// What a RUBS master prices its pool FROM (S607).
//   usage_rate  — usage × the property's rate + base fee. The default, and how
//                 every master behaved before this existed.
//   bill_amount — divide the utility provider's actual dollar charge for the
//                 cycle. Blended into one per-usage rate so the provider's
//                 service charge and taxes ride inside the rate instead of
//                 landing on the tenant's bill as extra line items.
// Both are first-class: some jurisdictions cap recovery at the landlord's
// actual charges, others allow billing a published rate. The landlord picks.
export const RUBS_BASES = ['usage_rate', 'bill_amount'] as const
export type RubsBasis = typeof RUBS_BASES[number]

// What rate a SUBMETERED unit on a RUBS master's line is billed at (S607).
//   property_rate — the rate the landlord published (default). A predictable
//                   figure the tenant can check, unchanged from how a submeter
//                   behaves on the usage_rate basis.
//   blended       — the master's dollars ÷ usage, so every unit on the line
//                   pays an identical cost per unit.
export const RUBS_SUBMETER_RATES = ['property_rate', 'blended'] as const
export type RubsSubmeterRate = typeof RUBS_SUBMETER_RATES[number]

// How a RUBS master removes its submetered units from the pool (S607).
//   usage   — subtract their measured usage, then price the remainder. The
//             classic carve-out, and the default: no master changes shape
//             without the landlord asking for it.
//   dollars — subtract what those units were actually invoiced, so the bill
//             closes at any submeter rate.
// The two agree whenever submeters bill at the blended rate; they diverge when
// the landlord publishes a separate submeter rate.
export const RUBS_EXCLUSION_MODES = ['usage', 'dollars'] as const
export type RubsExclusionMode = typeof RUBS_EXCLUSION_MODES[number]

// Double-check verification phase (Nic, S533): after the main walk, the
// system generates a blind re-read list — every suspicious meter plus
// random clean ones so the list always has at least MIN entries and the
// reader can't tell which are the suspects. A re-read within TOLERANCE
// units of the first read means the meter just moved between reads: the
// first read stands for billing and the drift bills next cycle.
export const METER_DOUBLE_CHECK_MIN = 6
export const METER_DOUBLE_CHECK_TOLERANCE = 2

// Meter-read reasons (Nic, S559). Every reading carries a reason so we
// know whether it's billing-intent or a pure reference/baseline read, and
// so the audit trail records WHY a spot was read off-cycle. Two of these
// are auto-stamped by the system and never chosen by a person:
//   monthly_cycle  — the last-business-day reading run (BILLS via the
//                    tenant-responsibility gate).
//   stay_turnover  — a short-term / utilities-included departure detected
//                    off the calendar (REFERENCE only; resets the baseline
//                    so the departing guest's usage stays off the next
//                    arrival's bill).
//   move_out_final — a departing lease where the tenant IS responsible for
//                    the utility, detected off the calendar (BILLS).
// Only the last two are ever picked from a dropdown by front desk:
//   meter_replaced — swapped/new meter; sets a fresh baseline, NEVER bills.
//   other          — catch-all reference read (free-text note), NEVER bills.
export const METER_READ_REASONS = [
  'monthly_cycle',
  'stay_turnover',
  'move_out_final',
  'meter_replaced',
  // S605 (Nic): the opening odometer captured at meter setup. NOT a cycle read —
  // it never occupies the one-monthly_cycle-read-per-month slot — but it IS what
  // the first cycle subtracts from. Without it a submeter bills nothing, silently.
  'baseline',
  'other',
] as const
export type MeterReadReason = typeof METER_READ_REASONS[number]

// Reasons the reading is billing-INTENT (still subject to the per-lease
// tenant-responsibility gate before an actual bill is generated). Every
// other reason is reference/baseline only and never bills.
export const METER_READ_BILLING_REASONS: readonly MeterReadReason[] = [
  'monthly_cycle',
  'move_out_final',
] as const

// Reasons a person may pick when initiating an ad-hoc read. The auto
// reasons (monthly_cycle / stay_turnover / move_out_final) are stamped by
// the system from the calendar and never surface in the dropdown.
export const METER_READ_MANUAL_REASONS: readonly MeterReadReason[] = [
  'meter_replaced',
  'other',
] as const

export const METER_READ_REASON_LABEL: Record<MeterReadReason, string> = {
  monthly_cycle:  'Monthly cycle',
  stay_turnover:  'Stay turnover',
  move_out_final: 'Move-out (final read)',
  meter_replaced: 'Meter replaced',
  baseline:       'Opening read (baseline)',
  other:          'Other',
}

// ── Propane tank fills (Nic, S533) ───────────────────────────────────────────
// RV gas is propane TANK FILLS, not metered usage (natural gas on
// single-family is direct-billed by the utility; a metered-gas billback
// waits for a real use case). Fills bill in gallons at a per-fill price
// (PPG fluctuates and is deliberately NOT linked to POS propane pricing —
// big tanks get better rates at the landlord's discretion).
//
// Split-payment rules (Nic): the ONLY split options are 2 or 4 payments.
// The gallon thresholds are LANDLORD-SET per property (S534 —
// properties.propane_split_min_gallons / propane_split_four_min_gallons);
// the constants below are just the new-property defaults. First payment
// is due immediately at the fill (standalone — outside the invoice
// late-fee mechanism); the rest ride consecutive monthly invoices and
// are subject to the invoice's NORMAL late-fee rules when it isn't paid
// in full (Nic). Landlords opt in per property.
export const PROPANE_SPLIT_MIN_GALLONS = 40
export const PROPANE_SPLIT_FOUR_MIN_GALLONS = 100
export function propaneSplitOptions(
  gallons: number,
  minGallons: number = PROPANE_SPLIT_MIN_GALLONS,
  fourMinGallons: number = PROPANE_SPLIT_FOUR_MIN_GALLONS,
): number[] {
  if (gallons < minGallons) return [1]
  if (gallons < Math.max(fourMinGallons, minGallons)) return [1, 2]
  return [1, 2, 4]
}

// ── S540: resilient auth bootstrap ──────────────────────────────────
// Only a real 401/403 may end a session. Transient /auth/me failures
// (API mid-restart, network blip) must never wipe a stored token —
// the old `catch { logout() }` pattern was logging every portal out
// whenever the API bounced.
export function isAuthRejection(e: any): boolean {
  const s = e?.response?.status
  return s === 401 || s === 403
}

// Ride out short API restarts (~12s window at the defaults). Auth
// rejections re-throw immediately; other errors retry, then re-throw
// the last one so callers can decide (they should keep the token).
export async function fetchAuthMeWithRetry<T>(
  fetchMe: () => Promise<T>,
  attempts = 5,
  delayMs = 2500,
): Promise<T> {
  let lastErr: any
  for (let i = 0; i < attempts; i++) {
    try { return await fetchMe() }
    catch (e) {
      if (isAuthRejection(e)) throw e
      lastErr = e
      if (i < attempts - 1) await new Promise(r => setTimeout(r, delayMs))
    }
  }
  throw lastErr
}

// ── S541: FlexPay demand-test gate ──────────────────────────────────
// Enrollment is approval-gated for initial rollout (every enrollment
// is GAM float — the engine fronts rent each cycle). Tenant inquires
// in the tenant portal; GAM reviews lease + verifies SSI/SSDI income;
// only status='approved' unlocks enrollFlexPay. One row per tenant.
export const FLEXPAY_INQUIRY_STATUS_VALUES = ['pending', 'approved', 'declined'] as const
export type FlexPayInquiryStatus = typeof FLEXPAY_INQUIRY_STATUS_VALUES[number]
export const FLEXPAY_INQUIRY_STATUS_LABEL: Record<FlexPayInquiryStatus, string> = {
  pending:  'Pending review',
  approved: 'Approved',
  declined: 'Declined',
}
// S545: widened to the questionnaire vocabulary — non-SSI/SSDI
// interest files TIER-2 inquiries (same queue, behind SSI/SSDI,
// approval gated by flexpay_other_income_open).
export const FLEXPAY_INCOME_SOURCE_VALUES = ['ssi', 'ssdi', 'other_fixed', 'none'] as const
export type FlexPayIncomeSource = typeof FLEXPAY_INCOME_SOURCE_VALUES[number]
export const FLEXPAY_INCOME_SOURCE_LABEL: Record<FlexPayIncomeSource, string> = {
  ssi: 'SSI', ssdi: 'SSDI', other_fixed: 'Other fixed day', none: 'No fixed day',
}
export const FLEXPAY_TIER1_SOURCES: readonly string[] = ['ssi', 'ssdi']

// ── S542: platform-originated tenant questionnaires ─────────────────
// Landlord-invisible product-fit asks (FlexPay demand discovery).
// One-shot per (tenant, trigger); positive answers funnel into
// flexpay_inquiries. Trigger list grows as new indicators are added.
export const QUESTIONNAIRE_TRIGGER_VALUES = ['ssi_ssdi_signal', 'late_fee_fixed_income'] as const
export type QuestionnaireTrigger = typeof QUESTIONNAIRE_TRIGGER_VALUES[number]
export const QUESTIONNAIRE_STATUS_VALUES = ['pending', 'answered', 'dismissed'] as const
export type QuestionnaireStatus = typeof QUESTIONNAIRE_STATUS_VALUES[number]
export const QUESTIONNAIRE_INCOME_VALUES = ['ssi', 'ssdi', 'other_fixed', 'none'] as const
export type QuestionnaireIncome = typeof QUESTIONNAIRE_INCOME_VALUES[number]

// ── S545b: benefit-arrival schedules (how the programs actually pay) ─
// SSI → 1st; SSDI → 3rd (pre-1997 claims) or 2nd/3rd/4th Wednesday by
// birth date; other fixed incomes → plain day of month. Float math
// uses the LATEST day the pattern can land (conservative).
export const BENEFIT_SCHEDULE_VALUES = ['ssi_day_1', 'ssdi_day_3', 'ssdi_wed_2', 'ssdi_wed_3', 'ssdi_wed_4', 'fixed_day'] as const
export type BenefitSchedule = typeof BENEFIT_SCHEDULE_VALUES[number]
export const BENEFIT_SCHEDULE_LABEL: Record<BenefitSchedule, string> = {
  ssi_day_1: '1st of the month',
  ssdi_day_3: '3rd of the month',
  ssdi_wed_2: '2nd Wednesday',
  ssdi_wed_3: '3rd Wednesday',
  ssdi_wed_4: '4th Wednesday',
  fixed_day: 'Fixed day of month',
}
// Latest day-of-month the pattern can land on — drives desired_pull_day.
export function benefitScheduleToDay(s: BenefitSchedule, fixedDay?: number | null): number | null {
  switch (s) {
    case 'ssi_day_1':  return 1
    case 'ssdi_day_3': return 3
    case 'ssdi_wed_2': return 14
    case 'ssdi_wed_3': return 21
    case 'ssdi_wed_4': return 28
    case 'fixed_day':  return fixedDay ?? null
  }
}

// ── S561: post-settlement payment reversals (money-flow platform-holds) ─
// A payment that already SETTLED and batched to the landlord, then reverses
// (late ACH unauthorized/return up to 60d, or a card chargeback). Drives the
// reopen-the-tenant + reclaim-from-the-landlord receivable engine. See
// MONEY_FLOW_REBUILD_SPEC.md + memory gam-money-flow-platform-holds (D4).
export const PAYMENT_REVERSAL_TYPE_VALUES = ['ach_return', 'ach_unauthorized', 'card_dispute'] as const
export type PaymentReversalType = typeof PAYMENT_REVERSAL_TYPE_VALUES[number]

// How GAM reclaims the reversed rent FROM the already-paid landlord.
// null until the 7-day guaranteed-lease influx check decides.
export const PAYMENT_REVERSAL_RECOVERY_METHOD_VALUES = ['netting', 'ach_pull'] as const
export type PaymentReversalRecoveryMethod = typeof PAYMENT_REVERSAL_RECOVERY_METHOD_VALUES[number]

// pending → (scheduled_netting | recovered | not_needed). not_needed = the
// tenant re-paid before we clawed anything back, so the landlord is undisturbed.
export const PAYMENT_REVERSAL_RECOVERY_STATUS_VALUES = ['pending', 'scheduled_netting', 'recovered', 'not_needed'] as const
export type PaymentReversalRecoveryStatus = typeof PAYMENT_REVERSAL_RECOVERY_STATUS_VALUES[number]

// tenant_paid → GAM whole + keeps late fee/reversal fee; landlord_clawback →
// landlord ate it, pursues tenant, late fee reverts to landlord.
export const PAYMENT_REVERSAL_OUTCOME_VALUES = ['tenant_paid', 'landlord_clawback', 'written_off'] as const
export type PaymentReversalOutcome = typeof PAYMENT_REVERSAL_OUTCOME_VALUES[number]

// Who ultimately owns the reversal-lateness late fee (Participation Agreement
// assignment): 'gam' when the tenant makes good, 'landlord' when they clawed back.
export const PAYMENT_REVERSAL_LATE_FEE_OWNER_VALUES = ['gam', 'landlord'] as const
export type PaymentReversalLateFeeOwner = typeof PAYMENT_REVERSAL_LATE_FEE_OWNER_VALUES[number]

export const PAYMENT_REVERSAL_STATUS_VALUES = ['open', 'recovering', 'resolved'] as const
export type PaymentReversalStatus = typeof PAYMENT_REVERSAL_STATUS_VALUES[number]

// S596 — sales/demo booking `kind`. One slot engine (sales_call_availability +
// sales_call_slots) serves multiple scheduling windows: prospect product demos
// ('demo', live) and post-signup landlord onboarding walkthroughs ('onboarding',
// window reserved, scheduling built later). CHECK constraints on both tables
// list these exact values — keep in sync.
export const SALES_BOOKING_KIND_VALUES = ['demo', 'onboarding'] as const
export type SalesBookingKind = typeof SALES_BOOKING_KIND_VALUES[number]

// ── S605: Stripe Connect requirement labels ──────────────────────────────
//
// Nic: "I want it to be obvious for landlords so they're not like, what am I
// waiting on? If I don't know how to do what I need to do, that's where the
// friction lives."
//
// The banking page printed Stripe's RAW requirement keys — a landlord saw
// "individual.id_number, business_profile.mcc, tos_acceptance.date" and had no
// idea what was being asked. That also violated the no-raw-enums-in-UI rule.
//
// Keys are dot-paths and Stripe adds new ones over time, so this maps what we
// know and `connectRequirementLabel()` degrades gracefully for the rest rather
// than showing nothing.
export const CONNECT_REQUIREMENT_LABEL: Record<string, string> = {
  'business_profile.mcc':              'What kind of business this is',
  'business_profile.url':              'Business website (or a description instead)',
  'business_profile.product_description': 'A short description of what you rent',
  'business_type':                     'Whether you operate as an individual or a company',
  'company.name':                      'Legal business name',
  'company.address.line1':             'Business street address',
  'company.address.city':              'Business city',
  'company.address.state':             'Business state',
  'company.address.postal_code':       'Business ZIP code',
  'company.phone':                     'Business phone number',
  'company.tax_id':                    'Business EIN',
  'company.owners_provided':           'Confirmation that all owners are listed',
  'company.directors_provided':        'Confirmation that all directors are listed',
  'company.executives_provided':       'Confirmation that all executives are listed',
  'company.verification.document':     'A photo of your business verification document',
  'individual.first_name':             'Your first name',
  'individual.last_name':              'Your last name',
  'individual.dob.day':                'Your date of birth',
  'individual.dob.month':              'Your date of birth',
  'individual.dob.year':               'Your date of birth',
  'individual.address.line1':          'Your home street address',
  'individual.address.city':           'Your home city',
  'individual.address.state':          'Your home state',
  'individual.address.postal_code':    'Your home ZIP code',
  'individual.phone':                  'Your phone number',
  'individual.email':                  'Your email address',
  'individual.ssn_last_4':             'The last 4 digits of your SSN',
  'individual.id_number':              'Your full SSN (or tax ID)',
  'individual.verification.document':  'A photo of your driver’s licence or passport',
  'individual.verification.additional_document': 'A second ID document',
  'external_account':                  'The bank account rent should be deposited into',
  'tos_acceptance.date':               'Accepting Stripe’s terms',
  'tos_acceptance.ip':                 'Accepting Stripe’s terms',
  'representative.verification.document': 'A photo of the representative’s ID',
}

/**
 * Plain-English label for a Stripe requirement key. Unknown keys are
 * de-dotted and humanised rather than dropped — a landlord seeing a slightly
 * clumsy label still learns what is being asked; seeing nothing does not.
 */
export function connectRequirementLabel(key: string): string {
  const known = CONNECT_REQUIREMENT_LABEL[key]
  if (known) return known
  // 'person_xxx.verification.document' → strip Stripe's generated person ids.
  const generic = key.replace(/^person_[A-Za-z0-9]+\./, 'representative.')
  if (CONNECT_REQUIREMENT_LABEL[generic]) return CONNECT_REQUIREMENT_LABEL[generic]
  return humanize(key.split('.').pop() || key)
}

/** De-duplicated, plain-English list — dob.day/month/year collapse to one line. */
export function connectRequirementLabels(keys: string[]): string[] {
  return [...new Set((keys || []).map(connectRequirementLabel))]
}

// ─── S609: WHO A CHARGE'S MONEY BELONGS TO ────────────────────────────────
//
// NIC, DIRECTIVE: "Late fees that come from the lease and are on the invoice
// need to go to the landlord according to the lease. If you're talking about
// late fees that would be in the one-off charges, those also need to go to the
// landlord. I don't know why that would go to GAM. The only fees we collect are
// retries on ACH, pass-through on card processing, and the subscription for
// various tenant opt-in products."
//
// THE DEFECT THIS EXISTS TO FIX. Only rent and utilities were ever split out to
// the landlord. Every other charge — a late fee off the signed lease, a one-off
// charge a landlord billed by hand — settled with no owner share at all, so the
// tenant paid it and the money stopped on GAM's books. Silent: the tenant's
// balance was right, and the landlord had no line to miss.
//
// WHY A COLUMN AND NOT A RULE ABOUT TYPES. `entry_description` cannot carry this.
// A landlord's hand-billed lease fee and a GAM tenant subscription are BOTH
// written as 'SUBSCRIP' (services/leaseFees.ts and the FlexPay path), so the two
// are indistinguishable after the fact. Ownership is a fact about why a charge
// was created, known only at the moment of creation — so it is stamped then, by
// whoever creates it, and never inferred afterwards.
//
// The rule for anything new: if the tenant owes it because their LEASE says so,
// it is 'landlord'. If they owe it because they used a GAM service — a returned
// bank payment, a declined card, an opt-in product — it is 'gam'. When in doubt
// it is the landlord's; GAM's list is short, closed, and above.
export const REVENUE_OWNERS = ['landlord', 'gam'] as const
export type RevenueOwner = typeof REVENUE_OWNERS[number]

// The complete list of what GAM keeps (Nic). Everything not here is the
// landlord's. Kept as codes so a reader can check a payments row against it.
//
//   RETURNFEE  — a bank payment came back; NACHA retry cost passed through
//   DECLINEFEE — a card was declined; the authorization cost passed through
//   MANUALPAY  — recording a payment handed to the office (Nic confirmed S609
//                this stays GAM's: it covers manual reconciliation and both
//                Terms documents already disclose it that way)
//   FLEXPAY / SUBSCRIP(subscription) / FCPAYDOWN / ONTIMEPAY
//              — tenant opt-in products
//
// NOTE 'SUBSCRIP' is deliberately ABSENT: it is written by both the subscription
// path and the landlord's hand-billed lease fees, so it proves nothing on its
// own. Those two callers stamp revenue_owner explicitly instead.
export const GAM_REVENUE_ENTRY_DESCRIPTIONS = [
  'RETURNFEE', 'DECLINEFEE', 'MANUALPAY', 'FLEXPAY', 'FCPAYDOWN', 'ONTIMEPAY',
] as const

// ─── S609: HOW MANY PHOTOS A UNIT NEEDS BEFORE IT CAN BE LISTED ───────────
//
// NIC: "RV spots to be published for rent on the booking site or anywhere else
// we're planning on listing it — make the required photos one, because people
// are bringing their own unit. When we are booking something like an Airbnb
// style situation where there's interior pictures to be had, make it five, like
// for apartments."
//
// A flat five applied to everything, which is the right number for a dwelling
// and an impossible one for a bare site. An RV spot is a patch of ground with a
// hookup — the renter arrives towing the thing that would have been photographed
// — so five angles of the same gravel pad is busywork that stops real listings
// going out. A place someone LIVES INSIDE is the opposite: five is barely enough
// to decide from, and a one-photo listing there is a bad listing.
//
// Keyed by unit type so the rule is legible and one place changes it. Anything
// not named falls back to the dwelling standard, which is the safe direction:
// a new interior type should not quietly inherit the bare-site minimum.
export const LISTING_MIN_PHOTOS_DEFAULT = 5
export const LISTING_MIN_PHOTOS_BY_UNIT_TYPE: Partial<Record<UnitType, number>> = {
  // Bare sites — the renter brings the dwelling. One photo of the site.
  rv_spot:   1,
  campsite:  1,
  parking:   1,
  boat_slip: 1,
  land_lot:  1,
  storage:   1,
}
export const listingMinPhotos = (unitType: string): number =>
  LISTING_MIN_PHOTOS_BY_UNIT_TYPE[unitType as UnitType] ?? LISTING_MIN_PHOTOS_DEFAULT

/**
 * S616 (Nic) — occupancy has to see short stays.
 *
 *   "Occupancy also needs to track not just active leases, but it needs to
 *    track on short term stays, aggregate thirty nights of bookings as well."
 *
 * Occupancy was active LEASES over total units, so a park running on nightly
 * bookings read as almost entirely empty while it was full. Sunset Palms has
 * five live nightly bookings and every one of those spots carries status
 * 'vacant', because a booking is not a lease — so the landlord's occupancy card
 * said close to zero on a property that was busy.
 *
 * Thirty booked nights is one occupied unit-month, the same arithmetic the
 * platform fee already uses (CEIL(nights / 30) in platformFeeAccrual), so the
 * number a landlord SEES and the number GAM BILLS on cannot drift apart.
 *
 * Deliberately NOT reusing the fee model's unit-type split. That split exists
 * because some types bill per night and others bill a percentage of revenue —
 * a question about money, not about whether somebody is staying there. For
 * occupancy a booked spot is occupied whatever type it is.
 *
 * Service points are excluded, as everywhere else: a neighbour's building is
 * not this landlord's occupancy either way.
 */
export const SHORT_STAY_NIGHTS_PER_UNIT_MONTH = 30

export function occupancyRateFrom(
  activeUnits: number, shortStayNights: number, totalUnits: number,
): number {
  if (totalUnits <= 0) return 0
  const shortStayEquivalent = Math.ceil(shortStayNights / SHORT_STAY_NIGHTS_PER_UNIT_MONTH)
  // A property cannot be more than full: a spot turned over many times in one
  // month is still one spot, and an unbounded ratio would read as 140% occupied.
  const occupied = Math.min(totalUnits, activeUnits + shortStayEquivalent)
  return Math.round((100 * occupied) / totalUnits)
}

// ── Tenant complaints (S618) ────────────────────────────────────────────────
//
// Nic: "the table is gonna be created in the agent chat. That's the point of
// contact where tenants are gonna complain about the neighbor, or they're gonna
// do it as a maintenance request — hey, tell my neighbor to turn their shit
// down."
//
// So the chat IS the intake. A tenant says it to the agent, the agent records
// it, and the landlord can then ask who complains most and who gets complained
// about most — the difference between a tenant who is needy and a tenant with a
// real problem next door.
//
// Deliberately NOT maintenance: maintenance_requests.category is a closed list
// of hvac/plumbing/electrical/appliance/... with nothing that fits a neighbour,
// and forcing one in would corrupt repair reporting.
export const COMPLAINT_CATEGORY_VALUES = [
  'noise', 'neighbor', 'parking', 'pets', 'smell', 'trash',
  'property_condition', 'harassment', 'safety', 'other',
] as const
export type ComplaintCategory = typeof COMPLAINT_CATEGORY_VALUES[number]

export const COMPLAINT_CATEGORY_LABEL: Record<ComplaintCategory, string> = {
  noise:              'Noise',
  neighbor:           'Neighbor',
  parking:            'Parking',
  pets:               'Pets',
  smell:              'Smell or smoke',
  trash:              'Trash',
  property_condition: 'Condition of the property',
  harassment:         'Harassment',
  safety:             'Safety',
  other:              'Other',
}

export const COMPLAINT_STATUS_VALUES = ['open', 'reviewed', 'resolved', 'dismissed'] as const
export type ComplaintStatus = typeof COMPLAINT_STATUS_VALUES[number]

export const COMPLAINT_STATUS_LABEL: Record<ComplaintStatus, string> = {
  open:      'Open',
  reviewed:  'Reviewed',
  resolved:  'Resolved',
  dismissed: 'Dismissed',
}
