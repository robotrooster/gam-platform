// S568 (Nic): landlord expense entry. Log an expense against a specific unit, or
// as a common (property-level) expense. Feeds the P&L / reports.
//
// 10/11 (Nic): "any receipts that I upload as expenses whether they're tacked
// on to a unit or to a whole property... miscellaneous purchases like fuel for
// equipment... They need to see all of that stuff." One of the shared financial
// pages — the same bytes in the landlord portal and GAM Books
// (financials-parity.test.ts). The owner adds, edits and removes; a bookkeeper
// ("Look + add expenses") sees the expenses of the properties they keep, adds
// their own and corrects the ones they entered. The API decides what each row
// allows (canEdit / canRemove) and checks every id it is sent.
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { EXPENSE_CATEGORIES, EXPENSE_CATEGORY_LABEL, humanize } from '@gam/shared'
import { finGet, finPost, finPatch, finUpload, openProtectedFile, toast, appConfirm } from './adapter'
import { useFinancialsScope, money, dayName, errorWords, PropertyPicker, PageHead, Notice } from './common'

const today = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const UTILITIES = ['electric', 'water', 'sewer', 'gas', 'trash', 'propane'] as const

interface Expense {
  id: string; category: string; amount: number; description: string | null; vendor: string | null
  expenseDay: string; isCommon: boolean; unitId: string | null; propertyId: string | null
  unitNumber: string | null; propertyName: string | null; utilityType: string | null
  receiptUrl: string | null; receiptName: string | null; fromBank: boolean
  canEdit: boolean; canRemove: boolean
}
interface Unit { id: string; unitNumber: string; propertyId: string }

const blankForm = () => ({
  propertyId: '', unitId: '', scope: 'unit' as 'unit' | 'common',
  category: 'repairs', amount: '', description: '', vendor: '', expenseDate: today(),
  // S613: which utility, when category = utilities. Feeds the recovery report.
  utilityType: null as string | null,
})

export function ExpensesPage() {
  const qc = useQueryClient()
  const { data: scope, error: scopeError } = useFinancialsScope()
  const properties = scope?.properties ?? []
  const { data: units = [] } = useQuery<Unit[]>('financials-units', () => finGet<Unit[]>('/financials/units'))
  const { data: expenses = [], isLoading, error: listError } = useQuery<Expense[]>('landlord-expenses', () => finGet<Expense[]>('/expenses'))
  const bookkeeper = scope?.viewer === 'bookkeeper'

  const [form, setForm] = useState(blankForm)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [receipt, setReceipt] = useState<File | null>(null)
  const [fileKey, setFileKey] = useState(0)
  const set = (patch: Partial<ReturnType<typeof blankForm>>) => setForm(f => ({ ...f, ...patch }))
  const propUnits = units.filter(u => u.propertyId === form.propertyId)

  // S637 (Nic, DIRECTIVE): "expenses, selected property." Options come from the
  // PROPERTIES the viewer keeps, not from the expense rows, so a park with
  // nothing logged yet is still selectable.
  const [filterPropertyId, setFilterPropertyId] = useState('')
  const shownExpenses = expenses.filter(e => filterPropertyId === '' || e.propertyId === filterPropertyId)
  const shownTotal = shownExpenses.reduce((sum, e) => sum + Number(e.amount || 0), 0)

  const resetForm = () => {
    setEditingId(null); setReceipt(null); setFileKey(k => k + 1)
    setForm(f => ({ ...blankForm(), propertyId: f.propertyId, scope: f.scope }))
  }

  const save = useMutation(
    async () => {
      const body = {
        category: form.category, amount: Number(form.amount), expenseDate: form.expenseDate,
        utilityType: form.category === 'utilities' ? form.utilityType : null,
        description: form.description.trim() || null, vendor: form.vendor.trim() || null,
        // A company-wide expense (no property, e.g. filed from the bank feed)
        // keeps its place unless a property is chosen for it.
        ...(form.scope === 'unit'
          ? { unitId: form.unitId, propertyId: null }
          : form.propertyId ? { propertyId: form.propertyId, unitId: null } : {}),
      }
      let id = editingId
      if (id) {
        await finPatch(`/expenses/${id}`, body)
      } else {
        const res = await finPost<Expense>('/expenses', { ...body, isCommon: form.scope === 'common' })
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
          // (a bookkeeper could not remove the duplicate).
          if (!editingId) {
            setEditingId(id)
            qc.invalidateQueries('landlord-expenses')
          }
          throw Object.assign(new Error(errorWords(e, 'The file could not be uploaded.')), { receiptOnly: true })
        }
      }
      return id
    },
    { onSuccess: () => {
        qc.invalidateQueries('landlord-expenses')
        toast(editingId ? 'Expense updated.' : 'Expense logged.')
        setErr(null)
        resetForm()
      },
      onError: (e: any) => setErr(e?.receiptOnly
        ? `Expense saved, but the receipt did not upload (${String(e.message).replace(/\.+$/, '')}). Choose the file again if needed and save to retry the receipt.`
        : errorWords(e, e?.message || 'Could not save the expense.')) })

  const voidMut = useMutation(
    (id: string) => finPost(`/expenses/${id}/void`, {}),
    { onSuccess: () => { qc.invalidateQueries('landlord-expenses'); toast('Expense removed.') },
      onError: (e: any) => toast(errorWords(e, 'Could not remove the expense.')) })

  const startEdit = (e: Expense) => {
    setEditingId(e.id); setErr(null); setReceipt(null); setFileKey(k => k + 1)
    setForm({
      propertyId: e.propertyId || '', unitId: e.unitId || '', scope: e.unitId ? 'unit' : 'common',
      category: e.category, amount: String(e.amount), description: e.description || '', vendor: e.vendor || '',
      expenseDate: e.expenseDay, utilityType: e.utilityType,
    })
  }
  const editing = editingId ? expenses.find(e => e.id === editingId) : null

  const canSubmit = form.amount && Number(form.amount) > 0 && form.expenseDate &&
    (form.scope === 'unit' ? form.unitId : (form.propertyId || (editing && !editing.propertyId)))

  return (
    <div className="fin">
      <PageHead title="Expenses"
        subtitle={bookkeeper
          ? 'Expenses for the properties you keep, with their receipts. Add the ones you have — they flow into the P&L.'
          : 'Log expenses against a unit or as a common property expense — they flow into your P&L.'} />
      {scopeError ? <Notice>{errorWords(scopeError, 'Could not load your books.')}</Notice> : null}

      <div className="card" style={{ marginBottom: 20, maxWidth: 680 }}>
        <div className="card-title" style={{ marginBottom: 14 }}>{editingId ? 'Edit this expense' : 'Log an expense'}</div>
        <div className="fin-form">
          <label>Property
            <select className="form-input" value={form.propertyId}
              onChange={e => set({ propertyId: e.target.value, unitId: '' })}>
              <option value="">Select a property…</option>
              {properties.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
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
              <select className="form-input" value={form.category} onChange={e => set({ category: e.target.value })}>
                {EXPENSE_CATEGORIES.map(c => <option key={c} value={c}>{EXPENSE_CATEGORY_LABEL[c]}</option>)}
              </select>
              {/* S613 (Nic): tagging which utility lets the Utilities page compare
                  what was spent against what was billed back, per utility. */}
              {form.category === 'utilities' && (
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
                disabled={!!editing?.fromBank} onChange={e => set({ amount: e.target.value })} />
            </label>
            <label>Date
              <input className="form-input" type="date" value={form.expenseDate}
                disabled={!!editing?.fromBank} onChange={e => set({ expenseDate: e.target.value })} />
            </label>
            <label>Vendor (optional)
              <input className="form-input" value={form.vendor} onChange={e => set({ vendor: e.target.value })} />
            </label>
          </div>
          {editing?.fromBank && (
            <div className="fin-muted">This expense came from the bank feed, so its amount and date come from the bank.</div>
          )}
          <label>Description (optional — for example, fuel for the mower)
            <input className="form-input" value={form.description} onChange={e => set({ description: e.target.value })} />
          </label>

          <label>Receipt (optional — PDF or a photo{editing?.receiptUrl ? '; choosing one replaces the one on file' : ''})
            <input key={fileKey} className="form-input" type="file" accept="application/pdf,image/*" style={{ paddingTop: 7 }}
              onChange={e => setReceipt(e.target.files?.[0] || null)} />
            {receipt && <span className="fin-muted">Attached: {receipt.name}</span>}
          </label>

          {err && <div className="fin-error">{err}</div>}
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-primary" disabled={!canSubmit || save.isLoading} onClick={() => save.mutate()}>
              {save.isLoading ? 'Saving…' : editingId ? 'Save changes' : 'Log expense'}
            </button>
            {editingId && <button className="btn btn-ghost" onClick={() => { resetForm(); setErr(null) }}>Cancel</button>}
          </div>
        </div>
      </div>

      <div className="card fin-card">
        <div className="fin-card-head">
          <span className="fin-card-title">Logged expenses</span>
          <PropertyPicker value={filterPropertyId} onChange={setFilterPropertyId} properties={properties} />
          {shownExpenses.length > 0 && (
            <span className="fin-num" style={{ marginLeft: 'auto', fontSize: '.85rem', fontWeight: 700 }}>{money(shownTotal)}</span>
          )}
        </div>
        {listError ? <div className="fin-empty">{errorWords(listError, 'Could not load expenses.')}</div> :
         isLoading ? <div className="fin-empty">Loading…</div> :
         shownExpenses.length === 0 ? <div className="fin-empty">
           {expenses.length === 0 ? 'No expenses logged yet.' : 'No expenses logged at this property.'}
         </div> : (
          <table className="data-table">
            <thead><tr><th>Date</th><th>Category</th><th>Where</th><th>Vendor</th><th>Description</th><th className="fin-num">Amount</th><th>Receipt</th><th></th></tr></thead>
            <tbody>
              {shownExpenses.map(e => (
                <tr key={e.id}>
                  <td style={{ whiteSpace: 'nowrap' }}>{dayName(e.expenseDay)}</td>
                  <td>{EXPENSE_CATEGORY_LABEL[e.category as keyof typeof EXPENSE_CATEGORY_LABEL] || humanize(e.category)}</td>
                  <td className="fin-muted">
                    {e.unitNumber ? `${e.propertyName ? e.propertyName + ' · ' : ''}Unit ${e.unitNumber}`
                      : e.isCommon ? `${e.propertyName} · common (split per unit)` : (e.propertyName || 'Whole company')}
                  </td>
                  <td className="fin-muted">{e.vendor || '—'}</td>
                  <td className="fin-muted">{e.description || '—'}</td>
                  <td className="fin-num">{money(e.amount)}</td>
                  <td>{e.receiptUrl
                    ? <button className="btn btn-ghost btn-sm" title={e.receiptName || 'View receipt'}
                        onClick={() => openProtectedFile(e.receiptUrl!).catch(() => toast('Could not open the receipt.'))}>View</button>
                    : <span className="fin-muted">—</span>}
                  </td>
                  <td>
                    <div className="fin-row-actions">
                      {e.canEdit && <button className="btn btn-ghost btn-sm" onClick={() => startEdit(e)}>Edit</button>}
                      {e.canRemove && <button className="btn btn-ghost btn-sm"
                        onClick={async () => { if (await appConfirm('Remove this expense?', { danger: true, confirmLabel: 'Remove' })) voidMut.mutate(e.id) }}>Remove</button>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
