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

export enum PaymentStatus {
  PENDING    = 'pending',
  PROCESSING = 'processing',
  SETTLED    = 'settled',
  FAILED     = 'failed',
  RETURNED   = 'returned',
}

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
export const LEASE_DOCUMENT_TYPES = ['original_lease', 'addendum_add', 'addendum_remove', 'addendum_terms'] as const
export type LeaseDocumentType = typeof LEASE_DOCUMENT_TYPES[number]
export const LEASE_DOCUMENT_TYPE_LABEL: Record<LeaseDocumentType, string> = {
  original_lease:  'Original Lease',
  addendum_add:    'Add Tenant',
  addendum_remove: 'Remove Tenant',
  addendum_terms:  'Change Lease Terms',
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
  security_deposit:       'writable',
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
  | 'security_deposit'
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
  security_deposit: {
    parse: (v) => ({ security_deposit: v.security_deposit || 0 }),
  },
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
  | 'pet_deposit' | 'key_deposit' | 'cleaning_deposit'
  | 'move_in_fee' | 'cleaning_fee' | 'pet_fee' | 'application_fee'
  | 'amenity_fee' | 'hoa_transfer_fee' | 'lease_prep_fee'
  | 'pet_rent' | 'parking_rent' | 'storage_rent' | 'amenity_fee_monthly'
  | 'trash_fee' | 'pest_control_fee' | 'technology_fee'
  | 'last_month_rent' | 'early_termination_fee' | 'other_fee'

export type FeeType = FeeRowTag
export const FEE_TYPES: readonly FeeType[] = [
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
//   in_progress — at least one signer signed, not all
//   completed   — all signers signed, execute* ran successfully
//   voided      — cancelled before completion (with void_reason)
export const LEASE_DOCUMENT_STATUSES = ['pending', 'sent', 'in_progress', 'completed', 'voided'] as const
export type LeaseDocumentStatus = typeof LEASE_DOCUMENT_STATUSES[number]
export const LEASE_DOCUMENT_STATUS_LABEL: Record<LeaseDocumentStatus, string> = {
  pending:     'Pending',
  sent:        'Sent',
  in_progress: 'In Progress',
  completed:   'Completed',
  voided:      'Voided',
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
  stripeAccountId?: string       // Stripe Connect account
  stripeBankVerified: boolean
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
  azrocLicense: string           // Required — AZ Registrar of Contractors
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
  adminFee: number               // AZ: actual cost + admin fee ONLY
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

export const FLEX_DEPOSIT_TIERS = [
  { maxDeposit: 500,  installments: 2, maxMonthly: 250 },
  { maxDeposit: 800,  installments: 3, maxMonthly: 267 },
  { maxDeposit: 1050, installments: 4, maxMonthly: 263 },
  { maxDeposit: 1400, installments: 5, maxMonthly: 280 },
  { maxDeposit: 2100, installments: 6, maxMonthly: 350 },
] as const

// ACH return codes with zero-tolerance flag
export const ACH_RETURN_CONFIG: Record<string, { zeroTolerance: boolean; description: string }> = {
  R05: { zeroTolerance: true,  description: 'Unauthorized debit to consumer account' },
  R07: { zeroTolerance: true,  description: 'Authorization revoked by customer' },
  R10: { zeroTolerance: true,  description: 'Customer advises not authorized' },
  R29: { zeroTolerance: true,  description: 'Corporate customer advises not authorized' },
  R01: { zeroTolerance: false, description: 'Insufficient funds' },
  R02: { zeroTolerance: false, description: 'Account closed' },
  R03: { zeroTolerance: false, description: 'No account / unable to locate' },
  R04: { zeroTolerance: false, description: 'Invalid account number' },
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

export function getFlexDepositTier(depositAmount: number) {
  return FLEX_DEPOSIT_TIERS.find(t => depositAmount <= t.maxDeposit)
    ?? FLEX_DEPOSIT_TIERS[FLEX_DEPOSIT_TIERS.length - 1]
}

export function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount)
}



// === S25: businessDay + paymentAllocation re-exports ===
export * from './businessDay'
export * from './paymentAllocation'

// ============================================================
// S26a: Invoice types
// ============================================================

export const INVOICE_STATUSES = ['pending', 'partial', 'settled', 'void'] as const
export type InvoiceStatus = typeof INVOICE_STATUSES[number]

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
