import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { humanize, MANUAL_PAYMENT_METHODS, MANUAL_PAYMENT_METHOD_LABELS,
         MANUAL_PAYMENT_FEE, type ManualPaymentMethod } from '@gam/shared'
import { apiGet, apiPost } from '../lib/api'
import { usePerms } from '../lib/permissions'
import { X, AlertTriangle, CheckCircle, Clock, XCircle } from 'lucide-react'

const fmt = (n: any) => n != null
  ? '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  : '—'

// S262: actual amount the landlord received (gross - amount retained
// by GAM for the tenant's outstanding balances). When supersedence
// happened, this is strictly less than payment.amount.
function netToBank(p: any): number {
  return Number(p.amount ?? 0) - Number(p.gamSupersedenceAmount ?? 0)
}
function isPartial(p: any): boolean {
  return Number(p.gamSupersedenceAmount ?? 0) > 0.005
}

const STATUS_MAP: Record<string, string> = {
  settled: 'badge-green',
  pending: 'badge-amber',
  failed: 'badge-red',
  returned: 'badge-red',
  processing: 'badge-blue',
}

const STATUS_ICONS: Record<string, any> = {
  settled: CheckCircle,
  pending: Clock,
  processing: Clock,
  failed: XCircle,
  returned: AlertTriangle,
}

const STATUS_COLORS: Record<string, string> = {
  settled: 'var(--green)',
  pending: 'var(--amber)',
  processing: 'var(--blue)',
  failed: 'var(--red)',
  returned: 'var(--red)',
}

function PaymentDetailModal({ payment: p, onClose, canRecord, onRecorded }: {
  payment: any; onClose: () => void; canRecord: boolean; onRecorded: () => void
}) {
  const StatusIcon = STATUS_ICONS[p.status] || Clock
  const statusColor = STATUS_COLORS[p.status] || 'var(--text-3)'

  // S562: record a rent charge paid off-platform (cash/check/money order). GAM
  // moves no money — the row just flips to settled. The tenant's first rent
  // payment is fee-free; subsequent ones bill a $10 manual-payment fee (the
  // server decides + returns feeWaived). Only open, unpaid RENT rows qualify.
  const isManualRecordable = canRecord && p.type === 'rent' &&
    (p.status === 'pending' || p.status === 'failed')
  const [recordOpen, setRecordOpen] = useState(false)
  const [method, setMethod] = useState<ManualPaymentMethod>('check')
  const [reference, setReference] = useState('')
  const [recordMsg, setRecordMsg] = useState<string | null>(null)
  const recordMut = useMutation(
    () => apiPost(`/payments/${p.id}/record-manual`, { method, reference: reference || undefined }),
    {
      onSuccess: (res: any) => {
        const waived = res?.data?.feeWaived
        setRecordMsg(waived
          ? 'Recorded. First rent payment — no manual-payment fee charged.'
          : `Recorded. A $${MANUAL_PAYMENT_FEE.toFixed(2)} manual-payment fee was billed to the tenant.`)
        onRecorded()
      },
    })

  const row = (label: string, value: any, opts?: { mono?: boolean; color?: string }) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 0', borderBottom: '1px solid var(--border-0)', fontSize: '.82rem' }}>
      <span style={{ color: 'var(--text-3)' }}>{label}</span>
      <span
        className={opts?.mono ? 'mono' : undefined}
        style={{ color: opts?.color || 'var(--text-0)', fontWeight: 500, textAlign: 'right', maxWidth: '60%', wordBreak: 'break-all' }}
      >
        {value != null && value !== '' ? value : '—'}
      </span>
    </div>
  )

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 580, width: '95vw', maxHeight: '90vh', display: 'flex', flexDirection: 'column' }} onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, flexShrink: 0 }}>
          <div>
            <div className="modal-title" style={{ marginBottom: 4 }}>Payment Detail</div>
            <div style={{ fontSize: '.78rem', color: 'var(--text-3)', fontFamily: 'var(--font-mono)' }}>
              {p.id}
            </div>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={onClose} style={{ padding: 6 }}><X size={15} /></button>
        </div>

        {/* Status header banner */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '12px 14px',
          background: 'var(--bg-2)',
          border: '1px solid var(--border-0)',
          borderLeft: '3px solid ' + statusColor,
          borderRadius: 10,
          marginBottom: 16,
          flexShrink: 0,
        }}>
          <StatusIcon size={20} style={{ color: statusColor, flexShrink: 0 }} />
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: '.92rem', fontWeight: 700, color: 'var(--text-0)', textTransform: 'capitalize' }}>
              {p.status}{isPartial(p) && <span style={{ color: 'var(--amber)', fontWeight: 700 }}> · partial</span>}
            </div>
            <div style={{ fontSize: '.72rem', color: 'var(--text-3)' }}>
              {isPartial(p) ? `${fmt(netToBank(p))} net to bank` : fmt(p.amount)} · {humanize(p.type)}
            </div>
          </div>
          {p.zeroToleranceFlag && (
            <span className="badge badge-red">Zero Tolerance</span>
          )}
        </div>

        {/* Scrollable body */}
        <div style={{ overflowY: 'auto', flex: 1 }}>

          {/* Basics */}
          <div style={{ fontSize: '.72rem', fontWeight: 700, color: 'var(--gold)', textTransform: 'uppercase', letterSpacing: '.08em', margin: '8px 0 4px 0' }}>
            Payment
          </div>
          {/* S262: partial-payment detail — show the gross + retained
              + net split when supersedence diverted any of this
              payment. Copy is generic ("retained for tenant balances")
              with no product disclosure. */}
          {isPartial(p) ? (
            <>
              {row('Collected from tenant', fmt(p.amount), { mono: true, color: 'var(--text-0)' })}
              {row('Retained for tenant balances', fmt(p.gamSupersedenceAmount), { mono: true, color: 'var(--amber)' })}
              {row('Net to your bank', fmt(netToBank(p)), { mono: true, color: 'var(--text-0)' })}
            </>
          ) : (
            row('Amount', fmt(p.amount), { mono: true, color: 'var(--text-0)' })
          )}
          {row('Type', humanize(p.type))}
          {row('Entry Description', p.entryDescription, { mono: true })}
          {row('Due Date', p.dueDate ? new Date(p.dueDate).toLocaleDateString() : null, { mono: true })}
          {row('Processed', p.processedAt ? new Date(p.processedAt).toLocaleString() : null, { mono: true })}
          {row('Settled', p.settledAt ? new Date(p.settledAt).toLocaleString() : null, { mono: true })}
          {row('Retry Count', p.retryCount ?? 0, { mono: true })}

          {/* Unit & Tenant */}
          <div style={{ fontSize: '.72rem', fontWeight: 700, color: 'var(--gold)', textTransform: 'uppercase', letterSpacing: '.08em', margin: '16px 0 4px 0' }}>
            Unit & Tenant
          </div>
          {row(p.status === 'failed' ? 'Attempted by' : 'Paid by',
            (p.tenantFirst || p.tenantLast) ? `${p.tenantFirst ?? ''} ${p.tenantLast ?? ''}`.trim() : null)}
          {row('Unit', p.unitNumber, { mono: true })}
          {row('Property', p.propertyName)}

          {/* Payment processor & ACH refs */}
          <div style={{ fontSize: '.72rem', fontWeight: 700, color: 'var(--gold)', textTransform: 'uppercase', letterSpacing: '.08em', margin: '16px 0 4px 0' }}>
            Payment & ACH
          </div>
          {row('Payment ID', p.stripePaymentIntentId, { mono: true })}
          {row('Charge ID', p.stripeChargeId, { mono: true })}
          {row('ACH Trace Number', p.achTraceNumber, { mono: true })}

          {/* Returns (only if present) */}
          {(p.returnCode || p.returnReason) && (
            <>
              <div style={{ fontSize: '.72rem', fontWeight: 700, color: 'var(--red)', textTransform: 'uppercase', letterSpacing: '.08em', margin: '16px 0 4px 0' }}>
                Return Details
              </div>
              {row('Return Code', p.returnCode, { mono: true, color: 'var(--red)' })}
              {row('Return Reason', p.returnReason, { color: 'var(--red)' })}
              {p.zeroToleranceFlag && row('Zero Tolerance Flag', 'Yes', { color: 'var(--red)' })}
            </>
          )}

          {/* Notes */}
          {p.notes && (
            <>
              <div style={{ fontSize: '.72rem', fontWeight: 700, color: 'var(--gold)', textTransform: 'uppercase', letterSpacing: '.08em', margin: '16px 0 4px 0' }}>
                Notes
              </div>
              <div style={{
                padding: '10px 12px',
                background: 'var(--bg-2)',
                border: '1px solid var(--border-0)',
                borderRadius: 8,
                fontSize: '.82rem',
                color: 'var(--text-1)',
                whiteSpace: 'pre-wrap',
                marginTop: 6,
              }}>
                {p.notes}
              </div>
            </>
          )}

          {/* Timestamps */}
          <div style={{ fontSize: '.72rem', fontWeight: 700, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.08em', margin: '16px 0 4px 0' }}>
            Metadata
          </div>
          {row('Created', p.createdAt ? new Date(p.createdAt).toLocaleString() : null, { mono: true })}
        </div>

        {/* S562: record a manual (off-platform) rent payment */}
        {isManualRecordable && (
          <div style={{ marginTop: 16, padding: '14px 0', borderTop: '1px solid var(--border-0)' }}>
            {recordMsg ? (
              <div style={{ fontSize: '.82rem', color: 'var(--green)', display: 'flex', alignItems: 'center', gap: 8 }}>
                <CheckCircle size={15} /> {recordMsg}
              </div>
            ) : !recordOpen ? (
              <button className="btn btn-ghost btn-sm" onClick={() => setRecordOpen(true)}>
                Record manual payment (cash / check / money order)
              </button>
            ) : (
              <div>
                <div style={{ fontSize: '.75rem', fontWeight: 700, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 8 }}>
                  Record off-platform payment
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                  <select className="form-input" style={{ width: 'auto' }} value={method}
                    onChange={e => setMethod(e.target.value as ManualPaymentMethod)}>
                    {MANUAL_PAYMENT_METHODS.map(m => (
                      <option key={m} value={m}>{MANUAL_PAYMENT_METHOD_LABELS[m]}</option>
                    ))}
                  </select>
                  <input className="form-input" style={{ width: 160 }} placeholder="Reference # (optional)"
                    value={reference} onChange={e => setReference(e.target.value)} />
                  <button className="btn btn-primary btn-sm" disabled={recordMut.isLoading}
                    onClick={() => recordMut.mutate()}>
                    {recordMut.isLoading ? 'Recording…' : 'Confirm'}
                  </button>
                  <button className="btn btn-ghost btn-sm" onClick={() => setRecordOpen(false)}>Cancel</button>
                </div>
                <div style={{ fontSize: '.72rem', color: 'var(--text-3)', marginTop: 8 }}>
                  Marks this rent as paid. GAM disburses nothing — you already hold the funds. The tenant's
                  first payment is fee-free; later manual payments bill a ${MANUAL_PAYMENT_FEE.toFixed(2)} fee to the tenant.
                </div>
                {recordMut.isError && (
                  <div style={{ fontSize: '.75rem', color: 'var(--red)', marginTop: 8 }}>
                    {(recordMut.error as any)?.message || 'Could not record the payment.'}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Footer */}
        <div className="modal-footer" style={{ marginTop: 16, flexShrink: 0 }}>
          <button className="btn btn-ghost" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  )
}

export function PaymentsPage() {
  const { data: payments = [], isLoading } = useQuery<any[]>('payments', () => apiGet('/payments'))
  const [selected, setSelected] = useState<any>(null)
  const navigate = useNavigate()
  const { can } = usePerms()
  const queryClient = useQueryClient()

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">Payments</h1>
          <p className="page-subtitle">Tenant ACH collections</p>
        </div>
        {can('payments.import_history') && (
          <button className="btn btn-ghost" onClick={() => navigate('/payment-history-onboarding')}>
            Import payment history
          </button>
        )}
      </div>

      <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
        {isLoading ? (
          <div style={{ padding: 32, color: 'var(--text-3)', textAlign: 'center' }}>Loading…</div>
        ) : (
          <table className="data-table" style={{ minWidth: 880 }}>
            <thead>
              <tr>
                <th>Due</th>
                <th>Unit</th>
                <th>Tenant</th>
                <th>Type</th>
                <th>Amount</th>
                <th>Status</th>
                <th>Entry Desc</th>
                <th>Return</th>
              </tr>
            </thead>
            <tbody>
              {(payments as any[]).length ? (payments as any[]).map((p: any) => {
                const partial = isPartial(p)
                const net = netToBank(p)
                return (
                <tr
                  key={p.id}
                  onClick={() => setSelected(p)}
                  style={{ cursor: 'pointer' }}
                >
                  <td className="mono">{p.dueDate ? new Date(p.dueDate).toLocaleDateString() : '—'}</td>
                  <td className="mono">{p.unitNumber || '—'}</td>
                  <td style={{ fontSize: '.8rem' }}>{(p.tenantFirst || p.tenantLast) ? `${p.tenantFirst ?? ''} ${p.tenantLast ?? ''}`.trim() : '—'}</td>
                  <td><span className="badge badge-muted">{humanize(p.type)}</span></td>
                  <td className="mono" style={{ color: 'var(--text-0)' }}>
                    {/* S262: when supersedence diverted part of the gross,
                        show the NET (what landed in the landlord's bank)
                        as the primary number, with the gross underneath
                        in muted text. No "paid in full" copy. */}
                    {partial ? (
                      <>
                        <div>{fmt(net)}</div>
                        <div style={{ fontSize: '.68rem', color: 'var(--text-3)', fontWeight: 400, marginTop: 2 }}>
                          of {fmt(p.amount)} collected
                        </div>
                      </>
                    ) : fmt(p.amount)}
                  </td>
                  <td>
                    <span className={'badge ' + (STATUS_MAP[p.status] || 'badge-muted')}>{humanize(p.status)}</span>
                    {partial && (
                      <span className="badge badge-amber" style={{ marginLeft: 6 }}>partial</span>
                    )}
                  </td>
                  <td className="mono" style={{ fontSize: '.72rem', color: 'var(--text-3)' }}>{p.entryDescription}</td>
                  <td>
                    {p.returnCode
                      ? <span className={'badge ' + (p.zeroToleranceFlag ? 'badge-red' : 'badge-amber')}>{p.returnCode}</span>
                      : <span style={{ color: 'var(--text-3)' }}>—</span>}
                  </td>
                </tr>
              )}) : (
                <tr>
                  <td colSpan={8} style={{ textAlign: 'center', color: 'var(--text-3)', padding: 32 }}>
                    No payments yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>

      {selected && <PaymentDetailModal payment={selected} onClose={() => setSelected(null)}
        canRecord={can('take_payment')}
        onRecorded={() => queryClient.invalidateQueries('payments')} />}
    </div>
  )
}
