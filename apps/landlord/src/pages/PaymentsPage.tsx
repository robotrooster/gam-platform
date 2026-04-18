import { useState } from 'react'
import { useQuery } from 'react-query'
import { apiGet } from '../lib/api'
import { X, AlertTriangle, CheckCircle, Clock, XCircle } from 'lucide-react'

const fmt = (n: any) => n != null
  ? '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  : '—'

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

function PaymentDetailModal({ payment: p, onClose }: { payment: any; onClose: () => void }) {
  const StatusIcon = STATUS_ICONS[p.status] || Clock
  const statusColor = STATUS_COLORS[p.status] || 'var(--text-3)'

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
              {p.status}
            </div>
            <div style={{ fontSize: '.72rem', color: 'var(--text-3)' }}>
              {fmt(p.amount)} · {p.type?.replace('_', ' ')}
            </div>
          </div>
          {p.zero_tolerance_flag && (
            <span className="badge badge-red">Zero Tolerance</span>
          )}
        </div>

        {/* Scrollable body */}
        <div style={{ overflowY: 'auto', flex: 1 }}>

          {/* Basics */}
          <div style={{ fontSize: '.72rem', fontWeight: 700, color: 'var(--gold)', textTransform: 'uppercase', letterSpacing: '.08em', margin: '8px 0 4px 0' }}>
            Payment
          </div>
          {row('Amount', fmt(p.amount), { mono: true, color: 'var(--text-0)' })}
          {row('Type', p.type?.replace('_', ' '))}
          {row('Entry Description', p.entry_description, { mono: true })}
          {row('Due Date', p.due_date ? new Date(p.due_date).toLocaleDateString() : null, { mono: true })}
          {row('Processed', p.processed_at ? new Date(p.processed_at).toLocaleString() : null, { mono: true })}
          {row('Settled', p.settled_at ? new Date(p.settled_at).toLocaleString() : null, { mono: true })}
          {row('Retry Count', p.retry_count ?? 0, { mono: true })}

          {/* Unit & Tenant */}
          <div style={{ fontSize: '.72rem', fontWeight: 700, color: 'var(--gold)', textTransform: 'uppercase', letterSpacing: '.08em', margin: '16px 0 4px 0' }}>
            Unit
          </div>
          {row('Unit', p.unit_number, { mono: true })}
          {row('Property', p.property_name)}

          {/* Stripe & ACH refs */}
          <div style={{ fontSize: '.72rem', fontWeight: 700, color: 'var(--gold)', textTransform: 'uppercase', letterSpacing: '.08em', margin: '16px 0 4px 0' }}>
            Stripe & ACH
          </div>
          {row('Payment Intent ID', p.stripe_payment_intent_id, { mono: true })}
          {row('Charge ID', p.stripe_charge_id, { mono: true })}
          {row('ACH Trace Number', p.ach_trace_number, { mono: true })}

          {/* Returns (only if present) */}
          {(p.return_code || p.return_reason) && (
            <>
              <div style={{ fontSize: '.72rem', fontWeight: 700, color: 'var(--red)', textTransform: 'uppercase', letterSpacing: '.08em', margin: '16px 0 4px 0' }}>
                Return Details
              </div>
              {row('Return Code', p.return_code, { mono: true, color: 'var(--red)' })}
              {row('Return Reason', p.return_reason, { color: 'var(--red)' })}
              {p.zero_tolerance_flag && row('Zero Tolerance Flag', 'Yes', { color: 'var(--red)' })}
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
          {row('Created', p.created_at ? new Date(p.created_at).toLocaleString() : null, { mono: true })}
        </div>

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

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">Payments</h1>
          <p className="page-subtitle">Tenant ACH collections</p>
        </div>
      </div>

      <div className="card" style={{ padding: 0 }}>
        {isLoading ? (
          <div style={{ padding: 32, color: 'var(--text-3)', textAlign: 'center' }}>Loading…</div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Due</th>
                <th>Unit</th>
                <th>Type</th>
                <th>Amount</th>
                <th>Status</th>
                <th>Entry Desc</th>
                <th>Return</th>
              </tr>
            </thead>
            <tbody>
              {(payments as any[]).length ? (payments as any[]).map((p: any) => (
                <tr
                  key={p.id}
                  onClick={() => setSelected(p)}
                  style={{ cursor: 'pointer' }}
                >
                  <td className="mono">{p.due_date ? new Date(p.due_date).toLocaleDateString() : '—'}</td>
                  <td className="mono">{p.unit_number || '—'}</td>
                  <td><span className="badge badge-muted">{p.type}</span></td>
                  <td className="mono" style={{ color: 'var(--text-0)' }}>{fmt(p.amount)}</td>
                  <td><span className={'badge ' + (STATUS_MAP[p.status] || 'badge-muted')}>{p.status}</span></td>
                  <td className="mono" style={{ fontSize: '.72rem', color: 'var(--text-3)' }}>{p.entry_description}</td>
                  <td>
                    {p.return_code
                      ? <span className={'badge ' + (p.zero_tolerance_flag ? 'badge-red' : 'badge-amber')}>{p.return_code}</span>
                      : <span style={{ color: 'var(--text-3)' }}>—</span>}
                  </td>
                </tr>
              )) : (
                <tr>
                  <td colSpan={7} style={{ textAlign: 'center', color: 'var(--text-3)', padding: 32 }}>
                    No payments yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>

      {selected && <PaymentDetailModal payment={selected} onClose={() => setSelected(null)} />}
    </div>
  )
}
