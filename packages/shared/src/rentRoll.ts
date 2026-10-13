// 10/13 (Nic) — THE PAYMENTS PAGE (THE OPEN MONTH) AND THE RENT ROLL (HISTORY).
//
//   "the payments page is the rent roll for the open month. And the rent roll
//    page is the historical lookup for previous reportings for quarters or
//    years or individual months or whatever."
//
// The wire shapes of GET /api/balances/rent-roll/properties, /open-month and
// /history (apps/api/src/services/rentRoll.ts builds them; its header is the
// contract). Their keys are camelCase as built, so the portals' camelize
// passes them through unchanged and these types are what both sides read.
// Money is in dollars (two decimals); days are 'YYYY-MM-DD' and months
// 'YYYY-MM' on the property's calendar.

// ─── Status: one colored pill (10/13, Nic) ───────────────────────────────────
//
//   paid       GREEN   paid in full within grace (a month work trade covers in
//                      full is paid, method "Work trade")
//   paid_late  ORANGE  paid in full after grace — "Paid late +N" (N = days past grace)
//   partial    YELLOW  part paid, still within grace
//   owes       RED     past grace with money still owed, whether nothing or
//                      part was paid — "Owes +N"
//   due        GRAY    nothing paid, not yet past grace — "Due <date>"
//   none       GRAY    no bill that month: nothing billed, or only late fees or a
//                      deposit (never a bill — 10/12) — a history cell, or a
//                      household whose month has no bill yet
//   vacant     GRAY    an empty space (the open month's rows only)
//   occupied   GRAY    a space nobody holds on a lease that is NOT empty (the
//                      open month's rows only): the owner uses it, a stay guest
//                      is checked in, or its record says it is in use. Never
//                      "Vacant" (10/13 review: Nic's gray Vacant row is for an
//                      EMPTY space). Its words are the space's own record —
//                      "Owner Use", "Checked in", … — never a payment status.
// Late fees never decide it (10/12: "Late fees are never a bill and never
// decide a month's color"); they are in Invoiced and Owed.
export const RENT_ROLL_MONTH_STATUSES = ['paid', 'paid_late', 'partial', 'owes', 'due', 'none'] as const
export type RentRollMonthStatus = typeof RENT_ROLL_MONTH_STATUSES[number]
export const RENT_ROLL_ROW_STATUSES = [...RENT_ROLL_MONTH_STATUSES, 'vacant', 'occupied'] as const
export type RentRollRowStatus = typeof RENT_ROLL_ROW_STATUSES[number]
export const RENT_ROLL_STATUS_LABEL: Record<RentRollRowStatus, string> = {
  paid:      'Paid',
  paid_late: 'Paid late',
  partial:   'Partial',
  owes:      'Owes',
  due:       'Due',
  none:      'No bill',
  vacant:    'Vacant',
  occupied:  'Occupied',
}
export const RENT_ROLL_STATUS_COLORS = ['green', 'orange', 'yellow', 'red', 'gray'] as const
export type RentRollStatusColor = typeof RENT_ROLL_STATUS_COLORS[number]
export const RENT_ROLL_STATUS_COLOR: Record<RentRollRowStatus, RentRollStatusColor> = {
  paid:      'green',
  paid_late: 'orange',
  partial:   'yellow',
  owes:      'red',
  due:       'gray',
  none:      'gray',
  vacant:    'gray',
  occupied:  'gray',
}

/**
 * A row that is a space, not a household (the open month): an empty space
 * (Vacant) or one in use with nobody on a lease (occupied). No money, nothing
 * to open, nobody to report on or take a payment from.
 */
export function isSpaceOnlyRow(row: { status: RentRollRowStatus }): boolean {
  return row.status === 'vacant' || row.status === 'occupied'
}

/**
 * A month's payment-health stamp (the one definition, apps/api
 * services/householdMonths judgeMonth — 'paid_on_time' | 'partial' |
 * 'paid_late' | 'outstanding' | 'due', or null when nothing was billed) and its
 * days past grace → the status these pages show. 10/13 (Nic): "A partial
 * payment past grace with money still owed = red 'Owes +N'" — a partial stays
 * yellow only while it is inside its grace period. Typed by its values so this
 * file needs nothing from the package index.
 */
export function rentRollStatusOf(
  stamp: 'paid_on_time' | 'partial' | 'paid_late' | 'outstanding' | 'due' | null | undefined,
  daysPastGrace: number,
): RentRollMonthStatus {
  switch (stamp) {
    case 'paid_on_time': return 'paid'
    case 'paid_late':    return 'paid_late'
    case 'partial':      return daysPastGrace > 0 ? 'owes' : 'partial'
    case 'outstanding':  return 'owes'
    case 'due':          return 'due'
    default:             return 'none'
  }
}

const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * The pill's words (10/13, Nic): "Paid", "Paid late +5", "Partial", "Owes +3",
 * "Due Oct 1", "Vacant". `dueDate` is 'YYYY-MM-DD' (only "Due" reads it).
 */
export function rentRollStatusText(s: { status: RentRollRowStatus; daysPastGrace: number; dueDate?: string | null }): string {
  const label = RENT_ROLL_STATUS_LABEL[s.status]
  if ((s.status === 'paid_late' || s.status === 'owes') && s.daysPastGrace > 0) return `${label} +${s.daysPastGrace}`
  if (s.status === 'due' && s.dueDate && /^\d{4}-\d{2}-\d{2}$/.test(s.dueDate)) {
    return `${label} ${SHORT_MONTHS[Number(s.dueDate.slice(5, 7)) - 1]} ${Number(s.dueDate.slice(8, 10))}`
  }
  return label
}

// ─── Space order (10/13, Nic: "in order of space number") ───────────────────

const SPACE_COLLATOR = new Intl.Collator('en-US', { numeric: true, sensitivity: 'base' })

/**
 * Natural space order: RV 2 before RV 10, MH 03 before MH 12. A row with no
 * space sorts last.
 */
export function compareSpaces(a: string | null | undefined, b: string | null | undefined): number {
  if (!a && !b) return 0
  if (!a) return 1
  if (!b) return -1
  return SPACE_COLLATOR.compare(a, b)
}

// ─── The wire ────────────────────────────────────────────────────────────────

/** GET /api/balances/rent-roll/properties — the property picker (one property opens straight to it). */
export interface RentRollProperty {
  propertyId: string
  name: string
  /** Spaces at it today (retired ones left out). */
  spaces: number
  /**
   * One of the account's companies owns it now. false: sold or transferred out
   * of the account — the Rent Roll still shows the account's own old bills
   * there; it has no open month (the Payments page answers 404 for it).
   */
  owned: boolean
}

/** A resident on the household's lease (primary first). */
export interface RentRollResident {
  tenantId: string
  name: string
  primary: boolean
}

/** One payment toward a row's bills (the expanded row): its date, amount and how it was paid. */
export interface RentRollPayment {
  /** The Payments ledger's id for it (a receipt id, or an opaque key). */
  paymentId: string
  /** 'YYYY-MM-DD': the day they paid. */
  paidOn: string
  /** What it put on this row's bills: money plus any account credit it spent. */
  amount: number
  /** Of `amount`, account credit. */
  credit: number
  /** "Cash", "Check", "Card · online", "Bank (ACH)", "Paid from credit", … (never a raw value). */
  methodLabel: string
  /** 'settled' | 'clearing' | 'returned' (paymentsByMonth LEDGER_PAYMENT_STATUSES). */
  status: 'settled' | 'clearing' | 'returned'
  statusLabel: string
  /** A check or money-order number, a bank deposit's reference; null when none. */
  reference: string | null
}

/** One charge on a row's bills (the expanded row): what it is for and where it stands. */
export interface RentRollCharge {
  chargeId: string
  /** "What it's for": Rent, Water, Electric, Late fee, Home payment, … (never a raw type). */
  label: string
  detail: string | null
  /** 'YYYY-MM-DD': its bill's due date. */
  dueDate: string
  /** 'YYYY-MM': the bill month it belongs to. */
  month: string
  invoiced: number
  /** What paid it: money (still clearing included) and account credit. */
  paid: number
  /** Of `paid`, account credit. */
  credit: number
  /** Covered by work trade (hours, not money). */
  workTrade: number
  owed: number
  /** 'YYYY-MM-DD': the day it counts as paid in full; null while owed. */
  paidOn: string | null
  /** How it was paid, in words ("Cash", "Work trade", "Account credit"); null while unpaid. */
  howPaid: string | null
  /** Days past the grace period (paid: on the day paid; owed: today). */
  daysPastGrace: number
  isLateFee: boolean
  /** 10/6 (Nic): logged by hand after the late fee posted — counted late from the day it was logged. */
  loggedAfterLateFee: boolean
}

/**
 * One row of the open month: a household (a lease) on its space, or a space
 * with nobody on a lease — empty (Vacant) or in use (occupied).
 */
export interface OpenMonthRow {
  /**
   * Stable row key: 'lease:<id>', 'person:<tenant id>' (a charge on no lease),
   * 'vacant:<unit id>' (an empty space) or 'space:<unit id>' (a space in use
   * with nobody on a lease).
   */
  key: string
  unitId: string | null
  /** The space's number (units.unit_number); null for a household billed on no space. */
  space: string | null
  leaseId: string | null
  /** The household's primary resident — the tenant report's id (GET /tenants/:id/payment-report?leaseId=). */
  householdId: string | null
  residents: RentRollResident[]
  /**
   * An occupied space's occupant in words — the stay guest checked in there;
   * null otherwise (a household's names are `residents`).
   */
  occupant: string | null
  /**
   * Billed this month on a lease that has since ended (the household no
   * longer lives here). Every other row is a space's current household, a
   * space with nobody on a lease, a charge on no lease, or a household still
   * owing on an earlier lease here (`owedEarlier`).
   */
  movedOut: boolean
  /** Everything billed on the month's bills (late fees included; work trade's value included). */
  invoiced: number
  /** Of `invoiced`, late fees. */
  lateFees: number
  /** What paid them: money (still clearing included) and account credit — the Paid column. */
  paid: number
  /** Of `paid`, money still clearing. */
  clearing: number
  /** Of `paid`, account credit applied. */
  credit: number
  /** Covered by work trade (hours, never money). */
  workTrade: number
  /** Still owed on the month's bills = invoiced − paid − work trade (the difference after a partial). */
  owed: number
  /**
   * What the household still owes on EARLIER months' bills here (not in
   * `owed`, which is this month's alone, so Invoiced = Paid + work trade +
   * Owed still reads on the row). 10/13 (Nic): "outstanding balances are always
   * at the top of this list" — a row owing here, this month or earlier, sits
   * at the top; 0 when nothing.
   */
  owedEarlier: number
  /** How it was paid this month, oldest first: "Cash", "Card · online", "Work trade"… (the Payment method column). */
  methods: string[]
  status: RentRollRowStatus
  /** The pill's words (rentRollStatusText). */
  statusLabel: string
  statusColor: RentRollStatusColor
  daysPastGrace: number
  /** 'YYYY-MM-DD': the month's bill due date (for "Due <date>"); null when nothing billed. */
  dueDate: string | null
  /** Work trade covers every base charge of the month (status Paid, method "Work trade"). */
  workTradeOnly: boolean
  /** 10/13 (Nic): "eviction mode that blocks payments" — payments are blocked on this space. */
  evictionMode: boolean
  /** The space is marked delinquent. */
  delinquent: boolean
  /**
   * The charge the desk window opens on to log a payment (POST
   * /payments/:id/record-manual — the one way to log a payment by hand; the
   * window settles the household's whole balance from it). Null when nothing
   * is open that the desk may take, or payments are blocked.
   */
  recordWith: string | null
  /** The expanded row: each payment toward this month's bills, oldest first. */
  payments: RentRollPayment[]
  /** The expanded row: every charge on the month's bills. */
  charges: RentRollCharge[]
}

/**
 * Money summed over rows — only for a viewer the grand-total rule admits
 * (decisions #25). Every Paid on the wire is money plus account credit (of
 * which `credit`), so Invoiced = Paid + work trade + Owed.
 */
export interface RentRollTotals {
  invoiced: number
  lateFees: number
  paid: number
  /** Of `paid`, account credit. */
  credit: number
  workTrade: number
  owed: number
}

/** The open month's sums: the month's money, and what the rows still owe on earlier months. */
export interface OpenMonthTotals extends RentRollTotals {
  owedEarlier: number
}

/** GET /api/balances/rent-roll/open-month?propertyId= — the Payments page. */
export interface OpenMonthRoll {
  propertyId: string
  propertyName: string
  /** 'YYYY-MM': the open month (the property's calendar). */
  month: string
  /**
   * Every space, one row per household (lease), a Vacant row for an empty
   * space and an occupied row for a space in use with nobody on a lease; and
   * any household here still owing on an earlier lease. Ordered: rows still
   * owing (owed + owedEarlier > 0) first, then the rest; each group in space
   * order (compareSpaces).
   */
  rows: OpenMonthRow[]
  totals?: OpenMonthTotals
}

/** Payment health, the one definition (all time, per lease — 10/13: each lease its own household). */
export interface RentRollHealth {
  /** On-time months ÷ counted months, a whole percent; null when nothing is counted yet. */
  percent: number | null
  onTime: number
  counted: number
  paidLate: number
  partial: number
  outstanding: number
  notCounted: number
  workTrade: number
  /** 'YYYY-MM': first billed month … the month judged to. */
  from: string
  through: string
  /** "50%, 1 of 2 months" / "No months to judge yet". */
  label: string
}

/** One month's stamp on a history row. */
export interface RentRollStamp {
  /** 'YYYY-MM' */
  month: string
  status: RentRollMonthStatus
  /** "Paid late +5" — rentRollStatusText. */
  statusLabel: string
  statusColor: RentRollStatusColor
  daysPastGrace: number
  invoiced: number
  paid: number
  credit: number
  workTrade: number
  owed: number
  /** The household's first rent month after moving onto GAM (good news only). */
  onboarding: boolean
}

/** One household (a lease) on the history. */
export interface RentRollHistoryRow {
  /** 'lease:<id>' or 'person:<tenant id>'. */
  key: string
  leaseId: string | null
  householdId: string | null
  residents: RentRollResident[]
  /** The household's space(s) at this property, in space order. */
  spaces: string[]
  /**
   * The lease has ended and the household no longer lives at this property —
   * and owes nothing here (one still owing is in `movedOutOwing` instead).
   */
  movedOut: boolean
  /** Totals over the range's bills. */
  invoiced: number
  lateFees: number
  paid: number
  credit: number
  workTrade: number
  owed: number
  /** All time through the range's last month (10/12, Nic: health is all time), this lease alone. */
  health: RentRollHealth
  /** One stamp per month of the range, oldest first. */
  stamps: RentRollStamp[]
}

/** How many households earned each status in a month ("Oct: 3 late"). */
export interface RentRollMonthCount {
  month: string
  counts: Array<{ status: RentRollMonthStatus; label: string; households: number }>
}

/** 10/13 (Nic): "Moved out, still owes" — a collapsed folder, each household until paid. */
export interface RentRollMovedOutOwing {
  key: string
  leaseId: string | null
  householdId: string | null
  residents: RentRollResident[]
  spaces: string[]
  /** Everything still owed on its bills here, all time. */
  owed: number
  /** The months it still owes on, oldest first. */
  months: Array<{ month: string; owed: number }>
  /** 'YYYY-MM-DD': the day the lease ended (terminated, else its end date); null when not on record. */
  leaseEnded: string | null
}

/** GET /api/balances/rent-roll/history?propertyId=&from=&to= | &range=all — the Rent Roll page. */
export interface RentRollHistory {
  propertyId: string
  propertyName: string
  /** 'YYYY-MM' the range, inclusive. */
  from: string
  to: string
  allTime: boolean
  /** The range's months, oldest first (one stamp column each). */
  months: string[]
  monthCounts: RentRollMonthCount[]
  /**
   * Every household billed in the range, in space order — except anyone who
   * moved out and still owes: they are in `movedOutOwing` alone (10/13, Nic:
   * "Moved-out people who still owe sit in a collapsed 'Moved out, still owes'
   * folder until paid"), never twice. `totals` and `monthCounts` are these rows'.
   */
  rows: RentRollHistoryRow[]
  /** Not limited to the range: everyone no longer living here who still owes. */
  movedOutOwing: RentRollMovedOutOwing[]
  totals?: RentRollTotals
}

// ─── Retired 10/13 ───────────────────────────────────────────────────────────
//
// 10/13 (Nic): "Remove the 'keep moved-out households' setting entirely" — the
// API no longer reads or writes landlords.rent_roll_moved_out (the column
// stays: expand, then contract). These constants remain only while the
// landlord Rent Roll page still imports them; delete them with it.
//
// 10/12 (Nic) — THE RENT ROLL: WHO STAYS ON IT AFTER MOVING OUT.
//
// "who stays on the Rent Roll after moving out = LANDLORD'S CHOICE (a setting
//  on the page: billed in last 12 months / while they owe / all time)."
//
// Every household on an occupied space is always a row. This decides which
// households that moved out stay on the page too, per company. Mirrors
// landlords_rent_roll_moved_out_check (landlords.rent_roll_moved_out).
//   billed_last_12_months  billed in the 12 months through the month picked
//                          (the default — the page's rule before 10/12)
//   while_owing            while they still owe anything there
//   all_time               every household ever billed there
export const RENT_ROLL_MOVED_OUT_RULES = ['billed_last_12_months', 'while_owing', 'all_time'] as const
export type RentRollMovedOutRule = typeof RENT_ROLL_MOVED_OUT_RULES[number]
export const RENT_ROLL_MOVED_OUT_DEFAULT: RentRollMovedOutRule = 'billed_last_12_months'
export const RENT_ROLL_MOVED_OUT_LABEL: Record<RentRollMovedOutRule, string> = {
  billed_last_12_months: 'Billed in the last 12 months',
  while_owing:           'While they still owe',
  all_time:              'All time',
}
/** The empty page's sentence: who appears here under each rule. */
export const RENT_ROLL_MOVED_OUT_NOTE: Record<RentRollMovedOutRule, string> = {
  billed_last_12_months: 'Households on an occupied space, and anyone who moved out but was billed in the last 12 months, appear here.',
  while_owing:           'Households on an occupied space, and anyone who moved out but still owes, appear here.',
  all_time:              'Households on an occupied space, and everyone who ever lived here, appear here.',
}
export function isRentRollMovedOutRule(v: unknown): v is RentRollMovedOutRule {
  return typeof v === 'string' && (RENT_ROLL_MOVED_OUT_RULES as readonly string[]).includes(v)
}
