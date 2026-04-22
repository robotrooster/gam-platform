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

// Lease column identifiers — values that can be assigned to template fields
// via lease_template_fields.lease_column. Single source of truth for the
// lease_template_fields.lease_column CHECK constraint (24 values).
//
// Category determines how the value is consumed at lease-build time:
//   - 'writable'  → participates in INSERT INTO leases (...)
//   - 'identity'  → display + unit matching, never written to leases
//   - 'signature' → pure document display (signatures, initials, etc.)
//
// Adding a value: edit LEASE_COLUMNS, the compiler forces CATEGORY + LABEL +
// INPUT updates. Adding a *writable* value: also add a WRITABLE_LEASE_COLUMN_SPECS
// entry or the object literal fails to typecheck.
export const LEASE_COLUMNS = [
  // writable — columns on the leases table
  'rent_amount', 'start_date', 'end_date',
  'security_deposit', 'rent_due_day',
  'late_fee_grace_days', 'late_fee_amount',
  'lease_type', 'auto_renew', 'auto_renew_mode',
  'notice_days_required', 'expiration_notice_days',
  // identity — display + unit matching
  'tenant_name', 'tenant_email', 'landlord_name',
  'unit_number', 'property_name', 'property_address',
  // signature — pure document display, never written to leases
  'tenant_signature', 'landlord_signature',
  'tenant_initial', 'landlord_initial',
  'date_signed', 'custom_text',
] as const
export type LeaseColumn = typeof LEASE_COLUMNS[number]

export type LeaseColumnCategory = 'writable' | 'identity' | 'signature'
export const LEASE_COLUMN_CATEGORY: Record<LeaseColumn, LeaseColumnCategory> = {
  rent_amount:            'writable',
  start_date:             'writable',
  end_date:               'writable',
  security_deposit:       'writable',
  rent_due_day:           'writable',
  late_fee_grace_days:    'writable',
  late_fee_amount:        'writable',
  lease_type:             'writable',
  auto_renew:             'writable',
  auto_renew_mode:        'writable',
  notice_days_required:   'writable',
  expiration_notice_days: 'writable',
  tenant_name:            'identity',
  tenant_email:           'identity',
  landlord_name:          'identity',
  unit_number:            'identity',
  property_name:          'identity',
  property_address:       'identity',
  tenant_signature:       'signature',
  landlord_signature:     'signature',
  tenant_initial:         'signature',
  landlord_initial:       'signature',
  date_signed:            'signature',
  custom_text:            'signature',
}

export const LEASE_COLUMN_LABEL: Record<LeaseColumn, string> = {
  rent_amount:            'Rent amount',
  start_date:             'Lease start date',
  end_date:               'Lease end date',
  security_deposit:       'Security deposit',
  rent_due_day:           'Rent due day',
  late_fee_grace_days:    'Late fee grace days',
  late_fee_amount:        'Late fee amount',
  lease_type:             'Lease type',
  auto_renew:             'Auto-renew (Yes/No)',
  auto_renew_mode:        'Auto-renew mode',
  notice_days_required:   'Notice days required',
  expiration_notice_days: 'Expiration notice days',
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
  custom_text:            'Custom text (entered at send time)',
}

// Input bucket for the Field Properties dropdown on the template editor.
//   - 'text' / 'date' → surfaced to landlord as a data-label option
//   - 'implicit'      → bound via field type + signer role, never in dropdown
export type LeaseColumnInput = 'text' | 'date' | 'implicit'
export const LEASE_COLUMN_INPUT: Record<LeaseColumn, LeaseColumnInput> = {
  rent_amount:            'text',
  start_date:             'date',
  end_date:               'date',
  security_deposit:       'text',
  rent_due_day:           'text',
  late_fee_grace_days:    'text',
  late_fee_amount:        'text',
  lease_type:             'text',
  auto_renew:             'text',
  auto_renew_mode:        'text',
  notice_days_required:   'text',
  expiration_notice_days: 'text',
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
  custom_text:            'text',
}

// Subset union of LeaseColumn that writes to the leases table. Must mirror
// every entry in LEASE_COLUMN_CATEGORY marked 'writable'. Keep in sync.
export type WritableLeaseColumn =
  | 'rent_amount'
  | 'start_date'
  | 'end_date'
  | 'security_deposit'
  | 'rent_due_day'
  | 'late_fee_grace_days'
  | 'late_fee_amount'
  | 'lease_type'
  | 'auto_renew'
  | 'auto_renew_mode'
  | 'notice_days_required'
  | 'expiration_notice_days'

// Bag of lease_column values collected from a signed document. Undefined =
// template didn't bind that column.
export type LeaseColumnVals = Partial<Record<LeaseColumn, string>>

// SQL-ready value returned from a parse function.
export type WritableLeaseColumnSqlValue = string | number | boolean | null

// Per-writable spec: DB column on the `leases` table + parser that turns the
// collected string bag into a SQL-ready value. Parsers may throw on required
// fields (start_date, rent_amount).
export interface WritableLeaseColumnSpec {
  dbColumn: string
  parse: (vals: LeaseColumnVals) => WritableLeaseColumnSqlValue
}

export const WRITABLE_LEASE_COLUMN_SPECS: Record<WritableLeaseColumn, WritableLeaseColumnSpec> = {
  rent_amount: {
    dbColumn: 'rent_amount',
    parse: (v) => {
      if (!v.rent_amount) throw new Error('Template missing rent_amount field — cannot build lease')
      return v.rent_amount
    },
  },
  start_date: {
    dbColumn: 'start_date',
    parse: (v) => {
      if (!v.start_date) throw new Error('Template missing start_date field — cannot build lease')
      return v.start_date
    },
  },
  end_date: {
    dbColumn: 'end_date',
    parse: (v) => v.end_date || null,
  },
  security_deposit: {
    dbColumn: 'security_deposit',
    parse: (v) => v.security_deposit || 0,
  },
  rent_due_day: {
    dbColumn: 'rent_due_day',
    parse: (v) => parseInt(v.rent_due_day || '1'),
  },
  late_fee_grace_days: {
    dbColumn: 'late_fee_grace_days',
    parse: (v) => parseInt(v.late_fee_grace_days || '5'),
  },
  late_fee_amount: {
    dbColumn: 'late_fee_amount',
    parse: (v) => v.late_fee_amount || 15,
  },
  lease_type: {
    dbColumn: 'lease_type',
    parse: (v) => v.lease_type || 'fixed_term',
  },
  auto_renew: {
    dbColumn: 'auto_renew',
    parse: (v) => v.auto_renew === 'true' || v.auto_renew === 'yes',
  },
  auto_renew_mode: {
    dbColumn: 'auto_renew_mode',
    parse: (v) => {
      const autoRenew = v.auto_renew === 'true' || v.auto_renew === 'yes'
      return autoRenew ? (v.auto_renew_mode || 'convert_to_month_to_month') : null
    },
  },
  notice_days_required: {
    dbColumn: 'notice_days_required',
    parse: (v) => parseInt(v.notice_days_required || '30'),
  },
  expiration_notice_days: {
    dbColumn: 'expiration_notice_days',
    parse: (v) => parseInt(v.expiration_notice_days || '60'),
  },
}

// Lease type classifier for the leases.lease_type column.
// Single source of truth for leases_lease_type_check CHECK constraint (5 values).
// NOTE: distinct from unit_bookings.booking_type — short-term bookings use a
// separate 3-value classifier on a different table. Do not conflate.
export const LEASE_TYPES = ['month_to_month', 'fixed_term', 'nightly', 'weekly', 'nnn_commercial'] as const
export type LeaseType = typeof LEASE_TYPES[number]
export const LEASE_TYPE_LABEL: Record<LeaseType, string> = {
  month_to_month: 'Month-to-month',
  fixed_term:     'Fixed term',
  nightly:        'Nightly',
  weekly:         'Weekly',
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

