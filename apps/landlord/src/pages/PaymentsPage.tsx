import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { humanize, MANUAL_PAYMENT_METHODS, MANUAL_PAYMENT_METHOD_LABELS,
         type ManualPaymentMethod,
         TENANT_CREDIT_CATEGORIES, TENANT_CREDIT_CATEGORY_LABEL } from '@gam/shared'
import { apiGet, apiPost } from '../lib/api'
import { usePerms } from '../lib/permissions'
import { SearchBox, PropertySelect } from '../components/ListControls'
import { X, AlertTriangle, CheckCircle, Clock, XCircle, Gift } from 'lucide-react'

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
  // payment is fee-free; subsequent ones bill a manual-payment fee (the
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
          : 'Recorded. No fee — cash, checks and money orders are free.')
        onRecorded()
      },
    })

  // S568: first-invoice-only, imported-lease-only "paid via prior arrangement"
  // during the onboarding-transition window. The server sets priorArrangementEligible.
  const priorArrMut = useMutation(
    () => apiPost(`/payments/${p.id}/record-prior-arrangement`, {}),
    {
      onSuccess: () => {
        setRecordMsg('Marked as paid off-platform via prior arrangement. No fee charged.')
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

        {/* S568: onboarding reconciliation window — during a landlord's move onto
            GAM a tenant may still be auto-debited by the OLD system. The first GAM
            invoice can be marked paid off-platform to avoid double-charging.
            Fee-free, first invoice only; the server gates it to the landlord's
            reconciliation window (new-vs-imported lease is irrelevant). */}
        {isManualRecordable && p.priorArrangementEligible && !recordMsg && (
          <div style={{ marginTop: 16, padding: '14px', borderTop: '1px solid var(--border-0)', background: 'rgba(201,162,39,.05)', borderRadius: 10 }}>
            <div style={{ fontSize: '.75rem', fontWeight: 700, color: 'var(--gold)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 6 }}>
              Onboarding reconciliation
            </div>
            <div style={{ fontSize: '.78rem', color: 'var(--text-2)', marginBottom: 10 }}>
              Was this first rent payment already collected through your old system
              (e.g. the tenant's autopay hadn't switched over yet)? Mark it paid so they
              aren't double-charged — it comes off the books, no fee. First invoice only,
              during your onboarding reconciliation window.
            </div>
            <button className="btn btn-primary btn-sm" disabled={priorArrMut.isLoading}
              onClick={() => priorArrMut.mutate()}>
              {priorArrMut.isLoading ? 'Marking…' : 'Already collected through my old system'}
            </button>
            {priorArrMut.isError && (
              <div style={{ fontSize: '.75rem', color: 'var(--red)', marginTop: 8 }}>
                {(priorArrMut.error as any)?.message || 'Could not mark the payment.'}
              </div>
            )}
          </div>
        )}

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
                  free for the tenant — cash, checks and money orders carry no fee.
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

// S577: landlord issues a credit to a tenant (screening cap, late-fee refund,
// overcharge, goodwill). Applied to the tenant's next rent invoice; funded by
// the landlord (they receive less rent). Independent of work-trade.
function IssueCreditModal({ onClose, onDone }: { onClose: () => void; onDone: (msg: string) => void }) {
  const { data: leases = [] } = useQuery<any[]>('leases', () => apiGet('/leases'))
  const activeLeases = (leases as any[]).filter((l: any) => l.status === 'active')
  const [leaseId, setLeaseId] = useState('')
  const [amount, setAmount] = useState('')
  const [category, setCategory] = useState<string>('goodwill')
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const mut = useMutation(
    () => apiPost('/tenant-credits', { leaseId, amount: Number(amount), category, reason: reason || null }),
    { onSuccess: () => onDone(`Credit of $${Number(amount).toFixed(2)} issued — it will apply to the tenant's next rent.`),
      onError: (e: any) => setError(e?.response?.data?.error || 'Could not issue the credit') })
  const valid = leaseId && amount !== '' && Number(amount) > 0
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.6)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: 24, zIndex: 100, overflowY: 'auto' }} onClick={onClose}>
      <div className="card" style={{ width: '100%', maxWidth: 460, padding: 20 }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
          <h2 style={{ fontSize: '1.05rem', fontWeight: 700, margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}><Gift size={17} style={{ color: 'var(--gold)' }} /> Issue Credit</h2>
          <button className="btn btn-ghost btn-sm" onClick={onClose}><X size={16} /></button>
        </div>
        <p style={{ fontSize: '.78rem', color: 'var(--text-3)', marginBottom: 14, lineHeight: 1.5 }}>
          The credit applies to the tenant's next rent invoice — you receive that much less rent. Use it for a
          refund, an overcharge correction, a capped-state screening difference, or goodwill.
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div>
            <span style={{ fontSize: '.72rem', color: 'var(--text-3)', display: 'block', marginBottom: 4 }}>Lease / tenant</span>
            <select className="form-select" value={leaseId} onChange={e => setLeaseId(e.target.value)} style={{ width: '100%' }}>
              <option value="" disabled>Select a lease…</option>
              {activeLeases.map((l: any) => (
                <option key={l.id} value={l.id}>{(l.unitNumber || 'Unit')} · {(l.propertyName || '')}</option>
              ))}
            </select>
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <div style={{ flex: 1 }}>
              <span style={{ fontSize: '.72rem', color: 'var(--text-3)', display: 'block', marginBottom: 4 }}>Amount ($)</span>
              <input className="form-input mono" type="text" inputMode="decimal" value={amount}
                onChange={e => { const v = e.target.value; if (v === '' || /^\d*\.?\d*$/.test(v)) setAmount(v) }}
                placeholder="0.00" style={{ width: '100%' }} />
            </div>
            <div style={{ flex: 1 }}>
              <span style={{ fontSize: '.72rem', color: 'var(--text-3)', display: 'block', marginBottom: 4 }}>Reason</span>
              <select className="form-select" value={category} onChange={e => setCategory(e.target.value)} style={{ width: '100%' }}>
                {TENANT_CREDIT_CATEGORIES.map(c => <option key={c} value={c}>{TENANT_CREDIT_CATEGORY_LABEL[c]}</option>)}
              </select>
            </div>
          </div>
          <div>
            <span style={{ fontSize: '.72rem', color: 'var(--text-3)', display: 'block', marginBottom: 4 }}>Note (optional)</span>
            <input className="form-input" value={reason} onChange={e => setReason(e.target.value)} placeholder="e.g. refunded May late fee" style={{ width: '100%' }} />
          </div>
          {error && <div style={{ color: 'var(--red, #dc2626)', fontSize: '.8rem' }}>{error}</div>}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
            <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
            <button className="btn btn-primary" disabled={!valid || mut.isLoading} onClick={() => { setError(null); mut.mutate() }}>
              {mut.isLoading ? 'Issuing…' : 'Issue Credit'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

export function PaymentsPage() {
  const { data: payments = [], isLoading } = useQuery<any[]>('payments', () => apiGet('/payments'))
  const [selected, setSelected] = useState<any>(null)
  const [search, setSearch] = useState('')
  const [propertyName, setPropertyName] = useState('')
  const [creditOpen, setCreditOpen] = useState(false)
  const [creditNotice, setCreditNotice] = useState<string | null>(null)
  const navigate = useNavigate()
  const { can } = usePerms()
  const queryClient = useQueryClient()

  // S576: the /payments payload carries propertyName (not propertyId), so the
  // dropdown keys on name — unique within a landlord's portfolio. Search spans
  // tenant, unit, and property so "type a tenant name → their transactions".
  const propertyOptions = (payments as any[]).map(p => ({ id: p.propertyName, name: p.propertyName }))
  const q = search.trim().toLowerCase()
  const filteredPayments = (payments as any[]).filter((p: any) => {
    const matchProperty = propertyName === '' || p.propertyName === propertyName
    if (!matchProperty) return false
    if (q === '') return true
    const tenant = `${p.tenantFirst ?? ''} ${p.tenantLast ?? ''}`.toLowerCase()
    return tenant.includes(q)
      || (p.unitNumber || '').toLowerCase().includes(q)
      || (p.propertyName || '').toLowerCase().includes(q)
  })

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">Payments</h1>
          <p className="page-subtitle">Tenant ACH collections</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-primary" onClick={() => setCreditOpen(true)}>
            <Gift size={15} /> Issue Credit
          </button>
          {can('payments.import_history') && (
            <button className="btn btn-ghost" onClick={() => navigate('/payment-history-onboarding')}>
              Import payment history
            </button>
          )}
        </div>
      </div>

      {creditNotice && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'rgba(22,163,74,.1)', border: '1px solid #16a34a', borderRadius: 8, padding: '8px 12px', fontSize: '.8rem', marginBottom: 14 }}>
          <CheckCircle size={15} style={{ color: '#16a34a' }} /> {creditNotice}
          <button className="btn btn-ghost btn-sm" style={{ marginLeft: 'auto' }} onClick={() => setCreditNotice(null)}><X size={13} /></button>
        </div>
      )}

      <div className="filter-bar">
        <SearchBox value={search} onChange={setSearch} placeholder="Search tenant, unit, property…" />
        <PropertySelect value={propertyName} onChange={setPropertyName} properties={propertyOptions} />
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
              {filteredPayments.length ? filteredPayments.map((p: any) => {
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
                    {(payments as any[]).length ? 'No payments match your filters.' : 'No payments yet.'}
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
      {creditOpen && <IssueCreditModal onClose={() => setCreditOpen(false)}
        onDone={(msg) => { setCreditOpen(false); setCreditNotice(msg) }} />}
    </div>
  )
}
