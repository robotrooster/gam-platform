/**
 * S655 money plan, Step 13 — FlexPay in the tenant app.
 *
 * Two things live here so they can be tested apart from the 5,000-line app
 * shell (main.tsx):
 *
 * 1. The pull days a tenant may pick. Nic (10/2): no FlexPay pull on the 1st
 *    through the 5th. The list comes from FLEXPAY_FORBIDDEN_PULL_DAYS (shared),
 *    the same constant enrollFlexPay and the pull-day change refuse by, so the
 *    picker can never offer a day the server turns down.
 *
 * 2. The card that tells the tenant what FlexPay did with this month's bill:
 *    "Your October bill was paid on time by FlexPay. $X will be drawn from your
 *    bank on Oct 20." It is read from the tenant's own 'flexpay_bill_covered'
 *    notification (services/flexpay notifyTenantOfCover) — the server's own
 *    statement to them, with the pull date and the amounts — and shows only
 *    while that draw is still ahead.
 *
 * Words (decisions.md #35.8, binding): FlexPay is a payment-date coordination
 * subscription. Nothing here says FlexPay advances, fronts, lends or loans
 * money; the landlord is paid a bill the tenant already owed, and GAM draws it
 * from the tenant's bank on the day they chose.
 */
import { FLEXPAY_FORBIDDEN_PULL_DAYS, PLATFORM_FEES, formatCurrency } from '@gam/shared'

/** The last pull day offered: the 29th–31st do not exist every month. */
export const FLEXPAY_LAST_PULL_DAY = 28

/** Every pull day a tenant may choose, in order (the 6th through the 28th today). */
export const FLEXPAY_PULL_DAY_OPTIONS: readonly number[] = Array.from({ length: FLEXPAY_LAST_PULL_DAY }, (_, i) => i + 1)
  .filter((d) => !(FLEXPAY_FORBIDDEN_PULL_DAYS as readonly number[]).includes(d))

export const FLEXPAY_FIRST_PULL_DAY = FLEXPAY_PULL_DAY_OPTIONS[0]

/** "6th through the 28th" — said from the same list the picker offers. */
export function pullDayRangeText(): string {
  return `${ordinal(FLEXPAY_FIRST_PULL_DAY)} through the ${ordinal(FLEXPAY_LAST_PULL_DAY)}`
}

/**
 * A day the picker can show: the one given when it is offered, else the
 * nearest offered day after it (a day stored before the 1st–5th rule).
 */
export function offeredPullDay(day: number | null | undefined, fallback = 15): number {
  const d = Number.isInteger(day) ? (day as number) : fallback
  if (FLEXPAY_PULL_DAY_OPTIONS.includes(d)) return d
  return FLEXPAY_PULL_DAY_OPTIONS.find((x) => x > d) ?? FLEXPAY_PULL_DAY_OPTIONS[FLEXPAY_PULL_DAY_OPTIONS.length - 1]
}

export function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd']
  const v = n % 100
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`
}

/** A notification as GET /notifications returns it (its `data` is the server's JSON, keys as written). */
export interface TenantNotice {
  type:  string
  title?: string | null
  body?:  string | null
  data?:  unknown
}

export interface FlexPayBillCard {
  headline:  string
  /** Lines of the bill still the tenant's to pay, when any. */
  stillDue:  string | null
  drawAmount: number
  /** 'YYYY-MM-DD' — the day GAM draws it. */
  drawOn:    string
}

const YMD = /^\d{4}-\d{2}-\d{2}$/

function monthOf(ymd: string): string {
  const [y, m] = ymd.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' })
}

/** 'YYYY-MM-DD' → "Oct 20". */
export function shortDay(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
}

/** Today on the tenant's own calendar, 'YYYY-MM-DD'. */
export function localToday(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`
}

/**
 * One key of the notice's data. The API passes a notification's `data` through
 * as written (camelize's JSONB passthrough), so its keys are the server's
 * snake_case; the camelCase spelling is read too, should that ever change.
 */
function field(data: unknown, key: string): unknown {
  let d: any = data
  if (typeof d === 'string') { try { d = JSON.parse(d) } catch { return undefined } }
  if (!d || typeof d !== 'object') return undefined
  const camel = key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())
  return d[key] ?? d[camel]
}

/**
 * The current FlexPay cycle as GET /tenants/flexpay returns it (`currentCycle`),
 * once the server sends it. Read before the notice: the notice is an in-app
 * notification, which a tenant can turn off and which scrolls out of the newest
 * 100; the cycle is the server's record itself.
 */
export interface FlexPayCycle {
  /** 'YYYY-MM-DD', the first day of the bill's month. */
  cycleMonth:   string
  /** What FlexPay paid the landlord on this bill. */
  covered:      number
  /** What GAM draws for the bill (before the monthly fee). */
  collectTotal: number
  /** 'YYYY-MM-DD' — the day GAM draws it. */
  pullDate:     string
  /** Paid after the landlord's late-fee day: never called "on time". */
  late:         boolean
  /** Lines of the bill still the tenant's to pay. */
  stillDue?:    { label: string; amount: number }[]
  /** Lines a called-off bank retry also carried — still the tenant's to pay. */
  retryCalledOff?: { label: string; amount: number }[]
  /** 'YYYY-MM-DD' — the bill's due date; the server names the bill by it. */
  dueDate?:     string
  /** FlexPay's payment went onto an earlier open bill: named "your bill due <day>". */
  addedToEarlier?: boolean
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

/** 'YYYY-MM-DD' → "October 20", as the server's notice says a day. */
function longDay(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' })
}

/**
 * Which bill, named as the server's notice names it (services/flexpay
 * notifyTenantOfCover): by the bill's due date — "bill due October 5" when
 * FlexPay's payment went onto an earlier open bill, else "<month of the due
 * date> bill". Without a due date, the notice's own title is read; the cycle's
 * month only as a last resort. Returns the words after "your", or null.
 */
function billName(o: { dueDate?: unknown; addedToEarlier?: unknown; title?: unknown; cycle: string }): string | null {
  const due = String(o.dueDate ?? '').slice(0, 10)
  const title = String(o.title ?? '')
  const earlier = o.addedToEarlier === true || /\byour bill due\b/i.test(title)
  if (YMD.test(due)) return earlier ? `bill due ${longDay(due)}` : `${monthOf(due)} bill`
  const dueIn = /\byour bill due ([A-Z][a-z]+ \d{1,2})\b/.exec(title)
  if (dueIn && MONTHS.includes(dueIn[1].split(' ')[0])) return `bill due ${dueIn[1]}`
  const monthIn = /\byour ([A-Z][a-z]+) bill\b/.exec(title)
  if (monthIn && MONTHS.includes(monthIn[1])) return `${monthIn[1]} bill`
  return YMD.test(o.cycle) ? `${monthOf(o.cycle)} bill` : null
}

const lineText = (lines: unknown): string[] => Array.isArray(lines)
  ? lines.map((l: any) => (l && l.label != null && l.amount != null ? `${l.label} ${formatCurrency(Number(l.amount))}` : null))
      .filter((x): x is string => !!x)
  : []

function buildCard(o: {
  bill: string | null; covered: number; collected: number; drawOn: string; onTime: boolean
  stillDue: unknown; retryCalledOff?: unknown
}, today: string): FlexPayBillCard | null {
  if (!YMD.test(o.drawOn) || o.drawOn < today) return null
  const fee = PLATFORM_FEES.FLOAT_FEE_MO
  const bill = o.bill ? `Your ${o.bill}` : 'Your bill'
  const drawAmount = Math.round(((o.covered > 0 ? o.collected : 0) + fee) * 100) / 100
  const when = `${formatCurrency(drawAmount)} will be drawn from your bank on ${shortDay(o.drawOn)}.`
  const due = lineText(o.stillDue)
  // A bank retry FlexPay called off may have carried other lines; the server's
  // notice says they "are still due", so the card names them too.
  const retry = lineText(o.retryCalledOff)
  const yourBill = o.bill ? `your ${o.bill}` : 'your bill'
  const headline = o.covered > 0
    ? (o.onTime ? `${bill} was paid on time by FlexPay. ${when}` : `FlexPay paid ${yourBill}. ${when}`)
    : due.length > 0
      ? `FlexPay had nothing to pay on ${yourBill}. ${when}`
      : `${bill} was already paid, so FlexPay paid nothing this month. ${when}`
  const all = [...due, ...retry]
  return {
    headline,
    stillDue: all.length === 0 ? null
      : retry.length === 0 ? `Still yours to pay on this bill: ${all.join(', ')}.`
      : `Still yours to pay: ${all.join(', ')}.`,
    drawAmount,
    drawOn: o.drawOn,
  }
}

/**
 * The card for this month's FlexPay bill, or null when there is none or its
 * draw day has passed. `today` is 'YYYY-MM-DD'. The server's current cycle
 * (GET /tenants/flexpay `currentCycle`) is read first; without it, the newest
 * FlexPay bill notice (notices newest first).
 */
export function flexPayBillCard(notices: TenantNotice[], today: string, cycle?: FlexPayCycle | null): FlexPayBillCard | null {
  if (cycle && YMD.test(String(cycle.pullDate ?? '').slice(0, 10))) {
    const covered = Number(cycle.covered) || 0
    return buildCard({
      bill: billName({ dueDate: cycle.dueDate, addedToEarlier: cycle.addedToEarlier, cycle: String(cycle.cycleMonth ?? '').slice(0, 10) }),
      covered,
      collected: Number(cycle.collectTotal ?? covered) || 0,
      drawOn: String(cycle.pullDate).slice(0, 10),
      onTime: cycle.late !== true,
      stillDue: cycle.stillDue ?? [],
      retryCalledOff: cycle.retryCalledOff ?? [],
    }, today)
  }
  const n = notices.find((x) => x.type === 'flexpay_bill_covered')
  if (!n) return null
  const covered = Number(field(n.data, 'covered') ?? 0) || 0
  return buildCard({
    bill: billName({
      dueDate: field(n.data, 'due_date'), addedToEarlier: field(n.data, 'added_to_earlier'),
      title: n.title, cycle: String(field(n.data, 'cycle') ?? '').slice(0, 10),
    }),
    covered,
    collected: Number(field(n.data, 'collect_total') ?? covered) || 0,
    drawOn: String(field(n.data, 'pull_date') ?? '').slice(0, 10),
    // The server says "on time" only when FlexPay paid before the late-fee day.
    onTime: /\bon time\b/i.test(String(n.body ?? '')),
    stillDue: field(n.data, 'still_due'),
    retryCalledOff: field(n.data, 'retry_called_off'),
  }, today)
}
