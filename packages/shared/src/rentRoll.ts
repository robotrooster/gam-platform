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
//                      open month's rows only): the owner uses it, or its
//                      record says it is in use. Never "Vacant" (10/13 review:
//                      Nic's gray Vacant row is for an EMPTY space). Its words
//                      are the space's own record — "Owner Use", … — never a
//                      payment status.
//   stay       GRAY    a stay guest's row (the open month's rows only): a
//                      guest checked in now, or a stay paid toward this month.
//                      10/13 (Nic): "the payments page ... should show all money
//                      coming in. The people that paid short-term stays like
//                      Space RV 10 and 11 at Mountain View, those should have
//                      details of the money that was paid." Its words are the
//                      booking's own ("Checked in", "Checked out", "Confirmed"),
//                      never a payment status: a stay is paid up front, not
//                      billed by the month.
// Late fees never decide it (10/12: "Late fees are never a bill and never
// decide a month's color"); they are in Invoiced and Owed.
export const RENT_ROLL_MONTH_STATUSES = ['paid', 'paid_late', 'partial', 'owes', 'due', 'none'] as const
export type RentRollMonthStatus = typeof RENT_ROLL_MONTH_STATUSES[number]
export const RENT_ROLL_ROW_STATUSES = [...RENT_ROLL_MONTH_STATUSES, 'vacant', 'occupied', 'stay'] as const
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
  stay:      'Stay',
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
  stay:      'gray',
}

/**
 * A row that is a space, not a household (the open month): an empty space
 * (Vacant) or one in use with nobody on a lease (occupied). No bill, nobody to
 * report on or take a payment from. 10/13 (Nic): "just make them all clickable
 * even if they're vacant and just show you know an expanded box with nothing"
 * — it opens like every other row, to say nothing is billed on it (and to any
 * register sale or pay link that names it).
 */
export function isSpaceOnlyRow(row: { status: RentRollRowStatus }): boolean {
  return row.status === 'vacant' || row.status === 'occupied'
}

/**
 * A stay guest's row (the open month): what was paid toward a stay this month,
 * opened for the details. No bill, no tenant report, no desk window — a stay
 * is paid at the register, on a pay link or on the booking site.
 */
export function isStayRow(row: { status: RentRollRowStatus }): boolean {
  return row.status === 'stay'
}

/**
 * How a payment toward a stay was made (stay_payments.method — shared
 * STAY_PAYMENT_METHODS; the keys are kept equal by rentRoll.test.ts). A card
 * says where it was swiped: the booking site and a pay link paid online are
 * "Card · online", the register "Card · in person" (the Payments ledger's
 * words, shared paidByLabel).
 */
export const STAY_PAYMENT_METHOD_LABEL: Record<'card' | 'card_on_file' | 'cash' | 'check' | 'charge', string> = {
  card:         'Card',
  card_on_file: 'Card on file',
  cash:         'Cash',
  check:        'Check',
  charge:       'Charge account',
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
  /**
   * What it was for, on a stay's row (10/13, Nic: "details of the money that
   * was paid"): "Stay Oct 4 – Nov 4 · at the register", "Booking deposit · stay
   * Oct 12 – Oct 15 · booking site". Absent on a household's row — its charges
   * say what each payment paid.
   */
  forLabel?: string | null
}

/**
 * A stay's row (OpenMonthRow.stay): the stay itself, and any money that went
 * back to the guest this month (an early check-out's refund).
 */
export interface OpenMonthStay {
  bookingId: string
  /** 'YYYY-MM-DD' */
  checkIn: string
  checkOut: string
  nights: number
  /** The booking's own words: "Checked in", "Checked out", "Confirmed", … (BOOKING_STATUS_LABEL). */
  statusLabel: string
  /**
   * 10/13 (Nic): "Stay rows SHOW what's still owed" (e.g. a $360 balance link
   * still open) — what is still owed on the stay, all of it, by the one rule
   * the register and the pay links read (apps/api services/registerStay
   * reservationDue): its price less what was paid toward it; a stay its lease
   * bills, what is left of its deposit. 0 when paid up, canceled or a no-show.
   * The row's Owed (OpenMonthRow.owed) is what of it is owed NOW — billed on
   * its pay link, or the rest from arrival day (S649, Nic: "the other 90%
   * needs to generate on the day they're due to arrive"); before then the
   * row's Owed is 0 and the opened row says when it comes due (checkIn).
   */
  owed: number
  /**
   * 'YYYY-MM-DD': the day the stay's balance was billed on its pay link
   * (services/stayBalance — arrival day), while that balance is still unpaid;
   * null otherwise.
   */
  balanceBilledOn: string | null
  /** Of this month's stay money, what has gone back to the guest this month. */
  refunded: number
  refunds: Array<{
    refundId: string
    /** 'YYYY-MM-DD': the day it went back. */
    refundedOn: string
    amount: number
    /** The payment it went back to: "Cash · register Oct 6". */
    label: string
  }>
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
   * 'vacant:<unit id>' (an empty space), 'space:<unit id>' (a space in use
   * with nobody on a lease) or 'stay:<booking id>' (a stay guest's row).
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
   * A stay row's guest in words (the booking's guest name, else their
   * account's); null otherwise (a household's names are `residents`).
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
  /**
   * What paid them: money (still clearing included) and account credit — the
   * Paid column. On a stay row: the money paid toward the stay this month
   * (never in Invoiced or Owed: a stay is paid, not billed by the month).
   */
  paid: number
  /** Of `paid`, money still clearing. */
  clearing: number
  /** Of `paid`, account credit applied. */
  credit: number
  /** Covered by work trade (hours, never money). */
  workTrade: number
  /**
   * Still owed on the month's bills = invoiced − paid − work trade (the
   * difference after a partial). On a stay row (10/13, Nic: "Stay rows SHOW
   * what's still owed"): what is owed on the stay now — its balance billed on
   * its pay link, or the rest of it from arrival day; all that is still owed
   * on it is OpenMonthStay.owed. A stay is paid, not billed by the month, so it
   * is never in Invoiced.
   */
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
  /**
   * 10/13 (Nic): a small red "Delinquent" tag beside the name. Delinquent is
   * past the grace period with money still owed (S654, Nic: "flag a difference
   * between outstanding and delinquent based on when the grace period ends")
   * — this month's bill red "Owes +N", or an earlier month's here still owed
   * past its grace. Judged from the money as the row is built (the one
   * lateness rule, services/householdMonths), so it clears the moment the
   * household pays — never the space's overnight flag. Late fees alone never
   * make a household delinquent (they never decide a month's color).
   */
  delinquent: boolean
  /**
   * The charge the desk window opens on to log a payment (POST
   * /payments/:id/record-manual — the one way to log a payment by hand; the
   * window settles the household's whole balance from it). Null when nothing
   * is open that the desk may take, or payments are blocked.
   */
  recordWith: string | null
  /**
   * The expanded row: each payment toward this month's bills, oldest first —
   * on a stay row, each payment toward the stay made this month (`forLabel`
   * says what it was for).
   */
  payments: RentRollPayment[]
  /** The expanded row: every charge on the month's bills (none on a stay row). */
  charges: RentRollCharge[]
  /** A stay row's stay (status 'stay'); null on every other row. */
  stay: OpenMonthStay | null
  /**
   * 10/13 (Nic): "Pay links / register sales that name a space go ON that
   * space's row" (Andres Razo's $752.17 electric pay link for RV 27 is RV 27's).
   * Every register sale and pay link this month whose items or label name this
   * row's space — and what went back on one at the register this month — oldest
   * first, in the same lines the folder uses (OpenMonthRoll.otherMoney keeps
   * only money that names no space). Never in Invoiced, Paid or Owed: it is no
   * bill. [] when none.
   */
  otherMoney: OpenMonthOtherMoney[]
  /** Of `otherMoney`, the money that came in (its sales). */
  otherIn: number
  /** Of `otherMoney`, what went back at the register this month (its refunds). */
  otherRefunded: number
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
  /**
   * 10/13 (Nic): "show all money coming in" — the money paid toward stays this
   * month (the stay rows' Paid), apart from the bills' Paid so Invoiced = Paid
   * + work trade + Owed still adds up; and of it, what went back this month.
   */
  stays: number
  staysRefunded: number
  /**
   * 10/13 (Nic): "Stay rows SHOW what's still owed" — what is owed now on the
   * stays shown (the stay rows' Owed), apart from the bills' Owed.
   */
  staysOwed: number
  /**
   * 10/13 (Nic): "show ALL money coming in" — the register sales and pay links
   * this month that are no household's bill and no stay's, wherever they show
   * (on the row of the space they name, or in the folder), and of them what
   * went back at the register this month. Apart from the bills and the stays,
   * so each adds up on its own.
   */
  otherIn: number
  otherRefunded: number
  /**
   * Of `otherIn` / `otherRefunded`, the folder's (OpenMonthRoll.otherMoney —
   * 10/13, Nic: "only money with no space stays in the folder"); the rest is on
   * the rows of the spaces it names (OpenMonthRow.otherIn).
   */
  folderIn: number
  folderRefunded: number
  /**
   * 10/14 (Nic): what the "Moved out, still owes" section owes (the sum of
   * OpenMonthRoll.movedOutOwing), apart from the month's Owed and the earlier
   * months' — nobody in it is a row. Absent from an older server.
   */
  movedOutOwed?: number
}

/**
 * 10/14 (Nic): "A checked-out guest still owing, nothing paid this month:
 * show in the moved-out section of Payments." One entry of the Payments page's
 * "Moved out, still owes" section: a household whose lease ended and who no
 * longer lives here, still owing on earlier months (with a bill this month it
 * is a row, tagged Moved out, instead), or a stay whose guest checked out with
 * money still owed on it and nothing paid toward it this month (one paid
 * toward this month is a stay row). Never a row as well.
 */
export interface OpenMonthMovedOut {
  /** 'lease:<id>' (a household) or 'stay:<booking id>'. */
  key: string
  kind: 'household' | 'stay'
  space: string | null
  leaseId: string | null
  householdId: string | null
  /** A household's residents, primary first; [] on a stay. */
  residents: RentRollResident[]
  /** A stay's guest in words (the booking's guest name, else their resident's); null on a household. */
  guest: string | null
  /** 'YYYY-MM-DD': the day they left — the lease's end, or the stay's check-out; null when not on record. */
  leftOn: string | null
  /** A stay's dates in words ("Sep 1 – Oct 1"); null on a household. */
  stayDates: string | null
  /** Everything still owed here (a stay: by the register's own rule — its price less what was paid toward it). */
  owed: number
  /** A household's months still owed, oldest first; [] on a stay. */
  months: Array<{ month: string; owed: number }>
}

/**
 * 10/13 (Nic): "the payments page ... should show all money coming in." One
 * line of the money that came in at the property this month that is no
 * household's bill and no stay's: a register sale (propane to a walk-in), an
 * emailed pay link paid by someone with no lease or stay here — or what went
 * back on one at the register this month (`kind: 'refund'`). A sale that paid
 * toward a stay as well is here only for the rest of it (the stay's part is on
 * the stay's row); a refund comes off the sale's other items first (the early
 * check-out's rule), so only what is beyond them is the stay's. Never a charge
 * account sale (no money came in: it is collected later), never a voided one,
 * never the background check GAM keeps, never the card fee paid on top.
 */
export interface OpenMonthOtherMoney {
  /** The sale (register or pay link), or the refund on it. */
  id: string
  saleId: string
  kind: 'sale' | 'refund'
  /** 'YYYY-MM-DD': the day it came in, or went back (the property's calendar). */
  day: string
  /** Money in (a sale) or given back (a refund), dollars. */
  amount: number
  /** "Cash", "Card · in person", "Card · online", "Check" … (never a raw value). */
  methodLabel: string
  /** What it was for: the items sold and where — "Propane · at the register", "RV site — monthly, Electric (per kWh) · pay link". */
  forLabel: string
  /** Who paid: the resident's or the customer's name; null — nobody named (a walk-in). */
  who: string | null
  /**
   * 10/13 (Nic): "When Andres Razo paid by card online for his stay ... it
   * looks like that charge is just for electric ... It's not got a good
   * breakdown between what's a billback on the electricity and what is not."
   * A sale's breakdown, from its own line items: each part with its own amount
   * and what it is — "Electric (per kWh) — September, RV 27" an electric
   * bill-back, 390 kWh × $0.21, $81.90; "RV site — monthly" site rent,
   * $589.00 — then its tax, and what comes off: a discount, the background
   * check (the screening's), the part toward a stay (on the stay's row). The
   * parts add up to `amount`. [] on a refund. Absent from an older server.
   */
  parts?: OpenMonthSalePart[]
  /**
   * The card fee the payer paid on top of the sale (pos_transactions.surcharge)
   * — never in `amount`, never the landlord's money; 0 when none (cash, or the
   * landlord absorbs it). Only on a sale.
   */
  cardFee?: number
}

/** One part of a register sale or pay link (OpenMonthOtherMoney.parts). */
export interface OpenMonthSalePart {
  /**
   * item     one line the sale sold (pos_transaction_items);
   * tax      a tax on it (the sale's own named taxes, else "Tax");
   * discount what the register took off (negative);
   * screening the background check in it — the screening's, not the landlord's (negative);
   * stay     its part toward a stay — shown on the stay's row (negative);
   * rest     what is left of the sale's total that its lines do not show.
   */
  kind: 'item' | 'tax' | 'discount' | 'screening' | 'stay' | 'rest'
  /** In words: the item's name as sold ("Electric (per kWh) — September, RV 27"), the tax's name, "Discount" … */
  label: string
  /**
   * What an item IS, in words, when the register says: "Electric bill-back"
   * (a utility sold off a meter — the utility recovery report's own rule,
   * routes/utility registerUtilityType), "Site rent" (a stay item: a night, a
   * week or a month on a site); null for anything else (propane, a fee …).
   */
  what: string | null
  /** How many (an item's quantity), and the price of one; null when it is not an item. */
  qty: number | null
  unitPrice: number | null
  /** What one is, from the item's name ("kWh" in "Electric (per kWh)"); null when the name does not say. */
  unit: string | null
  /** Dollars: what it adds to the sale (an item, a tax), or takes off it (negative). */
  amount: number
}

/** GET /api/balances/rent-roll/open-month?propertyId= — the Payments page. */
export interface OpenMonthRoll {
  propertyId: string
  propertyName: string
  /** 'YYYY-MM': the open month (the property's calendar). */
  month: string
  /**
   * Every space, one row per household (lease), a Vacant row for an empty
   * space and an occupied row for a space in use with nobody on a lease; a
   * stay guest's row for a stay checked in, paid toward this month, or — its
   * guest still coming or here — owing on its billed balance; and any
   * household here still owing on an earlier lease. Ordered: rows still owing
   * (owed + owedEarlier > 0) first, then the rest; each group in space order
   * (compareSpaces).
   */
  rows: OpenMonthRow[]
  /**
   * 10/13 (Nic): "show ALL money coming in" — the register sales and pay links
   * of the month that are no household's bill and no stay's, and what went
   * back on them at the register this month, oldest first. 10/13 (Nic): "only
   * money with no space stays in the folder" — one that names a space is on
   * that space's row (OpenMonthRow.otherMoney), never here as well.
   */
  otherMoney: OpenMonthOtherMoney[]
  /**
   * 10/14 (Nic): the "Moved out, still owes" section under the month — every
   * household no longer living here still owing on earlier months, and every
   * stay whose guest checked out still owing with nothing paid this month
   * (OpenMonthMovedOut), in space order. [] when nobody. Absent from an older
   * server.
   */
  movedOutOwing?: OpenMonthMovedOut[]
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
  /**
   * "50%, 1 of 2 months"; nothing counted yet: "Onboarding month — not
   * counted" (the onboarding month was left out, 10/13, Nic: "Keep it out, but
   * say so") or "No months to judge yet".
   */
  label: string
  /**
   * The onboarding month was judged and left out (paid late on moving onto
   * GAM, no late fee on the bill — good news only). Absent from an older server.
   */
  onboardingLeftOut?: boolean
}

/**
 * 10/13 (Nic), the onboarding month at Mountain View (September): "Keep it
 * out, but say so." What payment health says when nothing is counted yet —
 * never a bare dash (services/householdMonths paymentHealth's label).
 */
export const HEALTH_ONBOARDING_NOT_COUNTED = 'Onboarding month — not counted'
export const HEALTH_NOTHING_JUDGED = 'No months to judge yet'

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

/**
 * How many households earned each status in a month ("Oct: 3 late") — the
 * rows' and (10/13, Nic: "Rent Roll month counts INCLUDE the moved-out
 * folder") the "Moved out, still owes" households' bills that month.
 */
export interface RentRollMonthCount {
  month: string
  counts: Array<{ status: RentRollMonthStatus; label: string; households: number }>
}

/**
 * 10/13 (Nic): "Moved out, still owes" — a collapsed folder, each household
 * until paid. 10/14 (Nic): it also lists every stay guest who checked out
 * still owing — the Payments page's rule and words (OpenMonthMovedOut), its
 * key 'stay:<booking id>'.
 */
export interface RentRollMovedOutOwing {
  key: string
  /** A household, or a stay whose guest checked out still owing (10/14). */
  kind: 'household' | 'stay'
  leaseId: string | null
  householdId: string | null
  /** A household's residents, primary first; [] on a stay. */
  residents: RentRollResident[]
  /** A stay's guest in words (the booking's guest name, else their resident's); null on a household. */
  guest: string | null
  /** A stay's dates in words ("Sep 1 – Oct 1"); null on a household. */
  stayDates: string | null
  /** 'YYYY-MM-DD': the day a stay's guest checked out; null on a household (its day is `leaseEnded`). */
  checkedOut: string | null
  spaces: string[]
  /** Everything still owed on its bills here, all time (a stay: by the register's own rule — its price less what was paid toward it). */
  owed: number
  /** The months it still owes on, oldest first; [] on a stay. */
  months: Array<{ month: string; owed: number }>
  /**
   * 'YYYY-MM-DD': the day the lease ended (terminated, else its end date);
   * null when not on record, or for a bookkeeper whose owner left "Show lease
   * start and end dates" unticked (10/12, Nic: the owner's choice per
   * bookkeeper).
   */
  leaseEnded: string | null
  /**
   * Its bills in the range (zero when none; a stay is no bill, always zero): what the range totals count for
   * it (10/13, Nic: "Range totals INCLUDE moved-out folder households"), so a
   * printout or spreadsheet can show where the totals' extra comes from.
   */
  inRange: RentRollTotals
}

// ─── Stays on the Rent Roll (10/13, Nic) ─────────────────────────────────────
//
//   "show stays as an aggregate by line items. eg 22 nights paid for via pos
//    and 1 week paid for via pos. otherwise when people use the same sites
//    over again in a month it will look funny on the report. dont put these
//    stays in the spot put them below with expandable notes. 4 nights in 15
//    and 8 nights in 18 etc."

/**
 * What one of a stay's line items buys — the register's stay items
 * (pos_items.stay_unit, whose CHECK lists the same three) and a stay booked
 * online, by its length.
 */
export const RENT_ROLL_STAY_UNITS = ['night', 'week', 'month'] as const
export type RentRollStayUnit = typeof RENT_ROLL_STAY_UNITS[number]
export const RENT_ROLL_STAY_UNIT_LABEL: Record<RentRollStayUnit, { one: string; many: string }> = {
  night: { one: 'night', many: 'nights' },
  week:  { one: 'week', many: 'weeks' },
  month: { one: 'month', many: 'months' },
}

/**
 * How a stay's line items were paid for: rung at the register or on a pay link
 * (POS — the stay item's line on the sale), or booked and paid on the booking
 * site (its deposit, and the balance link after it).
 */
export const RENT_ROLL_STAY_VIAS = ['pos', 'booking_site'] as const
export type RentRollStayVia = typeof RENT_ROLL_STAY_VIAS[number]
export const RENT_ROLL_STAY_VIA_LABEL: Record<RentRollStayVia, string> = {
  pos:          'POS',
  booking_site: 'the booking site',
}

/** "22 nights", "1 week", "2.5 months" (a register quantity can carry decimals). */
export function stayQuantityText(quantity: number, unit: RentRollStayUnit): string {
  const q = Math.round(Number(quantity) * 1000) / 1000
  const words = RENT_ROLL_STAY_UNIT_LABEL[unit] ?? RENT_ROLL_STAY_UNIT_LABEL.night
  return `${q.toLocaleString('en-US', { maximumFractionDigits: 3 })} ${q === 1 ? words.one : words.many}`
}

/** One aggregate line of the range's stays: "22 nights paid for via POS", opened for its notes per site. */
export interface RentRollStayLine {
  /** '<unit>:<via>' */
  key: string
  unit: RentRollStayUnit
  via: RentRollStayVia
  /** Every line item of the kind in the range added up: 22 (nights). */
  quantity: number
  /** "22 nights paid for via POS" */
  label: string
  /** How many stays (or sales of a stay item with no stay on the schedule) it adds up. */
  stays: number
  /**
   * What the property kept for them (10/14, Nic: refunds — an early
   * check-out's — are subtracted): a stay on the schedule, what was paid
   * toward it less what went back, with its nights — the share of its nights
   * in the range (10/14, Nic: "each month counts only its own nights"), so a
   * month paid late is in its own month, as a bill paid late is; a stay item
   * sold with no stay on the schedule, its line, in the month sold. Sent only
   * with the range totals (decisions #25: a sum across guests).
   */
  paid?: number
  /**
   * The expandable notes, per site in space order: "4 nights in RV 15", "8
   * nights in RV 18" — a site used twice in the range is one note with both
   * stays' nights. A line item that names no site: space null, "2 nights, no
   * site named".
   */
  sites: Array<{ space: string | null; quantity: number; stays: number; label: string }>
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
   * folder until paid"), never twice. `monthCounts` are these rows' and the
   * folder households' (10/13, Nic: "month counts INCLUDE the moved-out
   * folder").
   */
  rows: RentRollHistoryRow[]
  /** Not limited to the range: everyone no longer living here who still owes. */
  movedOutOwing: RentRollMovedOutOwing[]
  /**
   * 10/13 (Nic): the range's stays BELOW the lease rows, never in the spaces'
   * spots — an aggregate by line item ("22 nights paid for via POS", "1 week
   * paid for via POS"), each with its notes per site ("4 nights in RV 15").
   * 10/14 (Nic): "each month counts only its own nights" — a stay paid for
   * (money in, a charge account's never) is the range's by its nights in it:
   * the whole length it was sold for when all of it is in the range ("1
   * month"), else only its nights in the range (Sep 1 – Nov 1: 30 nights in
   * September, 31 in October). A stay that checked out early with nights
   * refunded counts the nights actually stayed (10/14, Nic: "booked 7, stayed
   * 3, refunded 4 → 3 nights"). A stay item sold with no stay on the schedule
   * is the month it was sold. A stay that became a lease is that lease's row.
   * Nights, weeks, then months; POS before the booking site. [] when none.
   */
  stays: RentRollStayLine[]
  /**
   * The rows' money for the range AND the "Moved out, still owes" households'
   * bills in the range (10/13, Nic: "Range totals INCLUDE moved-out folder
   * households") — the property's whole range, every dollar once.
   */
  totals?: RentRollTotals
  /**
   * Of `totals`, the "Moved out, still owes" households' bills in the range
   * (the sum of their `inRange`), sent with `totals`: `totals` = the rows'
   * sums + this, so the printout and the spreadsheet add up.
   */
  movedOutTotals?: RentRollTotals
}

// ─── Retired 10/13 ───────────────────────────────────────────────────────────
//
// 10/13 (Nic): "Remove the 'keep moved-out households' setting entirely." The
// setting's values (RENT_ROLL_MOVED_OUT_RULES and its labels) were kept here
// only while the landlord Rent Roll page still imported them; nothing does any
// more, so they are gone. The column landlords.rent_roll_moved_out and its
// CHECK stay until a contract migration drops them (expand, then contract) —
// nothing reads or writes them.
