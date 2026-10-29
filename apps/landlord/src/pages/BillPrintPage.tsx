import { useQuery } from 'react-query'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { ArrowLeft, Printer } from 'lucide-react'
import { apiGet } from '../lib/api'
import '../styles/rent-roll.css'

/**
 * ── 10/27 (Nic): THE PAPER BILL ─────────────────────────────────────────────
 *
 *   "It's a setting on the landlord page, a property level setting. Do you want
 *    to print paper copies of the bills when these are generated? Make it
 *    easier. Just make a button on each invoice that can be printed and make it
 *    where there's a quick print all outstanding button."
 *
 * Why it exists (10/26): "We get a lot of people that still are old school.
 * Landlords that I talk to still hand deliver bills to the tenants' doors on
 * the first of each month, especially where utilities are billed back and they
 * don't exactly know what their bill is going to be."
 *
 * ONE SHEET PER HOUSEHOLD, each starting a new page, so the stack comes off the
 * printer already sorted into what goes under which door. The lines carry their
 * own words — "Water · meter 1204 → 1261" — which is the entire reason these
 * are worth carrying: the resident cannot know the utility part until they see
 * the read.
 *
 * Nothing here computes money. The sheet is the same bill the breakdown on the
 * Payments page shows (services/openBills), so paper and screen cannot drift.
 *
 * Printing is always light — dark mode printed a solid black sheet and wasted a
 * cartridge (installPrintLightTheme, 10/26).
 */

const money = (n: number) => Number(n).toLocaleString('en-US', { style: 'currency', currency: 'USD' })
/** "July 1, 2026" — a charge's own day, spelled out for somebody reading paper. */
const day = (iso: string) =>
  new Date(String(iso).slice(0, 10) + 'T00:00:00').toLocaleDateString('en-US',
    { month: 'long', day: 'numeric', year: 'numeric' })
const today = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })

/** Everything owed across a household's open bills, by column. */
const sum = (h: { bills: Bill[] }, key: 'totalAmount' | 'amountPaid' | 'creditApplied' | 'balance') =>
  Math.round(h.bills.reduce((t, b) => t + Number(b[key] ?? 0) * 100, 0)) / 100

/**
 * ── 10/27 (Nic): WHAT THE CHARGE IS, NOT WHICH BILL IT CAME ON ──────────────
 *
 *   "main charges should be at the top of the thing with late fees being
 *    underneath... It needs to be main charges first, chronological order, late
 *    fees, chronological order... Rent for July, August, September, and October
 *    should also be combined onto that one line item."
 *
 * The first two attempts grouped by INVOICE, which is how the ledger is built
 * and not how a bill is read. Six months of rent came out as six headings with
 * one rent line under each, and the late fees were scattered between them.
 *
 * So the sheet is grouped by WHAT THE CHARGE IS, across every open bill: rent
 * once, with the months it covers; each utility once; then late fees. The
 * resident sees what they owe for, not a tour of the ledger.
 *
 * THE MONTHS MUST BE ON THE LINE. Collapsing six charges to "$1,195.00 × 6"
 * and saying nothing else would hide which months are behind — and an earlier
 * version of this printed "May 1" over a line that was really May AND June,
 * which misrepresented correct data as a double charge. A group names every
 * month it covers.
 *
 * Only genuinely identical charges merge: same name, same detail, same amount.
 * A $5 late fee and a $5 key fee are not the same thing, and two water bills on
 * different meter reads are not either — the read is part of what the charge
 * IS, which is the whole reason these get hand-delivered.
 */
export interface SheetItem {
  key: string; label: string; detail: string | null
  /** How many of this charge. 1 for a one-off; 6 for six months of rent. */
  qty: number
  /** What one of them costs — the Rate column. */
  unit: number
  /** "May, Jun, Jul, Aug, Sep, Oct 2026", or one date for a one-off. */
  when: string
  amount: number
  /** Earliest day in the group — what it sorts on. */
  on: string
}

const monthOf = (iso: string) =>
  new Date(String(iso).slice(0, 10) + 'T00:00:00').toLocaleDateString('en-US', { month: 'short' })
const yearOf = (iso: string) => String(iso).slice(0, 4)

/** Every month a group covers, in order, with the year said once. */
function monthsText(dates: string[]): string {
  const sorted = [...new Set(dates)].sort()
  if (sorted.length === 1) return day(sorted[0])
  const years = [...new Set(sorted.map(yearOf))]
  if (years.length === 1) return `${sorted.map(monthOf).join(', ')} ${years[0]}`
  return sorted.map(d => `${monthOf(d)} ${yearOf(d)}`).join(', ')
}

export function itemizeSheet(bills: Bill[]): { charges: SheetItem[]; lateFees: SheetItem[] } {
  const groups = new Map<string, {
    label: string; detail: string | null; unit: number; dates: string[]; late: boolean
  }>()
  for (const b of bills) {
    for (const l of b.lines) {
      const unit = Math.round(Number(l.amount) * 100) / 100
      const key = `${l.label}\u0000${l.detail ?? ''}\u0000${unit}`
      const on = String(l.dueDate ?? b.dueDate).slice(0, 10)
      const g = groups.get(key)
      if (g) { g.dates.push(on); continue }
      groups.set(key, {
        label: l.label, detail: l.detail, unit, dates: [on],
        late: l.type === 'late_fee',
      })
    }
  }
  const items: Array<SheetItem & { late: boolean }> = [...groups.entries()].map(([key, g]) => {
    const n = g.dates.length
    return {
      key, label: g.label, detail: g.detail, late: g.late,
      qty: n,
      unit: g.unit,
      when: monthsText(g.dates),
      amount: Math.round(g.unit * n * 100) / 100,
      on: [...g.dates].sort()[0],
    }
  })
  // Oldest first inside each section; a tie keeps the name stable so two runs
  // of the same bill never come out in a different order.
  const chronological = (a: SheetItem, b: SheetItem) =>
    a.on === b.on ? a.label.localeCompare(b.label) : a.on.localeCompare(b.on)
  return {
    charges: items.filter(i => !i.late).sort(chronological),
    lateFees: items.filter(i => i.late).sort(chronological),
  }
}

export type Letterhead = {
  id: string; name: string; company: string | null
  address: string | null; cityLine: string | null
  phone: string | null; email: string | null
}
type Line = { id: string; type?: string; label: string; detail: string | null; amount: string | number; dueDate?: string; open: boolean }
type Bill = {
  id: string; invoiceNumber: string; dueDate: string; unitNumber: string | null
  propertyName: string | null; amountPaid: number; creditApplied: number
  balance: number; totalAmount: number; lines: Line[]
}
type Household = { tenantId: string; name: string; unitNumber: string | null; bills: Bill[] }

export function BillPrintPage() {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const propertyId = params.get('propertyId') ?? ''
  const tenantId = params.get('tenantId')
  const invoiceId = params.get('invoiceId')

  const { data, isLoading, error } = useQuery<{
    property: Letterhead; households: Household[]
  }>(
    ['bills-to-print', propertyId, tenantId, invoiceId],
    () => apiGet('/balances/bills-to-print?' + [
      propertyId ? `propertyId=${propertyId}` : '',
      tenantId ? `tenantId=${tenantId}` : '',
      invoiceId ? `invoiceId=${invoiceId}` : '',
    ].filter(Boolean).join('&')),
    // The button ON a bill knows the resident, not the park — the server
    // derives the property from them and re-checks the viewer may see it.
    { enabled: !!propertyId || !!tenantId, retry: false },
  )

  if (!propertyId && !tenantId) return <div className="card">Pick a property first.</div>
  if (isLoading) return <div className="card">Reading the bills…</div>
  if (error) return <div className="card">These bills could not be read.</div>

  const households = data?.households ?? []
  const p = data?.property

  return (
    <div>
      <div className="page-header rr-noprint">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button className="btn btn-ghost btn-sm" aria-label="Back" onClick={() => navigate(-1)}><ArrowLeft size={15} /></button>
          <div>
            <h1 className="page-title" style={{ marginBottom: 2 }}>
              {tenantId ? 'Statement' : 'Statements to deliver'} — {p?.name}
            </h1>
            <p className="page-subtitle">
              {households.length === 0
                ? 'Nothing is owed here right now.'
                : `${households.length} ${households.length === 1 ? 'household' : 'households'}, one page each`}
            </p>
          </div>
        </div>
        {households.length > 0 && (
          <button className="btn btn-primary btn-sm" onClick={() => window.print()}>
            <Printer size={13} /> Print
          </button>
        )}
      </div>

      {households.length === 0 && (
        <div className="card rr-noprint">Nothing is owed at this property, so there is nothing to deliver.</div>
      )}

      {households.map((h, i) => {
        const { charges, lateFees } = itemizeSheet(h.bills)
        const owed = sum(h, 'balance')
        return (
          <div key={h.tenantId} className="inv" style={i > 0 ? { pageBreakBefore: 'always' } : undefined}>

            {/* ── Letterhead: who this is from ─────────────────────────── */}
            <header className="inv-top">
              <div className="inv-from">
                <div className="inv-co">{p?.company || p?.name}</div>
                {p?.company && p?.name !== p?.company && <div className="inv-from-line">{p.name}</div>}
                {p?.address && <div className="inv-from-line">{p.address}</div>}
                {p?.cityLine && <div className="inv-from-line">{p.cityLine}</div>}
                {p?.phone && <div className="inv-from-line">{p.phone}</div>}
                {p?.email && <div className="inv-from-line">{p.email}</div>}
              </div>
              <div className="inv-mark">
                <div className="inv-title">STATEMENT</div>
                <table className="inv-meta">
                  <tbody>
                    <tr><td>Date</td><td>{today}</td></tr>
                    <tr><td>Account</td><td>{h.unitNumber || '—'}</td></tr>
                  </tbody>
                </table>
              </div>
            </header>

            {/* ── Bill to, and the one number that matters ──────────────── */}
            <section className="inv-parties">
              <div>
                <div className="inv-label">Bill to</div>
                <div className="inv-to-name">{h.name}</div>
                {h.unitNumber && <div className="inv-from-line">{h.unitNumber}</div>}
                {p?.name && <div className="inv-from-line">{p.name}</div>}
              </div>
              <div className="inv-due-box">
                <div className="inv-label">Amount due</div>
                <div className="inv-due">{money(owed)}</div>
              </div>
            </section>

            {/* ── The charges ──────────────────────────────────────────────
                10/27 (Nic): "main charges first, chronological order, late
                fees, chronological order", with like charges combined across
                the months they cover. */}
            <table className="inv-table">
              <thead>
                <tr>
                  <th className="inv-desc">Description</th>
                  <th className="inv-period">Period</th>
                  <th className="inv-num">Qty</th>
                  <th className="inv-num">Rate</th>
                  <th className="inv-num">Amount</th>
                </tr>
              </thead>
              <tbody>
                {charges.map(c => <ItemRow key={c.key} item={c} />)}
                {lateFees.length > 0 && (
                  <tr className="inv-section"><td colSpan={5}>Late fees</td></tr>
                )}
                {lateFees.map(c => <ItemRow key={c.key} item={c} />)}
              </tbody>
            </table>

            {/* ── Totals ───────────────────────────────────────────────── */}
            <section className="inv-sum">
              <table>
                <tbody>
                  <tr><td>Subtotal</td><td>{money(sum(h, 'totalAmount'))}</td></tr>
                  {sum(h, 'amountPaid') > 0 && (
                    <tr><td>Payments received</td><td>{money(-sum(h, 'amountPaid'))}</td></tr>
                  )}
                  {sum(h, 'creditApplied') > 0 && (
                    <tr><td>Credit applied</td><td>{money(-sum(h, 'creditApplied'))}</td></tr>
                  )}
                  <tr className="inv-balance"><td>Balance due</td><td>{money(owed)}</td></tr>
                </tbody>
              </table>
            </section>

            <footer className="inv-foot">
              Pay online from your GAM account, or at the office.
              {p?.email ? ` Questions: ${p.email}.` : ''}
            </footer>
          </div>
        )
      })}
    </div>
  )
}

/** One priced line: what it is, when it covers, and the arithmetic behind it. */
function ItemRow({ item }: { item: SheetItem }) {
  return (
    <tr>
      <td className="inv-desc">
        {item.label}
        {/* The meter read, the period — the detail that makes a hand-delivered
            bill worth delivering. */}
        {item.detail && <span className="inv-detail">{item.detail}</span>}
      </td>
      <td className="inv-period">{item.when}</td>
      <td className="inv-num">{item.qty}</td>
      <td className="inv-num">{item.qty > 1 ? money(item.unit) : ''}</td>
      <td className="inv-num inv-amount">{money(item.amount)}</td>
    </tr>
  )
}
