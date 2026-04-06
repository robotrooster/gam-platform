// ============================================================
// GOLD ASSET MANAGEMENT — SHARED TYPES
// Single source of truth for all data models across all apps
// ============================================================

// ── ENUMS ──────────────────────────────────────────────────

export enum UserRole {
  ADMIN            = 'admin',
  LANDLORD         = 'landlord',
  PROPERTY_MANAGER = 'property_manager',
  ONSITE_MANAGER   = 'onsite_manager',
  MAINTENANCE      = 'maintenance',
  TENANT           = 'tenant',
  BOOKKEEPER        = 'bookkeeper',
  SUPER_ADMIN       = 'super_admin',
}

export const ROLE_LABELS: Record<string, string> = {
  admin:            'Platform Admin',
  landlord:         'Landlord',
  property_manager: 'Property Manager',
  onsite_manager:   'On-Site Manager',
  maintenance:      'Maintenance',
  tenant:           'Tenant',
  bookkeeper:       'Bookkeeper',
  super_admin:      'Super Admin',
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

export enum UnitStatus {
  ACTIVE     = 'active',      // Occupied, On-Time Pay active — $15/mo
  DIRECT_PAY = 'direct_pay',  // Tenant pays landlord directly — $5/mo
  VACANT     = 'vacant',      // No tenant — $0 charge, $0 cost
  DELINQUENT = 'delinquent',  // ACH failed, cure window — $15 + $15 late fee
  SUSPENDED  = 'suspended',   // 30+ days — service paused — $0
}

export enum PropertyType {
  RESIDENTIAL  = 'residential',
  RV_LONGTERM  = 'rv_longterm',   // 3+ months — On-Time Pay active
  RV_WEEKLY    = 'rv_weekly',     // weekly billing, monthly batch payout
  RV_NIGHTLY   = 'rv_nightly',   // nightly card, weekly batch payout
}

export enum LeaseStatus {
  ACTIVE    = 'active',
  EXPIRED   = 'expired',
  PENDING   = 'pending',
  TERMINATED = 'terminated',
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

export enum MaintenanceStatus {
  OPEN       = 'open',
  ASSIGNED   = 'assigned',
  IN_PROGRESS = 'in_progress',
  COMPLETED  = 'completed',
  CANCELLED  = 'cancelled',
}

export enum MaintenancePriority {
  EMERGENCY = 'emergency',
  HIGH      = 'high',
  NORMAL    = 'normal',
  LOW       = 'low',
}

export enum DepositStatus {
  PENDING    = 'pending',     // FlexDeposit installments in progress
  FUNDED     = 'funded',      // Fully funded
  PARTIAL    = 'partial',     // Installment defaulted — partially funded
  DISBURSED  = 'disbursed',   // Returned at move-out
  CLAIMED    = 'claimed',     // Applied to damages
}

export enum DocumentType {
  LEASE           = 'lease',
  ADDENDUM        = 'addendum',
  MOVE_IN_CHECKLIST = 'move_in_checklist',
  MOVE_OUT_CHECKLIST = 'move_out_checklist',
  NOTICE          = 'notice',
  OTHER           = 'other',
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
  type: DocumentType
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

