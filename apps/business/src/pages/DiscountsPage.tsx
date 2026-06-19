import { useEffect, useState } from 'react'
import { apiGet, apiPost, apiPatch, apiDelete } from '../lib/api'
import { Modal } from '../components/Modal'
import { Tag, Plus, Trash2, Power } from 'lucide-react'

interface DiscountCode {
  id: string
  code: string
  description: string | null
  discountType: 'percent' | 'fixed'
  discountValue: string
  isActive: boolean
  startsAt: string | null
  expiresAt: string | null
  maxRedemptions: number | null
  redemptionCount: number
  createdAt: string
}

function fmtValue(d: DiscountCode): string {
  return d.discountType === 'percent'
    ? `${Number(d.discountValue)}% off`
    : `$${Number(d.discountValue).toFixed(2)} off`
}

function fmtDate(s: string | null): string {
  if (!s) return '—'
  return new Date(s).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })
}

// datetime-local <-> ISO. The control gives a tz-less "YYYY-MM-DDTHH:mm";
// the API wants a full ISO string, and we want a plain date back in.
function isoToLocalDate(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  return d.toISOString().slice(0, 10)
}
function localDateToIso(d: string): string | null {
  if (!d) return null
  return new Date(`${d}T00:00:00`).toISOString()
}

export function DiscountsPage() {
  const [codes, setCodes] = useState<DiscountCode[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<DiscountCode | 'new' | null>(null)

  const reload = async () => {
    setErr(null)
    try {
      setCodes(await apiGet<DiscountCode[]>('/business-discounts'))
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Failed to load')
    } finally { setLoading(false) }
  }
  useEffect(() => { reload() }, [])

  const toggleActive = async (d: DiscountCode) => {
    try {
      await apiPatch(`/business-discounts/${d.id}`, { isActive: !d.isActive })
      reload()
    } catch (e: any) { setErr(e?.response?.data?.error || 'Failed') }
  }

  const remove = async (d: DiscountCode) => {
    if (!confirm(`Delete code ${d.code}? This can't be undone.`)) return
    try {
      await apiDelete(`/business-discounts/${d.id}`)
      reload()
    } catch (e: any) { setErr(e?.response?.data?.error || 'Failed to delete') }
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 16 }}>
        <div>
          <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 28, margin: 0 }}>Discounts</h1>
          <div style={{ color: 'var(--text-2)', fontSize: 14, marginTop: 4 }}>
            Codes apply pre-tax at the register or on an invoice.
          </div>
        </div>
        <button onClick={() => setEditing('new')} style={primaryBtn}>
          <Plus size={14} /> New code
        </button>
      </div>

      {err && <div style={errStyle}>{err}</div>}

      {loading ? (
        <div style={{ color: 'var(--text-2)' }}>Loading…</div>
      ) : codes.length === 0 ? (
        <div style={emptyStyle}>
          <Tag size={32} color="var(--text-3)" style={{ marginBottom: 8 }} />
          <div>No discount codes yet. Create one to offer % or $ off at checkout.</div>
        </div>
      ) : (
        <table style={tableStyle}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border-1)' }}>
              <th style={thStyle}>Code</th>
              <th style={thStyle}>Discount</th>
              <th style={thStyle}>Window</th>
              <th style={thStyle}>Used</th>
              <th style={thStyle}>Status</th>
              <th style={thStyle}></th>
            </tr>
          </thead>
          <tbody>
            {codes.map(d => (
              <tr key={d.id} style={{ borderBottom: '1px solid var(--border-0)' }}>
                <td style={{ ...tdStyle, cursor: 'pointer' }} onClick={() => setEditing(d)}>
                  <strong style={{ fontFamily: 'var(--font-mono)' as const, color: 'var(--text-0)' }}>{d.code}</strong>
                  {d.description && (
                    <div style={{ fontSize: 11, color: 'var(--text-3)' }}>{d.description}</div>
                  )}
                </td>
                <td style={tdStyle}>{fmtValue(d)}</td>
                <td style={tdStyle}>
                  <span style={{ fontSize: 12, color: 'var(--text-2)' }}>
                    {d.startsAt || d.expiresAt ? `${fmtDate(d.startsAt)} → ${fmtDate(d.expiresAt)}` : 'Always'}
                  </span>
                </td>
                <td style={tdStyle}>
                  {d.redemptionCount}{d.maxRedemptions != null ? ` / ${d.maxRedemptions}` : ''}
                </td>
                <td style={tdStyle}>
                  <span style={{
                    padding: '3px 8px', fontSize: 11, fontWeight: 700,
                    textTransform: 'uppercase' as const, letterSpacing: 0.5, borderRadius: 4,
                    border: `1px solid ${d.isActive ? 'var(--green, #22c55e)' : 'var(--text-3)'}`,
                    color: d.isActive ? 'var(--green, #22c55e)' : 'var(--text-3)',
                  }}>{d.isActive ? 'Active' : 'Inactive'}</span>
                </td>
                <td style={{ ...tdStyle, textAlign: 'right' as const, whiteSpace: 'nowrap' as const }}>
                  <button onClick={() => toggleActive(d)} title={d.isActive ? 'Deactivate' : 'Activate'} style={iconBtn}>
                    <Power size={14} />
                  </button>
                  {d.redemptionCount === 0 && (
                    <button onClick={() => remove(d)} title="Delete" style={iconBtn}>
                      <Trash2 size={14} />
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {editing && (
        <DiscountModal
          existing={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); reload() }} />
      )}
    </div>
  )
}

function DiscountModal({
  existing, onClose, onSaved,
}: {
  existing: DiscountCode | null
  onClose: () => void
  onSaved: () => void
}) {
  const [code, setCode] = useState(existing?.code ?? '')
  const [description, setDescription] = useState(existing?.description ?? '')
  const [discountType, setDiscountType] = useState<'percent' | 'fixed'>(existing?.discountType ?? 'percent')
  const [discountValue, setDiscountValue] = useState(existing ? String(Number(existing.discountValue)) : '')
  const [isActive, setIsActive] = useState(existing?.isActive ?? true)
  const [startsAt, setStartsAt] = useState(isoToLocalDate(existing?.startsAt ?? null))
  const [expiresAt, setExpiresAt] = useState(isoToLocalDate(existing?.expiresAt ?? null))
  const [maxRedemptions, setMaxRedemptions] = useState(
    existing?.maxRedemptions != null ? String(existing.maxRedemptions) : '')
  const [submitting, setSubmitting] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const submit = async () => {
    setErr(null)
    const value = Number(discountValue)
    if (!discountValue || isNaN(value) || value < 0) { setErr('Enter a valid discount value'); return }
    if (discountType === 'percent' && value > 100) { setErr('Percent cannot exceed 100'); return }
    setSubmitting(true)
    try {
      const payload: any = {
        description: description.trim() || null,
        discountType,
        discountValue: value,
        isActive,
        startsAt: localDateToIso(startsAt),
        expiresAt: localDateToIso(expiresAt),
        maxRedemptions: maxRedemptions.trim() ? Number(maxRedemptions) : null,
      }
      if (existing) {
        await apiPatch(`/business-discounts/${existing.id}`, payload)
      } else {
        if (!code.trim()) { setErr('Code required'); setSubmitting(false); return }
        await apiPost('/business-discounts', { ...payload, code: code.trim() })
      }
      onSaved()
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Save failed')
    } finally { setSubmitting(false) }
  }

  return (
    <Modal title={existing ? `Edit ${existing.code}` : 'New discount code'} onClose={onClose}
      footer={
        <>
          <button onClick={onClose} style={ghostBtn}>Cancel</button>
          <button onClick={submit} disabled={submitting} style={primaryBtn}>
            {submitting ? 'Saving…' : existing ? 'Save changes' : 'Create code'}
          </button>
        </>
      }>
      {err && <div style={errStyle}>{err}</div>}

      {!existing && (
        <>
          <label style={labelStyle}>Code</label>
          <input value={code} onChange={e => setCode(e.target.value.toUpperCase())}
            placeholder="SUMMER20" style={{ ...inputStyle, fontFamily: 'var(--font-mono)' as const }} autoFocus />
        </>
      )}

      <label style={labelStyle}>Description (optional)</label>
      <input value={description} onChange={e => setDescription(e.target.value)}
        placeholder="Summer promo" style={inputStyle} />

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div>
          <label style={labelStyle}>Type</label>
          <select value={discountType} onChange={e => setDiscountType(e.target.value as any)} style={inputStyle}>
            <option value="percent">Percent (%)</option>
            <option value="fixed">Fixed ($)</option>
          </select>
        </div>
        <div>
          <label style={labelStyle}>{discountType === 'percent' ? 'Percent off' : 'Dollars off'}</label>
          <input type="number" step="0.01" min={0} value={discountValue}
            onChange={e => setDiscountValue(e.target.value)}
            placeholder={discountType === 'percent' ? '20' : '10.00'} style={inputStyle} />
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div>
          <label style={labelStyle}>Starts (optional)</label>
          <input type="date" value={startsAt} onChange={e => setStartsAt(e.target.value)} style={inputStyle} />
        </div>
        <div>
          <label style={labelStyle}>Expires (optional)</label>
          <input type="date" value={expiresAt} onChange={e => setExpiresAt(e.target.value)} style={inputStyle} />
        </div>
      </div>

      <label style={labelStyle}>Max redemptions (optional — blank = unlimited)</label>
      <input type="number" min={1} step={1} value={maxRedemptions}
        onChange={e => setMaxRedemptions(e.target.value)} placeholder="Unlimited" style={inputStyle} />

      <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 14, fontSize: 14, color: 'var(--text-1)', cursor: 'pointer' }}>
        <input type="checkbox" checked={isActive} onChange={e => setIsActive(e.target.checked)} />
        Active
      </label>
    </Modal>
  )
}

const tableStyle: React.CSSProperties = {
  width: '100%', borderCollapse: 'collapse' as const,
  background: 'var(--bg-1)', border: '1px solid var(--border-0)',
  borderRadius: 12, overflow: 'hidden' as const,
}
const thStyle: React.CSSProperties = {
  textAlign: 'left' as const, padding: '12px 16px', fontSize: 12,
  color: 'var(--text-2)', textTransform: 'uppercase' as const,
  letterSpacing: 1, background: 'var(--bg-2)', fontWeight: 600,
}
const tdStyle: React.CSSProperties = { padding: '12px 16px', fontSize: 14, color: 'var(--text-1)' }
const labelStyle: React.CSSProperties = {
  display: 'block' as const, fontSize: 12, color: 'var(--text-2)', marginBottom: 6, marginTop: 12,
}
const inputStyle: React.CSSProperties = {
  width: '100%', padding: '10px 12px', background: 'var(--bg-2)', color: 'var(--text-0)',
  border: '1px solid var(--border-1)', borderRadius: 8, fontSize: 14, boxSizing: 'border-box' as const,
}
const primaryBtn: React.CSSProperties = {
  padding: '8px 14px', background: 'var(--gold)', color: 'var(--bg-0)', border: 'none',
  borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer',
  display: 'inline-flex' as const, alignItems: 'center', gap: 6,
}
const ghostBtn: React.CSSProperties = {
  padding: '8px 14px', background: 'transparent', color: 'var(--text-1)',
  border: '1px solid var(--border-1)', borderRadius: 8, fontSize: 13, fontWeight: 500, cursor: 'pointer',
}
const iconBtn: React.CSSProperties = {
  padding: 6, background: 'transparent', color: 'var(--text-2)',
  border: '1px solid var(--border-1)', borderRadius: 6, cursor: 'pointer', marginLeft: 6,
}
const errStyle: React.CSSProperties = {
  marginBottom: 12, padding: '10px 12px', background: 'var(--red-bg)',
  color: 'var(--red, #ef4444)', border: '1px solid var(--red-dim, #ef4444)', borderRadius: 8, fontSize: 13,
}
const emptyStyle: React.CSSProperties = {
  padding: 40, textAlign: 'center' as const, background: 'var(--bg-1)',
  border: '1px solid var(--border-0)', borderRadius: 12, color: 'var(--text-2)', fontSize: 14,
}
