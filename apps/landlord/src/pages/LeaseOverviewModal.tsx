// W-28 (S529): the read-only lease view. Replaces opening LeaseFormModal in
// disabled mode ("everything renders as grayed-out typeable fields — looks
// like a broken form"). Per lease-is-law this presents what the signed
// document says as INFORMATION — parties, term, rent, deposit, fees — with a
// link to the full lease PDF (the W-29 /view route). Editing happens only
// through the proper flows (renewal, bill-fee, termination), never here.
// The editable path (needs-review import confirm) still uses LeaseFormModal.
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { useNavigate } from 'react-router-dom'
import { FileText, X, Plus, Trash2 } from 'lucide-react'
import { humanize, RENT_COMPONENT_KINDS, RENT_COMPONENT_KIND_LABEL } from '@gam/shared'
import { apiGet, apiPut } from '../lib/api'

const fmtMoney = (n: any) =>
  n != null && n !== '' ? `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2 })}` : '—'
const fmtDay = (s: any) =>
  s ? new Date(String(s).slice(0, 10) + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : null

const LEASE_TYPE_LABEL: Record<string, string> = {
  fixed_term: 'Fixed term', month_to_month: 'Month-to-month', weekly: 'Weekly', nightly: 'Nightly', long_term: 'Long term',
}
const FEE_TIMING_LABEL: Record<string, string> = {
  move_in: 'due at move-in', monthly_ongoing: 'monthly', move_out: 'at move-out', other: 'as billed',
}
const feeLabel = (t: string) => humanize(t)
const ordinal = (n: number) => {
  const v = n % 100
  if (v >= 11 && v <= 13) return `${n}th`
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] || 'th'}`
}

// S568: itemize rent into named line items (space rent + trailer/home rent).
// The components must sum to the lease rent — this splits the SAME total for
// display + metrics (billing is unchanged). Handy for mobile-home / RV parks.
type RentComp = { kind: string; label: string; amount: string }
function RentBreakdownSection({ leaseId, rentAmount, components }: {
  leaseId: string; rentAmount: number; components: any[]
}) {
  const qc = useQueryClient()
  const [editing, setEditing] = useState(false)
  const [rows, setRows] = useState<RentComp[]>([])
  const [err, setErr] = useState<string | null>(null)

  const startEdit = () => {
    setRows(components.length
      ? components.map((c: any) => ({ kind: c.kind, label: c.label, amount: String(c.amount) }))
      : [{ kind: 'space', label: 'Space rent', amount: '' }, { kind: 'trailer', label: 'Trailer rent', amount: '' }])
    setErr(null); setEditing(true)
  }
  const total = rows.reduce((s, r) => s + (Number(r.amount) || 0), 0)

  const save = useMutation(
    () => apiPut(`/leases/${leaseId}/rent-components`, {
      components: rows.map(r => ({ kind: r.kind, label: r.label.trim(), amount: Number(r.amount) || 0 })),
    }),
    {
      onSuccess: () => { qc.invalidateQueries(['lease-overview', leaseId]); setEditing(false) },
      onError: (e: any) => setErr(e?.message || 'Could not save the split.'),
    })
  const clear = useMutation(
    () => apiPut(`/leases/${leaseId}/rent-components`, { components: [] }),
    { onSuccess: () => { qc.invalidateQueries(['lease-overview', leaseId]); setEditing(false) } })

  if (!editing) {
    return (
      <>
        {components.length > 0 && (
          <div style={{ marginTop: 4, paddingLeft: 2 }}>
            {components.map((c: any) => (
              <div key={c.id} style={{ fontSize: '.78rem', color: 'var(--text-2)' }}>
                • {c.label} — {fmtMoney(c.amount)}
                <span style={{ color: 'var(--text-3)' }}> ({RENT_COMPONENT_KIND_LABEL[c.kind as keyof typeof RENT_COMPONENT_KIND_LABEL] || c.kind})</span>
              </div>
            ))}
          </div>
        )}
        <button className="btn btn-ghost btn-sm" style={{ marginTop: 6, padding: '2px 8px', fontSize: '.72rem' }} onClick={startEdit}>
          {components.length ? 'Edit rent breakdown' : 'Split rent (space / trailer)'}
        </button>
      </>
    )
  }

  const sumOk = Math.abs(total - rentAmount) < 0.01
  return (
    <div style={{ marginTop: 8, padding: 12, background: 'var(--bg-2)', borderRadius: 10, border: '1px solid var(--border-0)' }}>
      <div style={{ fontSize: '.72rem', fontWeight: 700, color: 'var(--gold)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 8 }}>
        Rent breakdown — must total {fmtMoney(rentAmount)}
      </div>
      {rows.map((r, i) => (
        <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 6, alignItems: 'center' }}>
          <select className="form-input" style={{ width: 130, fontSize: '.78rem' }} value={r.kind}
            onChange={e => setRows(rows.map((x, j) => j === i ? { ...x, kind: e.target.value } : x))}>
            {RENT_COMPONENT_KINDS.map(k => <option key={k} value={k}>{RENT_COMPONENT_KIND_LABEL[k]}</option>)}
          </select>
          <input className="form-input" style={{ flex: 1, fontSize: '.78rem' }} placeholder="Label"
            value={r.label} onChange={e => setRows(rows.map((x, j) => j === i ? { ...x, label: e.target.value } : x))} />
          <input className="form-input" style={{ width: 90, fontSize: '.78rem' }} placeholder="0.00" inputMode="decimal"
            value={r.amount} onChange={e => setRows(rows.map((x, j) => j === i ? { ...x, amount: e.target.value } : x))} />
          <button className="btn btn-ghost btn-sm" style={{ padding: 4 }} onClick={() => setRows(rows.filter((_, j) => j !== i))}><Trash2 size={13} /></button>
        </div>
      ))}
      <button className="btn btn-ghost btn-sm" style={{ padding: '2px 8px', fontSize: '.72rem' }}
        onClick={() => setRows([...rows, { kind: 'other', label: '', amount: '' }])}>
        <Plus size={12} /> Add line
      </button>
      <div style={{ fontSize: '.74rem', marginTop: 8, color: sumOk ? 'var(--green)' : 'var(--amber)' }}>
        Total: {fmtMoney(total)} {sumOk ? '✓' : `(needs ${fmtMoney(rentAmount)})`}
      </div>
      {err && <div style={{ fontSize: '.72rem', color: 'var(--red)', marginTop: 6 }}>{err}</div>}
      <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
        <button className="btn btn-primary btn-sm" disabled={!sumOk || save.isLoading || rows.some(r => !r.label.trim())}
          onClick={() => save.mutate()}>{save.isLoading ? 'Saving…' : 'Save split'}</button>
        {components.length > 0 && (
          <button className="btn btn-ghost btn-sm" disabled={clear.isLoading} onClick={() => clear.mutate()}>Remove split</button>
        )}
        <button className="btn btn-ghost btn-sm" onClick={() => setEditing(false)}>Cancel</button>
      </div>
    </div>
  )
}

export function LeaseOverviewModal({ leaseId, onClose }: { leaseId: string; onClose: () => void }) {
  const navigate = useNavigate()
  const { data: lease, isLoading } = useQuery(['lease-overview', leaseId], () => apiGet<any>(`/leases/${leaseId}`))

  const tenants: any[] = lease?.tenants || []
  const fees: any[] = (lease?.fees || []).filter((f: any) => f.feeType !== 'security_deposit')

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 560, width: '95vw' }} onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title" style={{ marginBottom: 0 }}>
            Lease · {lease ? `${lease.unitNumber} — ${lease.propertyName}` : '…'}
          </span>
          <button className="btn btn-ghost btn-sm" onClick={onClose}><X size={14} /></button>
        </div>

        {isLoading || !lease ? (
          <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-3)' }}>Loading…</div>
        ) : (
          <div style={{ padding: '4px 24px 24px' }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '10px 16px', fontSize: '.86rem' }}>
              <div style={{ color: 'var(--text-3)' }}>Status</div>
              <div style={{ textTransform: 'capitalize' }}>{humanize(lease.status)}</div>

              <div style={{ color: 'var(--text-3)' }}>{tenants.length === 1 ? 'Tenant' : 'Tenants'}</div>
              <div>
                {tenants.length ? tenants.map((t: any) => (
                  <div key={t.id || t.tenantId}>
                    {`${t.firstName || ''} ${t.lastName || ''}`.trim() || '—'}
                    {t.email && <span style={{ color: 'var(--text-3)' }}> · {t.email}</span>}
                    {t.isPrimary && <span style={{ color: 'var(--gold)', fontSize: '.7rem', marginLeft: 6 }}>PRIMARY</span>}
                  </div>
                )) : '—'}
              </div>

              <div style={{ color: 'var(--text-3)' }}>Term</div>
              <div>
                {fmtDay(lease.startDate)} → {lease.endDate ? fmtDay(lease.endDate) : 'ongoing'}
                <span style={{ color: 'var(--text-3)' }}> · {LEASE_TYPE_LABEL[lease.leaseType] || humanize(lease.leaseType)}</span>
                {lease.autoRenew && <span style={{ color: 'var(--text-3)' }}> · auto-renews</span>}
              </div>

              <div style={{ color: 'var(--text-3)' }}>Rent</div>
              <div>
                <span style={{ color: 'var(--gold)', fontWeight: 600 }}>{fmtMoney(lease.rentAmount)}/mo</span>
                <span style={{ color: 'var(--text-3)' }}> · due on the {ordinal(lease.rentDueDay)}</span>
                <RentBreakdownSection leaseId={lease.id} rentAmount={Number(lease.rentAmount) || 0} components={lease.rentComponents || []} />
              </div>

              <div style={{ color: 'var(--text-3)' }}>Deposit</div>
              <div>{fmtMoney(lease.securityDeposit)}</div>

              {lease.lateFeeEnabled && (
                <>
                  <div style={{ color: 'var(--text-3)' }}>Late fee</div>
                  <div>
                    {lease.lateFeeInitialType === 'percent'
                      ? `${Number(lease.lateFeeInitialAmount)}% of rent`
                      : fmtMoney(lease.lateFeeInitialAmount)}
                    <span style={{ color: 'var(--text-3)' }}> after {lease.lateFeeGraceDays ?? 0} day grace</span>
                  </div>
                </>
              )}

              {fees.length > 0 && (
                <>
                  <div style={{ color: 'var(--text-3)' }}>Fees</div>
                  <div>
                    {fees.map((f: any) => (
                      <div key={f.id}>
                        {feeLabel(f.feeType)} — {fmtMoney(f.amount)}
                        <span style={{ color: 'var(--text-3)' }}> ({FEE_TIMING_LABEL[f.dueTiming] || f.dueTiming}{f.isRefundable ? ', refundable' : ''})</span>
                      </div>
                    ))}
                  </div>
                </>
              )}

              <div style={{ color: 'var(--text-3)' }}>Notice</div>
              <div>{lease.noticeDaysRequired} days required to end</div>
            </div>

            <div style={{ display: 'flex', gap: 8, marginTop: 20 }}>
              <button
                className="btn btn-primary btn-sm"
                onClick={() => navigate(`/view?src=${encodeURIComponent(`/leases/${lease.id}/pdf`)}&title=${encodeURIComponent(`Lease — ${lease.unitNumber || ''}`)}`)}
              >
                <FileText size={14} /> View Full Lease
              </button>
              <button className="btn btn-ghost btn-sm" style={{ marginLeft: 'auto' }} onClick={onClose}>Close</button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
