/**
 * 10/11 (Nic): the pieces every shared financial page uses — who is looking
 * and which properties they keep, the property and period pickers, and the
 * money and day formats. Same bytes in the landlord portal and GAM Books
 * (financials-parity.test.ts).
 */
import { useState, type ReactNode } from 'react'
import { useQuery } from 'react-query'
import { RENT_ROLL_STAY_UNITS, stayQuantityText, type RentRollStayUnit } from '@gam/shared'
import { finGet } from './adapter'
import './financials.css'

export interface FinProperty {
  id: string; name: string; landlordId: string
  /** 10/12 (Nic): a property sold or moved out while a bookkeeper kept it — the
   *  last day its history is theirs (read only). null on a current property. */
  leftOn?: string | null
}
export interface FinScope {
  viewer: 'owner' | 'bookkeeper'
  canRemoveExpenses: boolean
  /** 10/12 (Nic): the company-wide box — the bank account, payouts and payroll. */
  companyWide: boolean
  companies: Array<{ id: string; name: string }>
  properties: FinProperty[]
}

/** 10/12: a property's name, and for a former one the last day its history is shown. */
export function propertyLabel(p: FinProperty): string {
  return p.leftOn ? `${p.name} (left ${dayName(p.leftOn)}, history only)` : p.name
}

/** Who is looking and which properties they keep (GET /financials/scope). */
export function useFinancialsScope() {
  return useQuery<FinScope>('financials-scope', () => finGet<FinScope>('/financials/scope'), { staleTime: 60_000 })
}

// ── Formats ─────────────────────────────────────────────────────────────
export function money(n: unknown): string {
  const v = Number(n)
  if (n == null || !isFinite(v)) return '—'
  return `${v < 0 ? '−' : ''}$${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
/** '2026-09' → 'September 2026' */
export function monthName(ym: string): string {
  const [y, m] = ym.split('-').map(Number)
  return MONTHS[(m || 1) - 1] ? `${MONTHS[m - 1]} ${y}` : ym
}
/** '2026-09-04' → 'Sep 4, 2026' (a calendar day, no time-zone shift). */
export function dayName(ymd: string | null | undefined): string {
  if (!ymd) return '—'
  const d = new Date(String(ymd).slice(0, 10) + 'T12:00:00')
  return isNaN(d.getTime()) ? String(ymd) : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}
/** An instant → its day on this device, 'Sep 4, 2026'. */
export function instantDay(ts: string | null | undefined): string {
  if (!ts) return '—'
  const d = new Date(ts)
  return isNaN(d.getTime()) ? '—' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}
/**
 * 10.6 → "10.6", 4 → "4". How many went out: gallons and kilowatt-hours come
 * with decimals, so three of them are kept and trailing zeros are not printed.
 */
export function count(n: unknown): string {
  const v = Number(n)
  if (n == null || !isFinite(v)) return '—'
  return v.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 3 })
}

/**
 * How many of a sold item went out: "3 months" for something sold by the night,
 * week or month, "10.6" for anything sold by a quantity of its own. 10/19: on
 * both pages that print what was sold (Sales & tax, and Money in), so an item
 * reads the same way on each.
 */
export function soldQuantity(qty: number, unit: string | null): string {
  return unit && (RENT_ROLL_STAY_UNITS as readonly string[]).includes(unit)
    ? stayQuantityText(qty, unit as RentRollStayUnit)
    : count(qty)
}

const pad = (n: number) => String(n).padStart(2, '0')
const ymdOf = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

export interface Period { from: string; to: string }
type PresetKey = 'this_month' | 'last_month' | 'this_year' | 'last_year'
const PRESETS: Array<{ key: PresetKey; label: string }> = [
  { key: 'this_month', label: 'This month' },
  { key: 'last_month', label: 'Last month' },
  { key: 'this_year',  label: 'This year' },
  { key: 'last_year',  label: 'Last year' },
]
export function presetPeriod(key: PresetKey, today = new Date()): Period {
  const y = today.getFullYear(), m = today.getMonth()
  if (key === 'last_month') return { from: ymdOf(new Date(y, m - 1, 1)), to: ymdOf(new Date(y, m, 0)) }
  if (key === 'this_year') return { from: `${y}-01-01`, to: ymdOf(today) }
  if (key === 'last_year') return { from: `${y - 1}-01-01`, to: `${y - 1}-12-31` }
  return { from: ymdOf(new Date(y, m, 1)), to: ymdOf(today) }
}
export function usePeriod(initial: PresetKey = 'this_month'): [Period, (p: Period) => void] {
  const [p, setP] = useState<Period>(() => presetPeriod(initial))
  return [p, setP]
}
export function periodQuery(p: Period, propertyId?: string): string {
  const q = new URLSearchParams({ from: p.from, to: p.to })
  if (propertyId) q.set('propertyId', propertyId)
  return q.toString()
}

/** The words the API sent back, else a plain sentence. */
export function errorWords(e: any, fallback: string): string {
  return e?.response?.data?.error || e?.response?.data?.message || fallback
}

// ── Pickers ─────────────────────────────────────────────────────────────

/** One property, or all of them. Renders nothing when there is only one. */
export function PropertyPicker({ value, onChange, properties }: {
  value: string; onChange: (id: string) => void; properties: FinProperty[]
}) {
  if (properties.length < 2) return null
  return (
    <label className="fin-field">
      <span className="fin-field-label">Property</span>
      <select className="form-input fin-select" value={value} onChange={e => onChange(e.target.value)}>
        <option value="">All properties</option>
        {properties.map(p => <option key={p.id} value={p.id}>{propertyLabel(p)}</option>)}
      </select>
    </label>
  )
}

export function PeriodPicker({ value, onChange }: { value: Period; onChange: (p: Period) => void }) {
  return (
    <div className="fin-period">
      {PRESETS.map(pr => {
        const p = presetPeriod(pr.key)
        const on = p.from === value.from && p.to === value.to
        return (
          <button key={pr.key} type="button" className={`btn btn-sm ${on ? 'btn-primary' : 'btn-ghost'}`}
            onClick={() => onChange(p)}>{pr.label}</button>
        )
      })}
      <label className="fin-field">
        <span className="fin-field-label">From</span>
        <input className="form-input fin-date" type="date" value={value.from}
          onChange={e => e.target.value && onChange({ ...value, from: e.target.value })} />
      </label>
      <label className="fin-field">
        <span className="fin-field-label">To</span>
        <input className="form-input fin-date" type="date" value={value.to}
          onChange={e => e.target.value && onChange({ ...value, to: e.target.value })} />
      </label>
    </div>
  )
}

export function PageHead({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="page-header">
      <div>
        <h1 className="page-title">{title}</h1>
        <p className="page-subtitle">{subtitle}</p>
      </div>
    </div>
  )
}

export function Notice({ children }: { children: ReactNode }) {
  return <div className="card fin-notice">{children}</div>
}

// ── Export ──────────────────────────────────────────────────────────────
/**
 * A spreadsheet of `rows` under `header`, saved to the viewer's device. 10/17:
 * moved here from the Reports page — a Sales & tax breakdown is attached to a
 * tax filing, so both pages save a spreadsheet the one same way.
 */
export function downloadCsv(filename: string, header: string[], rows: (string | number | null | undefined)[][]) {
  // 10/12: a field that starts like a formula is opened as one by a
  // spreadsheet (a resident named "=HYPERLINK(…)"), so it reads as text.
  const esc = (v: any) => {
    const raw = v == null ? '' : String(v)
    const s = typeof v === 'string' && /^[=+\-@\t\r]/.test(v) ? `'${raw}` : raw
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const csv = [header, ...rows].map(r => r.map(esc).join(',')).join('\r\n')
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
