// S568 (Nic): landlord expense entry. Log an expense against a specific unit, or
// as a common (property-level) expense — and for common expenses, choose whether
// to divide it per unit across the property. Feeds the P&L / reports.
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { apiGet, apiPost, api } from '../lib/api'
import { EXPENSE_CATEGORIES, EXPENSE_CATEGORY_LABEL, humanize } from '@gam/shared'
import { toast, appConfirm } from '../components/dialogs'
import { Trash2, Paperclip } from 'lucide-react'

const fmt = (n: any) => n != null ? `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—'
const today = () => new Date().toISOString().slice(0, 10)

// Receipt files sit behind the authed /api/expenses/receipt-files route, so a
// plain <a href> would 401. Fetch the blob with the bearer token and open it.
const API_BASE = (import.meta as any).env?.VITE_API_URL || 'http://localhost:4000'
async function openReceipt(url: string) {
  try {
    const token = localStorage.getItem('gam_token') || ''
    const r = await fetch(`${API_BASE}${url}`, { headers: { Authorization: 'Bearer ' + token } })
    if (!r.ok) throw new Error('status ' + r.status)
    const obj = URL.createObjectURL(await r.blob())
    window.open(obj, '_blank')
    setTimeout(() => URL.revokeObjectURL(obj), 60000)
  } catch { toast('Could not open the receipt.') }
}

export function ExpensesPage() {
  const qc = useQueryClient()
  const { data: properties = [] } = useQuery<any[]>('properties', () => apiGet('/properties'))
  const { data: units = [] } = useQuery<any[]>('units', () => apiGet('/units'))
  const { data: expenses = [], isLoading } = useQuery<any[]>('landlord-expenses', () => apiGet('/expenses'))

  const [form, setForm] = useState({
    propertyId: '', unitId: '', scope: 'unit' as 'unit' | 'common',
    category: 'repairs', amount: '', description: '', vendor: '', expenseDate: today(), allocatePerUnit: false,
  })
  const [err, setErr] = useState<string | null>(null)
  const [receipt, setReceipt] = useState<File | null>(null)
  const set = (patch: Partial<typeof form>) => setForm(f => ({ ...f, ...patch }))

  const propUnits = (units as any[]).filter(u => u.propertyId === form.propertyId || u.property_id === form.propertyId)

  const create = useMutation(
    async () => {
      const res = await apiPost<any>('/expenses', {
        category: form.category, amount: Number(form.amount), expenseDate: form.expenseDate,
        description: form.description.trim() || null, vendor: form.vendor.trim() || null,
        ...(form.scope === 'unit'
          ? { unitId: form.unitId }
          : { propertyId: form.propertyId, isCommon: true, allocatePerUnit: form.allocatePerUnit }),
      })
      // Chain the receipt upload onto the freshly-created expense (S575). One
      // "Log expense" click; the file is optional.
      const created = res?.data
      if (receipt && created?.id) {
        const fd = new FormData()
        fd.append('receipt', receipt)
        await api.post(`/expenses/${created.id}/receipt`, fd, { headers: { 'Content-Type': 'multipart/form-data' } })
      }
      return created
    },
    { onSuccess: () => { qc.invalidateQueries('landlord-expenses'); toast('Expense logged.'); setErr(null)
        setReceipt(null)
        setForm(f => ({ ...f, amount: '', description: '', vendor: '' })) },
      onError: (e: any) => setErr(e?.response?.data?.message || e?.message || 'Could not log the expense.') })

  const voidMut = useMutation(
    (id: string) => apiPost(`/expenses/${id}/void`, {}),
    { onSuccess: () => { qc.invalidateQueries('landlord-expenses'); toast('Expense removed.') } })

  const canSubmit = form.amount && Number(form.amount) > 0 && form.expenseDate &&
    (form.scope === 'unit' ? form.unitId : form.propertyId)

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">Expenses</h1>
          <p className="page-subtitle">Log expenses against a unit or as a common property expense — they flow into your P&L.</p>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 20, maxWidth: 640 }}>
        <div className="card-title" style={{ marginBottom: 14 }}>Log an expense</div>
        <div style={{ display: 'grid', gap: 10 }}>
          <label style={{ fontSize: '.75rem', color: 'var(--text-3)' }}>Property
            <select className="form-input" value={form.propertyId}
              onChange={e => set({ propertyId: e.target.value, unitId: '' })}>
              <option value="">Select a property…</option>
              {(properties as any[]).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>

          <div style={{ display: 'flex', gap: 8 }}>
            {(['unit', 'common'] as const).map(s => (
              <button key={s} type="button" className={`btn btn-sm ${form.scope === s ? 'btn-primary' : 'btn-ghost'}`}
                onClick={() => set({ scope: s })} disabled={!form.propertyId}>
                {s === 'unit' ? 'For a specific unit' : 'Common (whole property)'}
              </button>
            ))}
          </div>

          {form.scope === 'unit' ? (
            <label style={{ fontSize: '.75rem', color: 'var(--text-3)' }}>Unit
              <select className="form-input" value={form.unitId} onChange={e => set({ unitId: e.target.value })} disabled={!form.propertyId}>
                <option value="">Select a unit…</option>
                {propUnits.map(u => <option key={u.id} value={u.id}>Unit {u.unitNumber ?? u.unit_number}</option>)}
              </select>
            </label>
          ) : (
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '.8rem', color: 'var(--text-2)', padding: '8px 0' }}>
              <input type="checkbox" checked={form.allocatePerUnit} onChange={e => set({ allocatePerUnit: e.target.checked })} />
              Divide this expense evenly per unit across the property (for per-unit P&L)
            </label>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <label style={{ fontSize: '.75rem', color: 'var(--text-3)' }}>Category
              <select className="form-input" value={form.category} onChange={e => set({ category: e.target.value })}>
                {EXPENSE_CATEGORIES.map(c => <option key={c} value={c}>{EXPENSE_CATEGORY_LABEL[c]}</option>)}
              </select>
            </label>
            <label style={{ fontSize: '.75rem', color: 'var(--text-3)' }}>Amount
              <input className="form-input" type="number" inputMode="decimal" placeholder="0.00" value={form.amount} onChange={e => set({ amount: e.target.value })} />
            </label>
            <label style={{ fontSize: '.75rem', color: 'var(--text-3)' }}>Date
              <input className="form-input" type="date" value={form.expenseDate} onChange={e => set({ expenseDate: e.target.value })} />
            </label>
            <label style={{ fontSize: '.75rem', color: 'var(--text-3)' }}>Vendor (optional)
              <input className="form-input" value={form.vendor} onChange={e => set({ vendor: e.target.value })} />
            </label>
          </div>
          <label style={{ fontSize: '.75rem', color: 'var(--text-3)' }}>Description (optional)
            <input className="form-input" value={form.description} onChange={e => set({ description: e.target.value })} />
          </label>

          <label style={{ fontSize: '.75rem', color: 'var(--text-3)' }}>Receipt (optional — PDF or image, for your records &amp; taxes)
            <input className="form-input" type="file" accept="application/pdf,image/*" style={{ paddingTop: 7 }}
              onChange={e => setReceipt(e.target.files?.[0] || null)} />
            {receipt && <span style={{ fontSize: '.72rem', color: 'var(--text-2)', display: 'inline-flex', alignItems: 'center', gap: 4, marginTop: 4 }}>
              <Paperclip size={11} /> {receipt.name}</span>}
          </label>

          {err && <div style={{ fontSize: '.75rem', color: 'var(--red)' }}>{err}</div>}
          <div>
            <button className="btn btn-primary" disabled={!canSubmit || create.isLoading} onClick={() => create.mutate()}>
              {create.isLoading ? 'Logging…' : 'Log expense'}
            </button>
          </div>
        </div>
      </div>

      <div className="card" style={{ padding: 0 }}>
        <div className="card-title" style={{ padding: '14px 16px 0' }}>Logged expenses</div>
        {isLoading ? <div style={{ padding: 24, color: 'var(--text-3)' }}>Loading…</div> :
         (expenses as any[]).length === 0 ? <div style={{ padding: 24, color: 'var(--text-3)', fontSize: '.85rem' }}>No expenses logged yet.</div> : (
          <table className="data-table">
            <thead><tr><th>Date</th><th>Category</th><th>Scope</th><th>Amount</th><th>Description</th><th>Receipt</th><th></th></tr></thead>
            <tbody>
              {(expenses as any[]).map(e => (
                <tr key={e.id}>
                  <td style={{ fontSize: '.8rem' }}>{new Date(String(e.expenseDate).slice(0, 10) + 'T12:00:00').toLocaleDateString()}</td>
                  <td>{EXPENSE_CATEGORY_LABEL[e.category as keyof typeof EXPENSE_CATEGORY_LABEL] || humanize(e.category)}</td>
                  <td style={{ fontSize: '.78rem', color: 'var(--text-3)' }}>
                    {e.unitNumber ? `Unit ${e.unitNumber}` : e.isCommon ? `${e.propertyName} · common${e.allocatePerUnit ? ' (per unit)' : ''}` : (e.propertyName || '—')}
                  </td>
                  <td>{fmt(e.amount)}</td>
                  <td style={{ fontSize: '.78rem', color: 'var(--text-3)' }}>{e.description || '—'}</td>
                  <td>{e.receiptUrl
                    ? <button className="btn btn-ghost btn-sm" style={{ padding: '2px 8px', display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: '.72rem' }}
                        onClick={() => openReceipt(e.receiptUrl)} title={e.receiptName || 'View receipt'}>
                        <Paperclip size={12} /> View</button>
                    : <span style={{ fontSize: '.75rem', color: 'var(--text-3)' }}>—</span>}
                  </td>
                  <td><button className="btn btn-ghost btn-sm" style={{ padding: 4 }}
                    onClick={async () => { if (await appConfirm('Remove this expense?')) voidMut.mutate(e.id) }}><Trash2 size={13} /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
