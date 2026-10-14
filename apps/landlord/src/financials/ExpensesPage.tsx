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
//
// 10/13 (Nic): "each expense is chosen on the split or specific unit or
// property at the time of logging. there should never be a default setting to
// apply expenses." The form asks where each cost goes — one unit, one
// property, or split across the company's properties by units — with nothing
// chosen ahead of time and nothing carried over from the last expense; it does
// not save until that is answered (the API refuses it too). And on cash on
// hand: "they don't pick as a setting, they pick as the expense happens" —
// how it was paid (cash from the office, a check, a card, the owner, the
// bank) is chosen on each expense and each payment, never preselected.
// 10/13 review: money out that is not a cost (an owner's draw) is not split
// across the properties; it goes on a unit, a property, or the company.
import { useMemo, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import {
  EXPENSE_PAY_STATE_LABEL, LANDLORD_EXPENSE_PAYMENT_METHODS_ENTERED, LANDLORD_EXPENSE_PAYMENT_METHOD_LABEL, humanize,
  BOOKS_COST_PLACE_LABEL, BOOKS_COST_PLACE_NONE_LABEL,
  type ExpensePayState, type LandlordExpensePaymentMethod, type BooksCostPlace,
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
  /** 10/13 (Nic): where its cost goes, as picked when it was logged (null: logged before 10/13). */
  costPlace: BooksCostPlace | null
  /** A bill GAM keeps for another record (a payroll run's, a manager's cut, a fixed asset's): not removed here. */
  systemLinked?: boolean
  /** 10/13 review: any bill GAM keeps for another record (those, and a work trader's hours): its place is that record's. */
  placeFixed?: boolean
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
  /** 10/13 review: false for a bookkeeper kept to some properties (a split reaches every property). */
  canSplit?: boolean
}
interface Unit { id: string; unitNumber: string; propertyId: string }

type View = 'all' | 'open' | 'paid'
/** 10/13 review: where money out goes on the form — a cost's places, and the company for money out that is not a cost. */
type FormPlace = BooksCostPlace | 'company'
/** 10/13 (Nic): the places a cost can go, in the order the form offers them. */
const PLACE_ORDER: readonly BooksCostPlace[] = ['unit', 'property', 'split_by_units']
/** 10/13 review: money out that is not a cost (an owner's draw) is never split; it may sit on the company. */
const NOT_A_COST_PLACES: readonly FormPlace[] = ['unit', 'property', 'company']
const placeLabel = (s: FormPlace) => (s === 'company' ? BOOKS_COST_PLACE_NONE_LABEL : BOOKS_COST_PLACE_LABEL[s])
/** 10/13 (Nic): where an expense's cost goes, in words, for its row. */
function placeWords(e: Pick<Expense, 'unitNumber' | 'propertyName' | 'costPlace' | 'isCommon'>): string {
  if (e.unitNumber) return `${e.propertyName ? e.propertyName + ' · ' : ''}Unit ${e.unitNumber}`
  if (e.costPlace === 'split_by_units') return BOOKS_COST_PLACE_LABEL.split_by_units  // wire-ok: a shared label key, not a field off an API response
  if (e.propertyName) return e.isCommon ? `${e.propertyName} · common (split per unit)` : e.propertyName
  return BOOKS_COST_PLACE_NONE_LABEL
}
const VIEW_LABEL: Record<View, string> = { all: 'All expenses', open: 'Bills to pay', paid: 'Paid' }

const blankForm = () => ({
  // 10/13 (Nic): where the cost goes — nothing chosen until the person chooses.
  propertyId: '', unitId: '', scope: '' as FormPlace | '', companyId: '',
  categoryId: '', amount: '', description: '', vendorId: '', vendor: '', expenseDate: today(),
  // S613: which utility, when the category is utilities. Feeds the recovery report.
  utilityType: null as string | null,
  // 10/12 (Nic, L5): paid now (and how), or a bill to pay. 10/13 (Nic): "they
  // don't pick as a setting, they pick as the expense happens" — how it was
  // paid starts blank. 10/14 (Nic): "paid already" or "a bill to pay later"
  // starts unanswered too (null) — the form does not save until it is picked.
  paidNow: null as boolean | null, method: '' as LandlordExpensePaymentMethod | '', paidOn: '', bankConnectionId: '',
  dueDate: '', billNumber: '',
})
const blankPay = () => ({ method: '' as LandlordExpensePaymentMethod | '', amount: '', paidOn: today(), bankConnectionId: '' })

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

  // The company the form files under: the chosen property's, else the one
  // chosen for a split or the company itself (several companies), else the only one.
  const companies = scope?.companies ?? []
  const onNoProperty = form.scope === 'split_by_units' || form.scope === 'company'
  const companyId = (!onNoProperty ? properties.find(p => p.id === form.propertyId)?.landlordId : null)
    ?? (form.companyId || null)
    ?? (companies.length === 1 ? companies[0].id : null)
  const editingRow = editingId ? expenses.find(e => e.id === editingId) : null
  // 10/13: a bill GAM keeps for another record keeps that record's place.
  const placeFixed = !!(editingRow?.placeFixed ?? editingRow?.systemLinked)
  const formCompany = editingRow?.landlordId ?? companyId
  const categories = useMemo(() => (options?.categories ?? [])
    .filter(c => c.direction === 'expense' && (c.inPicker || c.id === form.categoryId) && (!formCompany || c.landlordId === formCompany)),
  [options, formCompany, form.categoryId])
  const vendors = (options?.vendors ?? []).filter(v => !formCompany || v.landlordId === formCompany)
  const banks = (options?.banks ?? []).filter(b => !formCompany || b.landlordId === formCompany)
  const chosenCategory = categories.find(c => c.id === form.categoryId) ?? null
  const isUtilities = chosenCategory?.systemKey === 'utilities'
  // 10/13 review: the places offered — a cost's, or, for money out that is
  // not a cost, a unit, a property or the company. A split and the company
  // reach the whole company, so only to someone who keeps all of it.
  const notACost = !!chosenCategory && !chosenCategory.onProfitAndLoss
  const wholeCompany = options?.canSplit !== false
  const places: readonly FormPlace[] = (notACost ? NOT_A_COST_PLACES : PLACE_ORDER)
    .filter(s => (s !== 'split_by_units' && s !== 'company') || wholeCompany)
  const setCategory = (categoryId: string) => {
    const c = categories.find(x => x.id === categoryId)
    const offered: readonly FormPlace[] = c && !c.onProfitAndLoss ? NOT_A_COST_PLACES : PLACE_ORDER
    // A place the new category does not offer is asked again.
    set({ categoryId, ...(form.scope && !offered.includes(form.scope) ? { scope: '' as const } : {}) })
  }

  // S637 (Nic, DIRECTIVE): "expenses, selected property." Options come from the
  // PROPERTIES the viewer keeps, not from the expense rows, so a park with
  // nothing logged yet is still selectable.
  const [filterPropertyId, setFilterPropertyId] = useState('')
  const shownExpenses = expenses.filter(e => filterPropertyId === '' || e.propertyId === filterPropertyId)
  const shownTotal = shownExpenses.reduce((sum, e) => sum + Number((view === 'open' ? e.unpaid : e.amount) || 0), 0)

  const resetForm = () => {
    setEditingId(null); setReceipt(null); setFileKey(k => k + 1)
    // 10/13 (Nic): the next expense asks again — nothing carried over.
    setForm(blankForm())
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
        // 10/13 (Nic): where the cost goes, as chosen (a bill another record
        // keeps stays where that record put it).
        ...(placeFixed ? {} : form.scope === 'unit'
          ? { costPlace: 'unit', unitId: form.unitId, propertyId: null }
          : form.scope === 'property'
            ? { costPlace: 'property', propertyId: form.propertyId, unitId: null }
            : form.scope === 'company'
              ? { costPlace: null, propertyId: null, unitId: null }
              : { costPlace: 'split_by_units', propertyId: null, unitId: null }),
        billNumber: form.billNumber.trim() || null,
        dueDate: form.dueDate || null,
      }
      let id = editingId
      if (id) {
        await finPatch(`/expenses/${id}`, body)
      } else {
        const res = await finPost<Expense>('/expenses', {
          ...body, isCommon: form.scope === 'property',
          // A split, or money out on the company, names no property: the company it is for.
          ...(onNoProperty && companyId ? { landlordId: companyId } : {}),
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
      propertyId: e.propertyId || '', unitId: e.unitId || '', companyId: e.landlordId,
      // One logged before 10/13 on no property asks again; money out that is
      // not a cost on no property is on the company.
      scope: e.costPlace ?? (e.unitId ? 'unit' : e.propertyId ? 'property' : !e.onProfitAndLoss ? 'company' : ''),
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
    (placeFixed || (form.scope === 'unit' ? form.unitId : form.scope === 'property' ? form.propertyId
      : onNoProperty && places.includes(form.scope as FormPlace) ? !!companyId : false)) &&
    // 10/13 (Nic): how it was paid is picked on each expense.
    // 10/14 (Nic): paid already or a bill to pay — picked on each one.
    (editingId || form.paidNow === false || (form.paidNow === true && !!form.method))

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
          {/* 10/13 (Nic): "each expense is chosen on the split or specific unit
              or property at the time of logging" — asked first, nothing chosen. */}
          {placeFixed && editingRow ? (
            <div className="fin-muted" style={{ padding: '2px 0' }}>Goes to {placeWords(editingRow)}, where the record it is for put it.</div>
          ) : <>
          <div className="fin-muted" style={{ padding: '2px 0' }}>{notACost ? 'Where does this go?' : 'Where does this cost go?'}</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {places.map(s => (
              <button key={s} type="button" className={`btn btn-sm ${form.scope === s ? 'btn-primary' : 'btn-ghost'}`}
                onClick={() => set({ scope: s, unitId: s === 'unit' ? form.unitId : '' })}>
                {placeLabel(s)}
              </button>
            ))}
          </div>

          {(form.scope === 'unit' || form.scope === 'property') && (
            <label>Property
              <select className="form-input" value={form.propertyId}
                onChange={e => set({ propertyId: e.target.value, unitId: '' })}>
                <option value="">Select a property…</option>
                {/* 10/12: a property that left the company is read only — nothing is filed on it. */}
                {properties.filter(p => !p.leftOn).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </label>
          )}

          {form.scope === 'unit' && (
            <label>Unit
              <select className="form-input" value={form.unitId} onChange={e => set({ unitId: e.target.value })} disabled={!form.propertyId}>
                <option value="">Select a unit…</option>
                {propUnits.map(u => <option key={u.id} value={u.id}>Unit {u.unitNumber}</option>)}
              </select>
            </label>
          )}
          {form.scope === 'property' && (
            // S603 (Nic): any expense not tied to a specific unit is divided
            // evenly across that property's units, so per-unit cost reflects reality.
            <div className="fin-muted" style={{ padding: '4px 0' }}>
              This cost will be divided evenly across every unit at the property,
              including vacant ones, so per-unit numbers stay accurate.
            </div>
          )}
          {onNoProperty && places.includes(form.scope as FormPlace) && (
            <>
              {companies.length > 1 && !editingRow && (
                <label>Company
                  <select className="form-input" value={form.companyId} onChange={e => set({ companyId: e.target.value })}>
                    <option value="">Select a company…</option>
                    {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </label>
              )}
              <div className="fin-muted" style={{ padding: '4px 0' }}>
                {form.scope === 'company'
                  ? `${chosenCategory?.name ?? 'This'} is not a cost, so it is not split; it goes on the company.`
                  : 'This cost is split across all of the company\'s properties by how many units each has on its date.'}
              </div>
            </>
          )}
          </>}

          <div className="fin-form-row">
            <label>Category
              <select className="form-input" value={form.categoryId} onChange={e => setCategory(e.target.value)}>
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
              <button type="button" className={`btn btn-sm ${form.paidNow === true ? 'btn-primary' : 'btn-ghost'}`} onClick={() => set({ paidNow: true })}>
                Paid already
              </button>
              <button type="button" className={`btn btn-sm ${form.paidNow === false ? 'btn-primary' : 'btn-ghost'}`} onClick={() => set({ paidNow: false })}>
                A bill to pay
              </button>
            </div>
          )}
          {!editingId && form.paidNow === true ? (
            <div className="fin-form-row">
              <label>Paid how
                <select className="form-input" value={form.method} onChange={e => set({ method: e.target.value as LandlordExpensePaymentMethod | '' })}>
                  <option value="">Choose how it was paid…</option>
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
          ) : (editingId || form.paidNow === false) && (
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
              {save.isLoading ? 'Saving…' : editingId ? 'Save changes' : form.paidNow === false ? 'Add bill' : 'Log expense'}
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
          {placeWords(e)}
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
                <select className="form-input" value={pay.method} onChange={ev => setPay({ method: ev.target.value as LandlordExpensePaymentMethod | '' })}>
                  <option value="">Choose how it was paid…</option>
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
                <button className="btn btn-primary btn-sm" disabled={paySaving || !(Number(pay.amount) > 0) || !pay.method} onClick={onSavePay}>
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
