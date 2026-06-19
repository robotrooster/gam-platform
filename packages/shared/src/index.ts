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

// ── Standard inspection walkthrough checklist (single source) ──────────
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

const BEDROOM_ITEMS = ['Walls', 'Flooring', 'Closet', 'Window', 'Lighting'] as const

// Residential base, MINUS bedrooms — bedrooms are spliced in after
// 'Living / common' by the builder, sized to the unit.
const RESIDENTIAL_INSPECTION_AREAS_BASE: readonly InspectionChecklistArea[] = [
  { area: 'Kitchen', items: ['Countertops & cabinets', 'Sink & faucet', 'Stove/oven', 'Refrigerator', 'Dishwasher/microwave', 'Floor'] },
  { area: 'Bathroom', items: ['Toilet', 'Sink & vanity', 'Tub/shower', 'Tile & grout', 'Exhaust fan', 'Floor'] },
  { area: 'Living / common', items: ['Walls', 'Flooring', 'Ceiling', 'Windows & blinds', 'Doors', 'Lighting & outlets'] },
  { area: 'Systems & safety', items: ['HVAC/thermostat', 'Water heater', 'Smoke & CO detectors', 'Breaker panel'] },
  { area: 'Laundry', items: ['Washer/dryer or hookups'] },
  { area: 'Exterior / entry', items: ['Entry door & locks', 'Patio/balcony', 'Exterior walls/screens'] },
  { area: 'Handover', items: ['Keys/remotes/access devices', 'Utility meter readings'] },
]

const RV_SITE_INSPECTION_AREAS: readonly InspectionChecklistArea[] = [
  { area: 'Pad & site', items: ['Pad surface', 'Leveling', 'Picnic table', 'Fire ring/grill'] },
  { area: 'Hookups', items: ['Electric pedestal', 'Water connection', 'Sewer connection'] },
  { area: 'Cleanliness', items: ['Trash removed', 'Site cleared'] },
  { area: 'Surroundings', items: ['Landscaping/clearance', 'Site markers/signage'] },
  { area: 'Handover', items: ['Gate/access code', 'Meter reading (if metered)'] },
]

// Dwelling unit types that get bedroom areas. rv_spot uses the site list;
// storage/commercial get the residential base WITHOUT bedrooms.
const BEDROOM_UNIT_TYPES = ['apartment', 'single_family', 'mobile_home']

export function buildInspectionChecklist(input: { unitType?: string | null; bedrooms?: number | null }): InspectionChecklistArea[] {
  if (input.unitType === 'rv_spot') return RV_SITE_INSPECTION_AREAS.map((a) => ({ ...a }))

  const base = RESIDENTIAL_INSPECTION_AREAS_BASE
  if (!BEDROOM_UNIT_TYPES.includes(input.unitType ?? 'apartment')) {
    return base.map((a) => ({ ...a }))
  }

  const n = Math.trunc(Number(input.bedrooms ?? 1))
  const bedroomCount = Math.min(Math.max(Number.isFinite(n) ? n : 1, 0), MAX_INSPECTION_BEDROOMS)
  const bedrooms: InspectionChecklistArea[] = Array.from({ length: bedroomCount }, (_, i) => ({
    area: `Bedroom ${i + 1}`,
    items: [...BEDROOM_ITEMS],
  }))
  const idx = base.findIndex((a) => a.area === 'Living / common')
  return [...base.slice(0, idx + 1), ...bedrooms, ...base.slice(idx + 1)].map((a) => ({ ...a }))
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
  'bulletin.view',
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
  'bulletin.view',
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
  'bulletin.view':                     'View tenant bulletin board',
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
  // maintenance
  'work_orders.create':                'Create work orders',
  'work_orders.complete':              'Complete work orders',
  'work_orders.reassign':              'Reassign work orders',
  'purchases.request':                 'Request purchases',
  'purchases.approve':                 'Approve purchases',
  'unit_access.view':                  'View unit access codes',
  'time.clock_in_out':                 'Clock in/out',
}

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
export const UNIT_STATUSES = ['vacant', 'available', 'active', 'direct_pay', 'delinquent', 'suspended'] as const
export type UnitStatus = typeof UNIT_STATUSES[number]
export const UNIT_STATUS_LABEL: Record<UnitStatus, string> = {
  vacant:     'Vacant',
  available:  'Available',
  active:     'Active',
  direct_pay: 'Direct Pay',
  delinquent: 'Delinquent',
  suspended:  'Suspended',
}

// Unit type values.
// Single source of truth for units.unit_type CHECK constraint.
export const UNIT_TYPES = ['apartment', 'single_family', 'rv_spot', 'mobile_home', 'storage', 'commercial'] as const
export type UnitType = typeof UNIT_TYPES[number]
export const UNIT_TYPE_LABEL: Record<UnitType, string> = {
  apartment:     'Apartment',
  single_family: 'Single Family Home',
  rv_spot:       'RV Spot',
  mobile_home:   'Mobile Home',
  storage:       'Storage',
  commercial:    'Commercial',
}
export const UNIT_TYPE_PREFIX: Record<UnitType, string> = {
  apartment:     'APT',
  single_family: 'SFH',
  rv_spot:       'RV',
  mobile_home:   'MH',
  storage:       'STG',
  commercial:    'COM',
}
export const UNIT_TYPE_ICON: Record<UnitType, string> = {
  apartment:     '🏢',
  single_family: '🏠',
  rv_spot:       '🚐',
  mobile_home:   '🏡',
  storage:       '📦',
  commercial:    '🏪',
}
// Whether this unit type conceptually has bedrooms (affects UI rendering).
export const UNIT_TYPE_HAS_BEDROOMS: Record<UnitType, boolean> = {
  apartment:     true,
  single_family: true,
  rv_spot:       false,
  mobile_home:   true,
  storage:       false,
  commercial:    false,
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
export const DOCUMENT_CATEGORIES = ['lease', 'addendum', 'move_in_checklist', 'move_out_checklist', 'notice', 'other'] as const
export type DocumentCategory = typeof DOCUMENT_CATEGORIES[number]
export const DOCUMENT_CATEGORY_LABEL: Record<DocumentCategory, string> = {
  lease:              'Lease',
  addendum:           'Addendum',
  move_in_checklist:  'Move-In Checklist',
  move_out_checklist: 'Move-Out Checklist',
  notice:             'Notice',
  other:              'Other',
}

// Lease document types on the `lease_documents` table (e-sign dispatcher).
// Single source of truth for lease_documents.document_type CHECK constraint.
export const LEASE_DOCUMENT_TYPES = ['original_lease', 'addendum_add', 'addendum_remove', 'addendum_terms', 'sublease_agreement'] as const
export type LeaseDocumentType = typeof LEASE_DOCUMENT_TYPES[number]
export const LEASE_DOCUMENT_TYPE_LABEL: Record<LeaseDocumentType, string> = {
  original_lease:     'Original Lease',
  addendum_add:       'Add Tenant',
  addendum_remove:    'Remove Tenant',
  addendum_terms:     'Change Lease Terms',
  sublease_agreement: 'Sublease Agreement',
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
    parse: (v) => ({ end_date: v.end_date || null }),
  },
  // S196: security_deposit removed from WRITABLE specs. The fee_row
  // pipeline (FEE_ROW_SPECS) now handles it as a lease_fees row.
  rent_due_day: {
    parse: (v) => ({ rent_due_day: parseInt(v.rent_due_day || '1') }),
  },
  lease_type: {
    parse: (v) => ({ lease_type: v.lease_type || 'fixed_term' }),
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
    parse: (v): Record<string, WritableLeaseColumnSqlValue> => ({ late_fee_grace_days: parseInt(v.late_fee_grace_days || '5') }),
  },
  // Late fee granular tags → each writes an amount column + its sibling
  // type/period columns on leases. Property-level config is the billing
  // source of truth; these columns are the legal snapshot of the signed PDF.
  late_fee_initial_flat: {
    parse: (v): Record<string, WritableLeaseColumnSqlValue> => v.late_fee_initial_flat != null
      ? { late_fee_initial_amount: v.late_fee_initial_flat, late_fee_initial_type: 'flat' }
      : {},
  },
  late_fee_initial_percent: {
    parse: (v): Record<string, WritableLeaseColumnSqlValue> => v.late_fee_initial_percent != null
      ? { late_fee_initial_amount: v.late_fee_initial_percent, late_fee_initial_type: 'percent_of_rent' }
      : {},
  },
  late_fee_accrual_flat_daily: {
    parse: (v): Record<string, WritableLeaseColumnSqlValue> => v.late_fee_accrual_flat_daily != null
      ? { late_fee_accrual_amount: v.late_fee_accrual_flat_daily, late_fee_accrual_type: 'flat', late_fee_accrual_period: 'daily' }
      : {},
  },
  late_fee_accrual_flat_weekly: {
    parse: (v): Record<string, WritableLeaseColumnSqlValue> => v.late_fee_accrual_flat_weekly != null
      ? { late_fee_accrual_amount: v.late_fee_accrual_flat_weekly, late_fee_accrual_type: 'flat', late_fee_accrual_period: 'weekly' }
      : {},
  },
  late_fee_accrual_flat_monthly: {
    parse: (v): Record<string, WritableLeaseColumnSqlValue> => v.late_fee_accrual_flat_monthly != null
      ? { late_fee_accrual_amount: v.late_fee_accrual_flat_monthly, late_fee_accrual_type: 'flat', late_fee_accrual_period: 'monthly' }
      : {},
  },
  late_fee_accrual_percent_daily: {
    parse: (v): Record<string, WritableLeaseColumnSqlValue> => v.late_fee_accrual_percent_daily != null
      ? { late_fee_accrual_amount: v.late_fee_accrual_percent_daily, late_fee_accrual_type: 'percent_of_rent', late_fee_accrual_period: 'daily' }
      : {},
  },
  late_fee_accrual_percent_weekly: {
    parse: (v): Record<string, WritableLeaseColumnSqlValue> => v.late_fee_accrual_percent_weekly != null
      ? { late_fee_accrual_amount: v.late_fee_accrual_percent_weekly, late_fee_accrual_type: 'percent_of_rent', late_fee_accrual_period: 'weekly' }
      : {},
  },
  late_fee_accrual_percent_monthly: {
    parse: (v): Record<string, WritableLeaseColumnSqlValue> => v.late_fee_accrual_percent_monthly != null
      ? { late_fee_accrual_amount: v.late_fee_accrual_percent_monthly, late_fee_accrual_type: 'percent_of_rent', late_fee_accrual_period: 'monthly' }
      : {},
  },
  late_fee_cap_flat: {
    parse: (v): Record<string, WritableLeaseColumnSqlValue> => v.late_fee_cap_flat != null
      ? { late_fee_cap_amount: v.late_fee_cap_flat, late_fee_cap_type: 'flat' }
      : {},
  },
  late_fee_cap_percent: {
    parse: (v): Record<string, WritableLeaseColumnSqlValue> => v.late_fee_cap_percent != null
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

export type UtilityType = 'water' | 'gas' | 'electric' | 'sewer' | 'trash'
export const UTILITY_TYPES: readonly UtilityType[] = ['water', 'gas', 'electric', 'sewer', 'trash'] as const

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

export type RubsAllocationMethod = 'occupant_count' | 'sqft' | 'bedrooms' | 'equal_split'
export const RUBS_ALLOCATION_METHODS: readonly RubsAllocationMethod[] =
  ['occupant_count', 'sqft', 'bedrooms', 'equal_split'] as const

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
  contractorId?: string
  contractor?: Contractor
  estimatedCost?: number
  actualCost?: number
  platformFee?: number           // 8% of actual cost
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

export const STRIPE_CONFIG = {
  ACH_RATE:        0.008,
  ACH_CAP:         5.00,
  PAYOUT_RATE:     0.0025,
  PAYOUT_FLAT:     0.25,
  CONNECT_ACCT_MO: 2.00,
} as const

export const PLATFORM_FEES = {
  ACTIVE_UNIT:     15.00,
  DIRECT_PAY_UNIT: 5.00,
  VACANT_UNIT:     0.00,
  LATE_FEE:        15.00,
  FLOAT_FEE_MO:    20.00,     // SSI/SSDI opt-in service fee
  REINSTATEMENT:   25.00,     // After FlexDeposit default
  BG_CHECK_NET:    15.00,     // Platform nets $15, applicant pays $40
  MAINTENANCE_PCT: 0.08,      // 8% of job value
  DEPOSIT_XFER:    15.00,     // Deposit transfer between GAM properties
} as const

export const RESERVE_CONFIG = {
  PHASE1_MAX:      1000,
  PHASE1_RATE:     1.00,
  PHASE2_MAX:      5000,
  PHASE2_RATE:     0.30,
  PHASE3_RATE:     0.15,
  TARGET_MONTHS:   3,
  DEFAULT_RATE:    0.03,
} as const

// FlexDeposit tier matrix (S246). Larger deposits get FEWER
// installments to minimize GAM's outstanding float exposure — GAM
// can't pursue tenants for damages, so the higher the dollar amount
// fronted, the faster GAM wants it recovered.
//   $0 – $1000     → 4 installments max
//   $1001 – $2000  → 3 installments max
//   $2001+         → 2 installments max
// The risk_level from the Checkr BG report further constrains:
//   low risk      → max for the band
//   medium risk   → max − 1 (floor 2)
//   high+         → 2 only
export const FLEX_DEPOSIT_TIERS = [
  { maxDeposit: 1000,    maxInstallments: 4 },
  { maxDeposit: 2000,    maxInstallments: 3 },
  { maxDeposit: Infinity, maxInstallments: 2 },
] as const

export const FLEX_DEPOSIT_CUSTODY_FEE = 3       // $/month while on platform
export const FLEX_DEPOSIT_NSF_COOLDOWN_DAYS = 60

// FlexCharge (S252+). Consolidated POS charge-account with monthly
// statement + 1.5% service fee on the cycle balance. No interest;
// no revolving balance — keeps the product classed as deferred-debit,
// not credit extension (out of payday-lending regulatory territory).
export const FLEX_CHARGE_STATEMENT_FEE_PCT = 0.015
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
  const gross  = PLATFORM_FEES.ACTIVE_UNIT
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
export * from './paymentAllocation'
export * from './camelize'

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

export const PAYMENT_TYPES = ['rent', 'fee', 'deposit', 'utility', 'float_fee', 'late_fee', 'platform_fee'] as const
export type PaymentType = typeof PAYMENT_TYPES[number]

// NACHA CCD/PPD entry description field — uppercase, max 10 chars per spec.
export const PAYMENT_ENTRY_DESCRIPTIONS = ['RENT', 'SUBSCRIP', 'DEPOSIT', 'UTILITY', 'ONTIMEPAY', 'LATEFEE'] as const
export type PaymentEntryDescription = typeof PAYMENT_ENTRY_DESCRIPTIONS[number]

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
] as const
export type ParserFlagCategory = typeof PARSER_FLAG_CATEGORIES[number]

export const PARSER_FLAG_CATEGORY_META: Record<ParserFlagCategory, { label: string; description: string }> = {
  identity_mismatch:    { label: 'Identity mismatch',    description: 'Tenant on the lease does not match the tenant landlord typed. Possible wrong file.' },
  unit_not_found:       { label: 'Unit not found',       description: 'Unit named on the lease is not in this landlord\'s portfolio.' },
  field_missing:        { label: 'Missing field',        description: 'Lease term could not be located in the document.' },
  field_suspect:        { label: 'Suspect value',        description: 'Lease term was extracted but the value looks wrong (zero rent, dates far in future, etc.).' },
  field_low_confidence: { label: 'Low confidence',       description: 'Parser is not confident in this extraction. Landlord should verify.' },
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
