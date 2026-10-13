/**
 * 10/12 (Nic): Books Settings — the company's own choices for how its books
 * count money. "Landlord's choice", each one (Nic's 10/12 answers): where the
 * books start (since joining GAM, or a date the owner picks), who may close and
 * reopen a month, where a fix to an open month shows, home sales, work trade
 * that covers rent, register stock, costs that are no one property's, and who
 * may write off a balance.
 *
 * The owner changes them; a bookkeeper with the ledger box reads them (the
 * server decides — routes/booksSettings.ts). GAM Books' own page, shown in GAM
 * Books and inside the landlord portal's Bookkeeping menu — the same bytes in
 * apps/books and apps/landlord (bookkeeping-parity.test.ts). How it reaches the
 * API, shows a toast and links to another Books page is the app's own
 * (./adapter).
 */
import React, { useEffect, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useQuery, useQueryClient } from 'react-query'
import {
  longCalendarDate,
  BOOKS_HISTORY_STARTS, BOOKS_HISTORY_START_LABEL,
  BOOKS_HOME_SALE_METHODS, BOOKS_HOME_SALE_METHOD_LABEL,
  BOOKS_WORK_TRADE_METHODS, BOOKS_WORK_TRADE_METHOD_LABEL,
  LEDGER_REGISTER_STOCK_METHODS, LEDGER_REGISTER_STOCK_METHOD_LABEL,
  BOOKS_COMPANY_COST_METHODS, BOOKS_COMPANY_COST_METHOD_LABEL,
  LEDGER_WRITE_OFF_PERMISSIONS, LEDGER_WRITE_OFF_PERMISSION_LABEL,
  LEDGER_CLOSE_PERMISSIONS, LEDGER_CLOSE_PERMISSION_LABEL,
  LEDGER_OPEN_MONTH_FIX_MODES, LEDGER_OPEN_MONTH_FIX_MODE_LABEL,
  BOOKS_REPAIR_BILL_MODES, BOOKS_REPAIR_BILL_MODE_LABEL,
} from '@gam/shared'
import { booksGet as get, booksPatch as patch, booksPath, toast } from './adapter'
import { loadErrorText } from './booksMoney'

export interface BooksSettings {
  companyName: string | null
  canEdit: boolean
  booksStartDate: string | null
  historyStart: string | null
  joinedOn: string
  joinMonthStart: string
  closeBy: string
  reopenBy: string
  openMonthFixes: string
  homeSaleMethod: string | null
  workTradeMethod: string | null
  registerStockMethod: string
  registerStockFrom: string | null
  companyCostsMethod: string | null
  /** 10/13 (Nic): the day a company-costs choice made after the books posted applies from (null: every cost). */
  companyCostsFromDay: string | null
  writeOffBy: string
  /** 10/12 (Nic, L6): what a repair closed with a cost does (null: not chosen — the button). */
  repairBills: string | null
  closedThrough: string | null
  today: string
  hasPostings: boolean
  openingItems: number
}

type Form = {
  historyStart: string | null; startDate: string
  closeBy: string; reopenBy: string; openMonthFixes: string
  homeSaleMethod: string | null; workTradeMethod: string | null; registerStockMethod: string
  companyCostsMethod: string | null; writeOffBy: string; repairBills: string | null
}
const formOf = (s: BooksSettings): Form => ({
  historyStart: s.historyStart, startDate: s.historyStart === 'start_date' ? (s.booksStartDate ?? '') : '',
  closeBy: s.closeBy, reopenBy: s.reopenBy, openMonthFixes: s.openMonthFixes,
  homeSaleMethod: s.homeSaleMethod, workTradeMethod: s.workTradeMethod, registerStockMethod: s.registerStockMethod,
  companyCostsMethod: s.companyCostsMethod, writeOffBy: s.writeOffBy, repairBills: s.repairBills,
})

// What each choice means, in a sentence or two (the labels are the shared ones).
const HOME_SALE_HELP: Record<string, string> = {
  whole_sale_at_signing: 'The full sale counts when the contract is signed. What the buyer still owes is a note owed to you, and each payment is split into principal (paying down the note) and interest (income).',
  income_as_paid: 'Each payment counts as income when it comes in. What the buyer still owes is not on your balance sheet.',
}
const WORK_TRADE_HELP: Record<string, string> = {
  rent_and_labor: 'Rent counts in full as income, and the hours worked count as a labor cost.',
  rent_discount: 'Rent counts as income less what the hours covered.',
}
const STOCK_HELP: Record<string, string> = {
  expense_when_bought: 'Stock counts as an expense the day you buy it.',
  cost_per_item_sold: 'Stock you buy is inventory until it sells; each sale counts what its items cost.',
}
const COMPANY_COST_HELP: Record<string, string> = {
  company_bucket: 'Payroll and company-wide bills stay in a Company column of their own, apart from your properties.',
  split_by_units: 'Payroll and company-wide bills are split across your properties by how many units each has.',
}
// 10/12 (Nic, L6): "a repair closed with a cost → landlord's choice".
const REPAIR_BILL_HELP: Record<string, string> = {
  automatic: 'Completing a repair with a cost adds an unpaid bill for it to Expenses (under Repairs), kept in step while nothing is paid on it. Pay it there, or match it to the bank line that paid it.',
  button: 'Nothing is added by itself. On Maintenance costs, "Record as bill" adds the repair\'s cost to Expenses as an unpaid bill when you want it there.',
}
const FIX_HELP: Record<string, string> = {
  restate: 'The month the fix belongs to changes, the way QuickBooks does it.',
  day_made: 'The month stays as it was; the fix shows on the day it was made.',
}

function Section({ title, help, children }: { title: string; help?: ReactNode; children: ReactNode }) {
  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div className="ct" style={{ marginBottom: 6 }}>{title}</div>
      {help && <p style={{ fontSize: '.78rem', color: 'var(--t2)', lineHeight: 1.5, margin: '0 0 12px' }}>{help}</p>}
      {children}
    </div>
  )
}

/** One choice as a card the whole width of the section (a phone stacks them). */
function Choice({ name, value, checked, disabled, label, help, onPick, children }: {
  name: string; value: string; checked: boolean; disabled: boolean; label: string; help?: string
  onPick: (v: string) => void; children?: ReactNode
}) {
  return (
    <label style={{
      display: 'flex', gap: 10, alignItems: 'flex-start', padding: '10px 12px', marginBottom: 8, borderRadius: 8,
      border: `1px solid ${checked ? 'var(--gold)' : 'var(--b1)'}`, background: checked ? 'var(--bg3)' : 'transparent',
      cursor: disabled ? 'default' : 'pointer', textTransform: 'none', letterSpacing: 0, fontWeight: 400,
      fontSize: '.82rem', color: 'var(--t1)', opacity: disabled && !checked ? 0.6 : 1,
    }}>
      <input type="radio" name={name} value={value} checked={checked} disabled={disabled}
        onChange={() => onPick(value)} style={{ width: 'auto', marginTop: 3, accentColor: 'var(--gold)' }} />
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'block', fontWeight: 600, color: 'var(--t0)' }}>{label}</span>
        {help && <span style={{ display: 'block', fontSize: '.75rem', color: 'var(--t3)', lineHeight: 1.5, marginTop: 2 }}>{help}</span>}
        {children}
      </span>
    </label>
  )
}

function NotChosen() {
  return <div className="alert aw" style={{ marginBottom: 10 }}>Not chosen yet. Records that depend on it wait until you choose.</div>
}
function Locked() {
  return <p className="bnote" style={{ marginTop: 2 }}>Your books have posted under this choice, so it stays as chosen.</p>
}

export function BooksSettingsPage() {
  const qc = useQueryClient()
  const { data, isLoading, error, refetch, isFetching } = useQuery<BooksSettings>('books-settings', () => get<BooksSettings>('/books/setup/settings'))
  const [form, setForm] = useState<Form | null>(null)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')
  useEffect(() => { if (data) setForm(formOf(data)) }, [data])

  if (isLoading || (!form && !error)) return <div className="bk-loading" style={{ padding: 32, textAlign: 'center' }}><span className="spinner" style={{ display: 'inline-block' }} /></div>
  if (error || !data || !form) {
    return (
      <div className="alert ae" style={{ alignItems: 'center' }}>
        <span style={{ flex: 1 }}>{loadErrorText(error, 'Could not load the books settings.')}</span>
        <button className="btn bp bsm" disabled={isFetching} onClick={() => refetch()}>{isFetching ? 'Loading…' : 'Load again'}</button>
      </div>
    )
  }

  const ro = !data.canEdit
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm(f => (f ? { ...f, [k]: v } : f))
  const lockedMethod = (was: string | null) => data.hasPostings && was !== null

  // Only what changed is sent.
  const startChanged = form.historyStart !== data.historyStart
    || (form.historyStart === 'start_date' && form.startDate !== (data.booksStartDate ?? ''))
  const changes: Record<string, string> = {}
  if (startChanged && form.historyStart) {
    changes.historyStart = form.historyStart
    if (form.historyStart === 'start_date') changes.startDate = form.startDate
  }
  for (const k of ['closeBy', 'reopenBy', 'openMonthFixes', 'homeSaleMethod', 'workTradeMethod', 'registerStockMethod', 'companyCostsMethod', 'writeOffBy', 'repairBills'] as const) {
    const v = form[k]
    if (v !== null && v !== (data as any)[k]) changes[k] = v
  }
  const dirty = Object.keys(changes).length > 0

  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    setErr('')
    if (form.historyStart === 'start_date' && !form.startDate) { setErr('Enter the date your books start.'); return }
    setSaving(true)
    try {
      const r = await patch<BooksSettings>('/books/setup/settings', changes)
      qc.setQueryData('books-settings', r.data)
      qc.invalidateQueries('books-opening')
      toast('Books settings saved.')
    } catch (ex: any) {
      setErr(ex.response?.data?.error || 'Could not save the settings.')
    } finally {
      setSaving(false)
    }
  }

  const sinceJoiningText = `Your books start ${longCalendarDate(data.joinMonthStart)}, the first day of the month this company joined GAM. Everything GAM has a record of from then on is in your books.`

  return (
    <form onSubmit={save}>
      <div className="ph">
        <div>
          <h1 className="pt">⚙ Books Settings</h1>
          <p className="ps">{data.companyName ? `${data.companyName} · ` : ''}How this company&apos;s books count money. Your choices — ask your accountant which fit your business.</p>
        </div>
      </div>

      {ro && <div className="alert agold">Only the owner changes these settings.</div>}

      <Section title="When your books start" help={<>The bank feed uses the same date: bank lines before it are set aside, not filed. {data.booksStartDate
        ? <>Your books start <strong>{longCalendarDate(data.booksStartDate)}</strong>.</>
        : <strong>Not chosen yet — nothing posts to your books until you choose.</strong>}</>}>
        {BOOKS_HISTORY_STARTS.map(v => (
          <Choice key={v} name="historyStart" value={v} checked={form.historyStart === v} disabled={ro}
            label={BOOKS_HISTORY_START_LABEL[v]}
            help={v === 'since_joining' ? sinceJoiningText : 'Pick the first day your books cover. What came before it starts as one set of opening balances — enter what GAM cannot know on Opening Balances.'}
            onPick={x => set('historyStart', x)}>
            {v === 'start_date' && form.historyStart === 'start_date' && (
              <span style={{ display: 'block', marginTop: 8, maxWidth: 220 }}>
                <input type="date" aria-label="First day your books cover" value={form.startDate} disabled={ro}
                  onChange={e => set('startDate', e.target.value)} />
              </span>
            )}
          </Choice>
        ))}
        {data.closedThrough && (
          <p className="bnote">Your books are closed through {longCalendarDate(data.closedThrough)}. Moving the start shows its effect as corrections in the first open month.</p>
        )}
        {data.booksStartDate && (
          <p className="bnote">
            <Link to={booksPath('openingBalances')} style={{ color: 'var(--gold)' }}>Opening Balances</Link>
            {data.openingItems ? ` — ${data.openingItems} entered.` : ' — bank balances, deposits you hold from before GAM, and anything else your books start with.'}
          </p>
        )}
      </Section>

      <Section title="Closing a month" help="Closing a month stops its numbers from changing. Payments and fixes dated in a closed month still go through — they show in the first open month, labeled as corrections. Closing is optional.">
        <div className="frow2">
          <div>
            <label htmlFor="bks-close">Who may close a month</label>
            <select id="bks-close" value={form.closeBy} disabled={ro} onChange={e => set('closeBy', e.target.value)}>
              {LEDGER_CLOSE_PERMISSIONS.map(v => <option key={v} value={v}>{LEDGER_CLOSE_PERMISSION_LABEL[v]}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="bks-reopen">Who may reopen a month</label>
            <select id="bks-reopen" value={form.reopenBy} disabled={ro} onChange={e => set('reopenBy', e.target.value)}>
              {LEDGER_CLOSE_PERMISSIONS.map(v => <option key={v} value={v}>{LEDGER_CLOSE_PERMISSION_LABEL[v]}</option>)}
            </select>
          </div>
        </div>
        <p className="bnote" style={{ marginTop: 0 }}>A reopen always says why, and the owner hears about it.</p>
      </Section>

      <Section title="Fixes to a month that is still open" help="A month that is closed never changes either way: its fixes show in the first open month.">
        {LEDGER_OPEN_MONTH_FIX_MODES.map(v => (
          <Choice key={v} name="openMonthFixes" value={v} checked={form.openMonthFixes === v} disabled={ro}
            label={LEDGER_OPEN_MONTH_FIX_MODE_LABEL[v]} help={FIX_HELP[v]} onPick={x => set('openMonthFixes', x)} />
        ))}
      </Section>

      <Section title="Home sales" help="A home you sell on payments.">
        {data.homeSaleMethod === null && <NotChosen />}
        {BOOKS_HOME_SALE_METHODS.map(v => (
          <Choice key={v} name="homeSaleMethod" value={v} checked={form.homeSaleMethod === v}
            disabled={ro || lockedMethod(data.homeSaleMethod)}
            label={BOOKS_HOME_SALE_METHOD_LABEL[v]} help={HOME_SALE_HELP[v]} onPick={x => set('homeSaleMethod', x)} />
        ))}
        {lockedMethod(data.homeSaleMethod) && <Locked />}
      </Section>

      <Section title="Work trade that covers rent" help="Either way, hours not worked that get billed count as rent.">
        {data.workTradeMethod === null && <NotChosen />}
        {BOOKS_WORK_TRADE_METHODS.map(v => (
          <Choice key={v} name="workTradeMethod" value={v} checked={form.workTradeMethod === v}
            disabled={ro || lockedMethod(data.workTradeMethod)}
            label={BOOKS_WORK_TRADE_METHOD_LABEL[v]} help={WORK_TRADE_HELP[v]} onPick={x => set('workTradeMethod', x)} />
        ))}
        {lockedMethod(data.workTradeMethod) && <Locked />}
      </Section>

      <Section title="Register stock" help={<>What you stock to sell at the register. A change applies from the day you make it; sales already in your books keep the way they were counted.{data.registerStockFrom ? ` The current choice applies from ${longCalendarDate(data.registerStockFrom)}.` : ''}</>}>
        {LEDGER_REGISTER_STOCK_METHODS.map(v => (
          <Choice key={v} name="registerStockMethod" value={v} checked={form.registerStockMethod === v} disabled={ro}
            label={LEDGER_REGISTER_STOCK_METHOD_LABEL[v]} help={STOCK_HELP[v]} onPick={x => set('registerStockMethod', x)} />
        ))}
      </Section>

      {/* 10/13 (Nic): "Company-level costs before the owner picks: post to the
          COMPANY column by default"; "a later 'split by units' splits only NEW costs". */}
      <Section title="Costs that are no one property's" help={data.companyCostsMethod !== null && data.companyCostsFromDay
        ? `Your choice applies to costs recorded from ${longCalendarDate(data.companyCostsFromDay)} on. Costs recorded before then stay in the Company column.`
        : undefined}>
        {data.companyCostsMethod === null && <div className="alert aw" style={{ marginBottom: 10 }}>Not chosen yet. Until you choose, these costs go to the Company column. Choosing to split them by units splits only costs recorded from then on; what is already in the Company column stays there.</div>}
        {BOOKS_COMPANY_COST_METHODS.map(v => (
          <Choice key={v} name="companyCostsMethod" value={v} checked={form.companyCostsMethod === v}
            disabled={ro || lockedMethod(data.companyCostsMethod)}
            label={BOOKS_COMPANY_COST_METHOD_LABEL[v]} help={COMPANY_COST_HELP[v]} onPick={x => set('companyCostsMethod', x)} />
        ))}
        {lockedMethod(data.companyCostsMethod) && <Locked />}
      </Section>

      <Section title="Repairs closed with a cost" help={<>Either way the repair's cost counts once — on its bill once it has one. Your expense and income categories (and the accounts they charge to) are on <Link to={booksPath('categories')} style={{ color: 'var(--gold)' }}>Categories</Link>.</>}>
        {data.repairBills === null && <p className="bnote" style={{ marginTop: 0 }}>Not chosen yet: the "Record as bill" button is offered.</p>}
        {BOOKS_REPAIR_BILL_MODES.map(v => (
          <Choice key={v} name="repairBills" value={v} checked={form.repairBills === v} disabled={ro}
            label={BOOKS_REPAIR_BILL_MODE_LABEL[v]} help={REPAIR_BILL_HELP[v]} onPick={x => set('repairBills', x)} />
        ))}
      </Section>

      <Section title="Writing off a balance" help="A balance a tenant will never pay can be written off as bad debt. It stays on record as written off, never erased. Bookkeepers never write off a tenant's balance.">
        <div style={{ maxWidth: 420 }}>
          <label htmlFor="bks-writeoff">Who may write off a balance</label>
          <select id="bks-writeoff" value={form.writeOffBy} disabled={ro} onChange={e => set('writeOffBy', e.target.value)}>
            {LEDGER_WRITE_OFF_PERMISSIONS.map(v => <option key={v} value={v}>{LEDGER_WRITE_OFF_PERMISSION_LABEL[v]}</option>)}
          </select>
        </div>
      </Section>

      <p className="bnote">Home sales, work trade and company costs are chosen once: after your books start posting, they stay as chosen.</p>

      {!ro && (
        <>
          {err && <div className="alert ae" style={{ marginTop: 10 }}>{err}</div>}
          <div className="factions">
            <button type="button" className="btn bg-btn" disabled={!dirty || saving} onClick={() => { setErr(''); setForm(formOf(data)) }}>Undo changes</button>
            <button type="submit" className="btn bp" disabled={!dirty || saving}>{saving ? <><span className="spinner" />Saving…</> : 'Save settings'}</button>
          </div>
        </>
      )}
    </form>
  )
}
