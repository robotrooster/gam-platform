// S568 (Nic): landlord expense entry. Log an expense against a specific unit, or
// as a common (property-level) expense. Feeds the P&L / reports.
//
// 10/11 (Nic): "any receipts that I upload as expenses whether they're tacked
// on to a unit or to a whole property... miscellaneous purchases like fuel for
// equipment... They need to see all of that stuff." One of the shared financial
// pages — the same bytes in the landlord portal and GAM Books
// (financials-parity.test.ts). The owner adds, edits and removes; a bookkeeper
// sees the expenses of the properties they keep. 10/12 (Nic, ledger decision
// 2): "Full bookkeeping … One level, no per-bookkeeper switch" — a bookkeeper
// adds, corrects, removes and pays them like the owner, never a tenant's
// account. The API decides what each row allows (canEdit / canRemove /
// canPay) and checks every id it is sent.
//
// 10/12 (Nic): an expense the bank feed filed is never removed here — the
// server refuses it, and the row offers the Bank page instead, opened on the
// bank line it came from, where it is split, changed or undone. An expense
// logged by hand (cash that never went through the bank) is removed here.
//
// 10/12 (Nic, GAM Books P6, L5): MONEY OUT IS ONE RECORD. "just let
// bookkeeper/landlord create custom labels or categories to charge things off
// to." Every expense is filed under one of the company's own categories (the
// Categories page makes and points them); it says who was paid (the company's
// vendor list, or a name typed in); and it is paid now — how: cash from the
// office, a check, a card, the owner personally, the bank — or it is a bill to
// pay, with a due date. "Bills to pay" lists what is still owed, and a payment
// (or part of one) is recorded on the row. Cash that never touched the bank is
// logged here and never has to match a bank line; a bill the bank paid is
// matched on the Bank page.
import { useMemo, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import {
  EXPENSE_PAY_STATE_LABEL, LANDLORD_EXPENSE_PAYMENT_METHODS_ENTERED, LANDLORD_EXPENSE_PAYMENT_METHOD_LABEL, humanize,
  type ExpensePayState, type LandlordExpensePaymentMethod,
} from '@gam/shared'
import { finGet, finPost, finPatch, finUpload, openProtectedFile, toast, appConfirm, useViewer } from './adapter'
import { useFinancialsScope, money, dayName, errorWords, PropertyPicker, PageHead, Notice } from './common'

const today = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const UTILITIES = ['electric', 'water', 'sewer', 'gas', 'trash', 'propane'] as const

interface Payment {
  id: string; paidOn: string; amount: number; method: LandlordExpensePaymentMethod; source: string
  bankTransactionId: string | null; memo: string | null; voided: boolean
}
interface Expense {
  id: string; category: string; amount: number; description: string | null; vendor: string | null
  expenseDay: string; isCommon: boolean; unitId: string | null; propertyId: string | null
  unitNumber: string | null; propertyName: string | null; utilityType: string | null
  receiptUrl: string | null; receiptName: string | null; fromBank: boolean
  canEdit: boolean; canRemove: boolean
  /** 10/12: the bank line a bank-filed expense came from, and its company. */
  bankLineId: string | null; landlordId: string
  /** 10/12 (Nic, L5): its category, vendor and bill, and what is paid. */
  categoryId: string | null; categoryName: string | null; onProfitAndLoss: boolean
  vendorId: string | null; vendorName: string | null; billNumber: string | null; dueDate: string | null
  paid: number; unpaid: number; payState: ExpensePayState; payments: Payment[] | null
  bankPaid: boolean; canPay: boolean; maintenanceRequestId: string | null; migratedFromTable: string | null
  /** 10/12 (Nic): records work-trade hours marked paid on the Work Trade page —
   *  its payment is never taken back alone (Remove puts the hours back to owed). */
  workTradePaidByHand?: boolean
}
interface Category {
  id: string; landlordId: string; direction: 'expense' | 'income'; name: string; systemKey: string | null
  inPicker: boolean; archived: boolean; onProfitAndLoss: boolean
}
interface Options {
  categories: Category[]
  vendors: Array<{ id: string; name: string; landlordId: string }>
  banks: Array<{ id: string; name: string; landlordId: string }>
}
interface Unit { id: string; unitNumber: string; propertyId: string }

type View = 'all' | 'open' | 'paid'
const VIEW_LABEL: Record<View, string> = { all: 'All expenses', open: 'Bills to pay', paid: 'Paid' }

const blankForm = () => ({
  propertyId: '', unitId: '', scope: 'unit' as 'unit' | 'common',
  categoryId: '', amount: '', description: '', vendorId: '', vendor: '', expenseDate: today(),
  // S613: which utility, when the category is utilities. Feeds the recovery report.
  utilityType: null as string | null,
  // 10/12 (Nic, L5): paid now (and how), or a bill to pay.
  paidNow: true, method: 'cash' as LandlordExpensePaymentMethod, paidOn: '', bankConnectionId: '',
  dueDate: '', billNumber: '',
})
const blankPay = () => ({ method: 'cash' as LandlordExpensePaymentMethod, amount: '', paidOn: today(), bankConnectionId: '' })

export function ExpensesPage() {
  const qc = useQueryClient()
  const { data: scope, error: scopeError } = useFinancialsScope()
  const properties = scope?.properties ?? []
  const { data: units = [] } = useQuery<Unit[]>('financials-units', () => finGet<Unit[]>('/financials/units'))
  const [view, setView] = useState<View>('all')
  const { data: expenses = [], isLoading, error: listError } = useQuery<Expense[]>(['landlord-expenses', view],
    () => finGet<Expense[]>(view === 'all' ? '/expenses' : `/expenses?state=${view}`))
  const { data: options } = useQuery<Options>('expense-options', () => finGet<Options>('/expenses/options'), { staleTime: 30_000 })
  const bookkeeper = scope?.viewer === 'bookkeeper'
  // The owner's Bank page, where a bank-filed expense is changed (none in GAM Books, none for a bookkeeper).
  const { openOwnerPage } = useViewer()

  const [form, setForm] = useState(blankForm)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [receipt, setReceipt] = useState<File | null>(null)
  const [fileKey, setFileKey] = useState(0)
  const [payingId, setPayingId] = useState<string | null>(null)
  const [pay, setPay] = useState(blankPay)
  const [payErr, setPayErr] = useState<string | null>(null)
  const set = (patch: Partial<ReturnType<typeof blankForm>>) => setForm(f => ({ ...f, ...patch }))
  const propUnits = units.filter(u => u.propertyId === form.propertyId)

  // The company the form files under: the chosen property's, else the only one.
  const companyId = properties.find(p => p.id === form.propertyId)?.landlordId
    ?? (scope?.companies?.length === 1 ? scope.companies[0].id : null)
  const editingRow = editingId ? expenses.find(e => e.id === editingId) : null
  const formCompany = editingRow?.landlordId ?? companyId
  const categories = useMemo(() => (options?.categories ?? [])
    .filter(c => c.direction === 'expense' && (c.inPicker || c.id === form.categoryId) && (!formCompany || c.landlordId === formCompany)),
  [options, formCompany, form.categoryId])
  const vendors = (options?.vendors ?? []).filter(v => !formCompany || v.landlordId === formCompany)
  const banks = (options?.banks ?? []).filter(b => !formCompany || b.landlordId === formCompany)
  const chosenCategory = categories.find(c => c.id === form.categoryId) ?? null
  const isUtilities = chosenCategory?.systemKey === 'utilities'

  // S637 (Nic, DIRECTIVE): "expenses, selected property." Options come from the
  // PROPERTIES the viewer keeps, not from the expense rows, so a park with
  // nothing logged yet is still selectable.
  const [filterPropertyId, setFilterPropertyId] = useState('')
  const shownExpenses = expenses.filter(e => filterPropertyId === '' || e.propertyId === filterPropertyId)
  const shownTotal = shownExpenses.reduce((sum, e) => sum + Number((view === 'open' ? e.unpaid : e.amount) || 0), 0)

  const resetForm = () => {
    setEditingId(null); setReceipt(null); setFileKey(k => k + 1)
    setForm(f => ({ ...blankForm(), propertyId: f.propertyId, scope: f.scope }))
  }
  const refresh = () => {
    qc.invalidateQueries('landlord-expenses')
    qc.invalidateQueries('expense-options')
  }

  const save = useMutation(
    async () => {
      const body: Record<string, unknown> = {
        categoryId: form.categoryId || undefined,
        amount: Number(form.amount), expenseDate: form.expenseDate,
        utilityType: isUtilities ? form.utilityType : null,
        description: form.description.trim() || null,
        vendorId: form.vendorId || null, vendor: form.vendorId ? null : (form.vendor.trim() || null),
        // A company-wide expense (no property, e.g. filed from the bank feed)
        // keeps its place unless a property is chosen for it.
        ...(form.scope === 'unit'
          ? { unitId: form.unitId, propertyId: null }
          : form.propertyId ? { propertyId: form.propertyId, unitId: null } : {}),
        billNumber: form.billNumber.trim() || null,
        dueDate: form.dueDate || null,
      }
      let id = editingId
      if (id) {
        await finPatch(`/expenses/${id}`, body)
      } else {
        const res = await finPost<Expense>('/expenses', {
          ...body, isCommon: form.scope === 'common',
          ...(form.paidNow
            ? { paid: { method: form.method, paidOn: form.paidOn || form.expenseDate,
                        bankConnectionId: (form.method === 'bank' || form.method === 'check') && form.bankConnectionId ? form.bankConnectionId : null } }
            : { unpaid: true }),
        })
        id = res?.data?.id ?? null
      }
      // Chain the receipt upload onto the saved expense (S575). One click; the
      // file is optional.
      if (receipt && id) {
        const fd = new FormData()
        fd.append('receipt', receipt)
        try {
          await finUpload(`/expenses/${id}/receipt`, fd)
        } catch (e: any) {
          // 10/11: the expense IS saved. Keep the form on it, so saving again
          // retries the receipt on this expense instead of logging a second one
          // (a duplicate would have to be found and removed by hand).
          if (!editingId) {
            setEditingId(id)
            refresh()
          }
          throw Object.assign(new Error(errorWords(e, 'The file could not be uploaded.')), { receiptOnly: true })
        }
      }
      return id
    },
    { onSuccess: () => {
        refresh()
        toast(editingId ? 'Expense updated.' : form.paidNow ? 'Expense logged.' : 'Bill added to Bills to pay.')
        setErr(null)
        resetForm()
      },
      onError: (e: any) => setErr(e?.receiptOnly
        ? `Expense saved, but the receipt did not upload (${String(e.message).replace(/\.+$/, '')}). Choose the file again if needed and save to retry the receipt.`
        : errorWords(e, e?.message || 'Could not save the expense.')) })

  const voidMut = useMutation(
    (id: string) => finPost(`/expenses/${id}/void`, {}),
    { onSuccess: () => { refresh(); toast('Expense removed.') },
      onError: (e: any) => toast(errorWords(e, 'Could not remove the expense.')) })

  const payMut = useMutation(
    (id: string) => finPost(`/expenses/${id}/payments`, {
      method: pay.method, amount: pay.amount ? Number(pay.amount) : null, paidOn: pay.paidOn || null,
      bankConnectionId: (pay.method === 'bank' || pay.method === 'check') && pay.bankConnectionId ? pay.bankConnectionId : null,
    }),
    { onSuccess: () => { refresh(); toast('Payment recorded.'); setPayingId(null); setPayErr(null) },
      onError: (e: any) => setPayErr(errorWords(e, 'Could not record the payment.')) })

  const takeBack = useMutation(
    ({ expenseId, paymentId }: { expenseId: string; paymentId: string }) =>
      finPost(`/expenses/${expenseId}/payments/${paymentId}/void`, {}),
    { onSuccess: () => { refresh(); toast('Payment taken back. The bill is owed again.') },
      onError: (e: any) => toast(errorWords(e, 'Could not take the payment back.')) })

  const startEdit = (e: Expense) => {
    setEditingId(e.id); setErr(null); setReceipt(null); setFileKey(k => k + 1)
    setForm({
      ...blankForm(),
      propertyId: e.propertyId || '', unitId: e.unitId || '', scope: e.unitId ? 'unit' : 'common',
      categoryId: e.categoryId || '', amount: String(e.amount), description: e.description || '',
      vendorId: e.vendorId || '', vendor: e.vendorId ? '' : (e.vendor || ''),
      expenseDate: e.expenseDay, utilityType: e.utilityType,
      dueDate: e.dueDate || '', billNumber: e.billNumber || '',
    })
  }
  const startPay = (e: Expense) => {
    setPayingId(e.id); setPayErr(null)
    setPay({ ...blankPay(), amount: String(e.unpaid) })
  }

  const canSubmit = form.amount && Number(form.amount) > 0 && form.expenseDate && form.categoryId &&
    (form.scope === 'unit' ? form.unitId : (form.propertyId || (editingRow && !editingRow.propertyId)))

  const statusOf = (e: Expense) => e.payState === 'paid'
    ? EXPENSE_PAY_STATE_LABEL.paid
    : `${EXPENSE_PAY_STATE_LABEL[e.payState]}${e.dueDate ? ` · due ${dayName(e.dueDate)}` : ''}`

  return (
    <div className="fin">
      <PageHead title="Expenses"
        subtitle={bookkeeper
          ? 'Expenses and bills for the properties you keep, with their receipts. Log what was paid, add bills to pay, and record their payments.'
          : 'Everything that goes out: log what you paid (cash, check, card, the bank) or add a bill to pay, against a unit or the whole property.'} />
      {scopeError ? <Notice>{errorWords(scopeError, 'Could not load your books.')}</Notice> : null}

      <div className="card" style={{ marginBottom: 20, maxWidth: 720 }}>
        <div className="card-title" style={{ marginBottom: 14 }}>{editingId ? 'Edit this expense' : 'Log an expense or a bill'}</div>
        <div className="fin-form">
          <label>Property
            <select className="form-input" value={form.propertyId}
              onChange={e => set({ propertyId: e.target.value, unitId: '' })}>
              <option value="">Select a property…</option>
              {/* 10/12: a property that left the company is read only — nothing is filed on it. */}
              {properties.filter(p => !p.leftOn).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {(['unit', 'common'] as const).map(s => (
              <button key={s} type="button" className={`btn btn-sm ${form.scope === s ? 'btn-primary' : 'btn-ghost'}`}
                onClick={() => set({ scope: s })} disabled={!form.propertyId}>
                {s === 'unit' ? 'For a specific unit' : 'Common (whole property)'}
              </button>
            ))}
          </div>

          {form.scope === 'unit' ? (
            <label>Unit
              <select className="form-input" value={form.unitId} onChange={e => set({ unitId: e.target.value })} disabled={!form.propertyId}>
                <option value="">Select a unit…</option>
                {propUnits.map(u => <option key={u.id} value={u.id}>Unit {u.unitNumber}</option>)}
              </select>
            </label>
          ) : (
            // S603 (Nic): any expense not tied to a specific unit is divided
            // evenly across that property's units, so per-unit cost reflects reality.
            <div className="fin-muted" style={{ padding: '4px 0' }}>
              This cost will be divided evenly across every unit at the property,
              including vacant ones, so per-unit numbers stay accurate.
            </div>
          )}

          <div className="fin-form-row">
            <label>Category
              <select className="form-input" value={form.categoryId} onChange={e => set({ categoryId: e.target.value })}>
                <option value="">Choose a category…</option>
                {categories.map(c => <option key={c.id} value={c.id}>{c.name}{c.onProfitAndLoss ? '' : ' (not a business cost)'}</option>)}
              </select>
              {/* S613 (Nic): tagging which utility lets the Utilities page compare
                  what was spent against what was billed back, per utility. */}
              {isUtilities && (
                <select className="form-input" style={{ marginTop: 6 }}
                  value={form.utilityType || ''}
                  onChange={e => set({ utilityType: e.target.value || null })}>
                  <option value="">Which utility? (optional)</option>
                  {UTILITIES.map(u => <option key={u} value={u}>{humanize(u)}</option>)}
                </select>
              )}
            </label>
            <label>Amount
              <input className="form-input" type="number" inputMode="decimal" placeholder="0.00" value={form.amount}
                disabled={!!editingRow?.fromBank} onChange={e => set({ amount: e.target.value })} />
            </label>
            <label>Date
              <input className="form-input" type="date" value={form.expenseDate}
                disabled={!!editingRow?.fromBank} onChange={e => set({ expenseDate: e.target.value })} />
            </label>
            <label>Paid to
              <select className="form-input" value={form.vendorId} onChange={e => set({ vendorId: e.target.value })}>
                <option value="">Someone not on your vendor list</option>
                {vendors.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
              </select>
              {!form.vendorId && (
                <input className="form-input" style={{ marginTop: 6 }} placeholder="Name (optional)" value={form.vendor}
                  onChange={e => set({ vendor: e.target.value })} />
              )}
            </label>
          </div>
          {editingRow?.fromBank && (
            <div className="fin-muted">This expense came from the bank feed, so its amount and date come from the bank.</div>
          )}
          <label>Description (optional — for example, fuel for the mower)
            <input className="form-input" value={form.description} onChange={e => set({ description: e.target.value })} />
          </label>

          {!editingId && (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button type="button" className={`btn btn-sm ${form.paidNow ? 'btn-primary' : 'btn-ghost'}`} onClick={() => set({ paidNow: true })}>
                Paid already
              </button>
              <button type="button" className={`btn btn-sm ${!form.paidNow ? 'btn-primary' : 'btn-ghost'}`} onClick={() => set({ paidNow: false })}>
                A bill to pay
              </button>
            </div>
          )}
          {!editingId && form.paidNow ? (
            <div className="fin-form-row">
              <label>Paid how
                <select className="form-input" value={form.method} onChange={e => set({ method: e.target.value as LandlordExpensePaymentMethod })}>
                  {LANDLORD_EXPENSE_PAYMENT_METHODS_ENTERED.map(m => <option key={m} value={m}>{LANDLORD_EXPENSE_PAYMENT_METHOD_LABEL[m]}</option>)}
                </select>
              </label>
              <label>Paid on
                <input className="form-input" type="date" value={form.paidOn || form.expenseDate} onChange={e => set({ paidOn: e.target.value })} />
              </label>
              {(form.method === 'bank' || form.method === 'check') && banks.length > 0 && (
                <label>From which bank (optional)
                  <select className="form-input" value={form.bankConnectionId} onChange={e => set({ bankConnectionId: e.target.value })}>
                    <option value="">Not sure</option>
                    {banks.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                  </select>
                </label>
              )}
            </div>
          ) : (
            <div className="fin-form-row">
              <label>Due date{editingId ? '' : ' (optional)'}
                <input className="form-input" type="date" value={form.dueDate} onChange={e => set({ dueDate: e.target.value })} />
              </label>
              <label>Bill or invoice number (optional)
                <input className="form-input" value={form.billNumber} maxLength={100} onChange={e => set({ billNumber: e.target.value })} />
              </label>
            </div>
          )}
          {!editingId && form.paidNow && (form.method === 'bank' || form.method === 'check') && (
            <div className="fin-muted">When the bank line arrives, match it to this expense on the Bank page so the books match your bank.</div>
          )}

          <label>Receipt (optional — PDF or a photo{editingRow?.receiptUrl ? '; choosing one replaces the one on file' : ''})
            <input key={fileKey} className="form-input" type="file" accept="application/pdf,image/*" style={{ paddingTop: 7 }}
              onChange={e => setReceipt(e.target.files?.[0] || null)} />
            {receipt && <span className="fin-muted">Attached: {receipt.name}</span>}
          </label>

          {err && <div className="fin-error">{err}</div>}
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-primary" disabled={!canSubmit || save.isLoading} onClick={() => save.mutate()}>
              {save.isLoading ? 'Saving…' : editingId ? 'Save changes' : form.paidNow ? 'Log expense' : 'Add bill'}
            </button>
            {editingId && <button className="btn btn-ghost" onClick={() => { resetForm(); setErr(null) }}>Cancel</button>}
          </div>
        </div>
      </div>

      <div className="card fin-card">
        <div className="fin-card-head">
          {(['all', 'open', 'paid'] as const).map(v => (
            <button key={v} type="button" className={`btn btn-sm ${view === v ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setView(v)}>
              {VIEW_LABEL[v]}
            </button>
          ))}
          <PropertyPicker value={filterPropertyId} onChange={setFilterPropertyId} properties={properties} />
          {shownExpenses.length > 0 && (
            <span className="fin-num" style={{ marginLeft: 'auto', fontSize: '.85rem', fontWeight: 700 }}>
              {view === 'open' ? `${money(shownTotal)} owed` : money(shownTotal)}
            </span>
          )}
        </div>
        {listError ? <div className="fin-empty">{errorWords(listError, 'Could not load expenses.')}</div> :
         isLoading ? <div className="fin-empty">Loading…</div> :
         shownExpenses.length === 0 ? <div className="fin-empty">
           {view === 'open' ? 'No bills to pay.' : expenses.length === 0 ? 'No expenses logged yet.' : 'No expenses logged at this property.'}
         </div> : (
          <table className="data-table">
            <thead><tr><th>Date</th><th>Category</th><th>Where</th><th>Paid to</th><th>Description</th><th className="fin-num">Amount</th><th>Status</th><th>Receipt</th><th></th></tr></thead>
            <tbody>
              {shownExpenses.map(e => (
                <ExpenseRow key={e.id} e={e} status={statusOf(e)} bookkeeper={bookkeeper}
                  paying={payingId === e.id} banks={(options?.banks ?? []).filter(b => b.landlordId === e.landlordId)}
                  pay={pay} setPay={p => setPay(x => ({ ...x, ...p }))} payErr={payErr} paySaving={payMut.isLoading}
                  onPay={() => startPay(e)} onCancelPay={() => setPayingId(null)} onSavePay={() => payMut.mutate(e.id)}
                  onTakeBack={async (paymentId) => {
                    if (await appConfirm('Take this payment back? The bill will be owed again (the payment is kept on record).', { confirmLabel: 'Take back' })) {
                      takeBack.mutate({ expenseId: e.id, paymentId })
                    }
                  }}
                  onEdit={() => startEdit(e)}
                  onRemove={async () => { if (await appConfirm('Remove this expense?', { danger: true, confirmLabel: 'Remove' })) voidMut.mutate(e.id) }}
                  openOwnerPage={openOwnerPage} />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

function ExpenseRow({ e, status, bookkeeper, paying, banks, pay, setPay, payErr, paySaving, onPay, onCancelPay, onSavePay, onTakeBack, onEdit, onRemove, openOwnerPage }: {
  e: Expense; status: string; bookkeeper: boolean; paying: boolean
  banks: Options['banks']; pay: ReturnType<typeof blankPay>; setPay: (p: Partial<ReturnType<typeof blankPay>>) => void
  payErr: string | null; paySaving: boolean
  onPay: () => void; onCancelPay: () => void; onSavePay: () => void; onTakeBack: (paymentId: string) => void
  onEdit: () => void; onRemove: () => void
  openOwnerPage: ((path: string) => void) | null
}) {
  const livePayments = (e.payments ?? []).filter(p => !p.voided)
  return (
    <>
      <tr>
        <td style={{ whiteSpace: 'nowrap' }}>{dayName(e.expenseDay)}</td>
        <td>
          {e.categoryName || humanize(e.category)}
          {!e.onProfitAndLoss && <div className="fin-muted">Not a business cost</div>}
        </td>
        <td className="fin-muted">
          {e.unitNumber ? `${e.propertyName ? e.propertyName + ' · ' : ''}Unit ${e.unitNumber}`
            : e.isCommon ? `${e.propertyName} · common (split per unit)` : (e.propertyName || 'Whole company')}
        </td>
        <td className="fin-muted">{e.vendorName || '—'}{e.billNumber ? <div>#{e.billNumber}</div> : null}</td>
        <td className="fin-muted">{e.description || '—'}</td>
        <td className="fin-num">{money(e.amount)}</td>
        <td className={e.payState === 'paid' ? 'fin-muted' : ''} style={{ whiteSpace: 'nowrap' }}>
          {status}
          {e.payState === 'partial' && <div className="fin-muted">{money(e.unpaid)} still owed</div>}
          {livePayments.length > 0 && (
            <div className="fin-muted">
              {livePayments.map(p => (
                <div key={p.id} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <span>{dayName(p.paidOn)} · {LANDLORD_EXPENSE_PAYMENT_METHOD_LABEL[p.method] ?? humanize(p.method)} · {money(p.amount)}</span>
                  {!p.bankTransactionId && p.source === 'payment' && !e.workTradePaidByHand && (
                    <button className="btn btn-ghost btn-sm" onClick={() => onTakeBack(p.id)}>Take back</button>
                  )}
                </div>
              ))}
            </div>
          )}
        </td>
        <td>{e.receiptUrl
          ? <button className="btn btn-ghost btn-sm" title={e.receiptName || 'View receipt'}
              onClick={() => openProtectedFile(e.receiptUrl!).catch(() => toast('Could not open the receipt.'))}>View</button>
          : <span className="fin-muted">—</span>}
        </td>
        <td>
          <div className="fin-row-actions">
            {e.canPay && !paying && <button className="btn btn-primary btn-sm" onClick={onPay}>Record payment</button>}
            {e.canEdit && <button className="btn btn-ghost btn-sm" onClick={onEdit}>Edit</button>}
            {e.canRemove && <button className="btn btn-ghost btn-sm" onClick={onRemove}>Remove</button>}
            {(e.fromBank || e.bankPaid) && !e.canRemove && !bookkeeper && (openOwnerPage && e.bankLineId
              ? <button className="btn btn-primary btn-sm" title="Split it, change it or undo it where the bank line is filed"
                  onClick={() => openOwnerPage(`/bank?line=${encodeURIComponent(e.bankLineId!)}&company=${encodeURIComponent(e.landlordId)}`)}>
                  Change on Bank page
                </button>
              : <span className="fin-muted">From your bank — change it on the Bank page</span>)}
          </div>
        </td>
      </tr>
      {paying && (
        <tr>
          <td colSpan={9}>
            <div className="fin-form-row" style={{ alignItems: 'end' }}>
              <label className="fin-field">Paid how
                <select className="form-input" value={pay.method} onChange={ev => setPay({ method: ev.target.value as LandlordExpensePaymentMethod })}>
                  {LANDLORD_EXPENSE_PAYMENT_METHODS_ENTERED.map(m => <option key={m} value={m}>{LANDLORD_EXPENSE_PAYMENT_METHOD_LABEL[m]}</option>)}
                </select>
              </label>
              <label className="fin-field">Amount (up to {money(e.unpaid)})
                <input className="form-input" type="number" inputMode="decimal" value={pay.amount} onChange={ev => setPay({ amount: ev.target.value })} />
              </label>
              <label className="fin-field">Paid on
                <input className="form-input" type="date" value={pay.paidOn} onChange={ev => setPay({ paidOn: ev.target.value })} />
              </label>
              {(pay.method === 'bank' || pay.method === 'check') && banks.length > 0 && (
                <label className="fin-field">From which bank (optional)
                  <select className="form-input" value={pay.bankConnectionId} onChange={ev => setPay({ bankConnectionId: ev.target.value })}>
                    <option value="">Not sure</option>
                    {banks.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                  </select>
                </label>
              )}
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn btn-primary btn-sm" disabled={paySaving || !(Number(pay.amount) > 0)} onClick={onSavePay}>
                  {paySaving ? 'Saving…' : 'Save payment'}
                </button>
                <button className="btn btn-ghost btn-sm" onClick={onCancelPay}>Cancel</button>
              </div>
            </div>
            {payErr && <div className="fin-error" style={{ marginTop: 6 }}>{payErr}</div>}
          </td>
        </tr>
      )}
    </>
  )
}
