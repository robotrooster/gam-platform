import { Fragment, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { humanize, MANUAL_PAYMENT_METHODS, MANUAL_PAYMENT_METHOD_LABELS,
         type ManualPaymentMethod,
         TENANT_CREDIT_CATEGORIES, TENANT_CREDIT_CATEGORY_LABEL } from '@gam/shared'
import { apiGet, apiPost } from '../lib/api'
import { usePerms } from '../lib/permissions'
import { SearchBox, PropertySelect } from '../components/ListControls'
import { X, AlertTriangle, CheckCircle, Clock, XCircle, Gift, ChevronRight, ChevronDown } from 'lucide-react'

const fmt = (n: any) => n != null
  ? '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  : '—'

// S637 (Nic): "you have Jonathan Covey for rent, Jonathan Covey for trash,
// Jonathan Covey for electricity, Jonathan Covey for water, Jonathan Covey for
// another trash can... They're only supposed to have one trash can."
//
// Those two $25 rows are two MONTHS of trash (Aug + Sep), not two cans — but
// the table showed `entry_description`, a wire-format literal that reads
// "UTILITY" for every one of them, so the only thing distinguishing them was
// the amount. Two identical amounts therefore read as a duplicate bill. The
// period was in `notes` the whole time and no column showed it.
//
// One description for a charge, everywhere it is listed: the note the biller
// wrote, else the humanised type. Never the wire literal.
function chargeLabel(p: any): string {
  const note = String(p.notes ?? '').trim()
  if (note) return note.split(' — work trade')[0]
  return humanize(p.type)
}

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

// ── TAKE A PAYMENT AT THE COUNTER (S637) ─────────────────────
//
// Nic: "manually recording a payment is for cash or check only. You have
// everything as different line items, which is fine for a breakdown of the
// bill, but it's showing processed, settled, retry count, payment ID, charge
// ID, ACH trace number, metadata — all that stuff is inapplicable to cash or
// check payments... In reality, the window shouldn't need to scroll. You have
// too much information on there. Nobody's going to manually record a payment
// for an ACH clearing."
//
// Recording cash used to open the Payment Detail modal — a forensic view of
// one processed transaction, with Stripe ids, ACH trace numbers, retry counts
// and metadata. None of that exists for money handed across a counter. It was
// also so tall it had to scroll, and the previous fix made it scrollable
// rather than asking why a cash drawer needed an ACH trace number.
//
// What somebody taking money actually needs: who is paying, what for, the
// total, how they are paying, and what change to hand back. Nothing else, and
// no scrolling.
function TakePaymentModal({ group, onClose, onRecorded }: {
  group: any
  onClose: () => void
  onRecorded: (msg: string) => void
}) {
  const [method, setMethod] = useState<ManualPaymentMethod>('cash')
  const [tendered, setTendered] = useState('')
  const [reference, setReference] = useState('')
  const [err, setErr] = useState<string | null>(null)

  const due = Number(group.total)
  const cash = method === 'cash'
  const paid = Number(tendered.replace(/[^\d.]/g, '')) || 0
  // Change is the arithmetic nobody should be doing in their head with a
  // queue at the desk. Only cash has it; a check is written for the amount.
  const change = cash && paid > due ? paid - due : 0
  const short = cash && tendered.trim() !== '' && paid < due

  // A check or money order is identified by its number — that number IS the
  // receipt if the payment is ever questioned, so it is required, not optional.
  const needsNumber = method === 'check' || method === 'money_order'
  const numberLabel = method === 'check' ? 'Check number' : 'Money order number'
  const ready = !short && (!needsNumber || reference.trim().length > 0)

  const mut = useMutation(
    () => apiPost(`/payments/${group.charges[0].id}/record-manual`,
      { method, reference: reference.trim() || undefined }),
    {
      onSuccess: () => onRecorded(
        `Recorded ${fmt(due)} from ${group.tenantFirst ?? ''} ${group.tenantLast ?? ''}`.trim()),
      onError: (e: any) => setErr(e?.response?.data?.error || 'Could not record that payment'),
    },
  )

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 420 }} onClick={e => e.stopPropagation()}>
        <div className="modal-title" style={{ marginBottom: 2 }}>
          {`${group.tenantFirst ?? ''} ${group.tenantLast ?? ''}`.trim() || 'Record payment'}
        </div>
        <div style={{ fontSize: '.76rem', color: 'var(--text-3)', marginBottom: 14 }}>
          {group.unitNumber ? `Unit ${group.unitNumber}` : ''}
          {group.propertyName ? ` · ${group.propertyName}` : ''}
        </div>

        {/* What they owe, itemised — the breakdown is the useful part. */}
        {/* Capped rather than left to grow: a household with a long tail of
            charges must not push the total and the buttons off the screen,
            which is the whole complaint this dialog exists to answer. Its own
            scroll, not the window's. */}
        <div style={{ background: 'var(--bg-2)', borderRadius: 10, padding: '10px 12px',
          marginBottom: 14, maxHeight: '32vh', overflowY: 'auto' }}>
          {group.charges.map((c: any) => (
            <div key={c.id} style={{ display: 'flex', justifyContent: 'space-between',
              fontSize: '.78rem', color: 'var(--text-2)', marginBottom: 4 }}>
              <span>{chargeLabel(c)}</span>
              <span className="mono">{fmt(c.amount)}</span>
            </div>
          ))}
          <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 800,
            color: 'var(--text-0)', borderTop: '1px solid var(--border-0)', paddingTop: 7, marginTop: 5 }}>
            <span>Total due</span><span className="mono">{fmt(due)}</span>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
          {MANUAL_PAYMENT_METHODS.map(m => (
            <button key={m} onClick={() => { setMethod(m); setReference(''); setTendered('') }}
              className={`btn btn-sm ${method === m ? 'btn-primary' : 'btn-ghost'}`}
              style={{ flex: 1 }}>{MANUAL_PAYMENT_METHOD_LABELS[m]}</button>
          ))}
        </div>

        {cash ? (
          <div style={{ marginBottom: 12 }}>
            <label style={{ fontSize: '.75rem', color: 'var(--text-3)' }}>Cash received</label>
            <input className="form-input" inputMode="decimal" placeholder={due.toFixed(2)}
              value={tendered} onChange={e => setTendered(e.target.value)}
              style={{ width: '100%', marginTop: 4 }} />
            {short && (
              <div style={{ fontSize: '.76rem', color: 'var(--red)', marginTop: 6 }}>
                {fmt(due - paid)} short — rent is paid in full or not at all.
              </div>
            )}
            {change > 0 && (
              <div style={{ fontSize: '.9rem', fontWeight: 800, color: 'var(--gold)', marginTop: 8 }}>
                Change to give back: {fmt(change)}
              </div>
            )}
          </div>
        ) : (
          <div style={{ marginBottom: 12 }}>
            <label style={{ fontSize: '.75rem', color: 'var(--text-3)' }}>{numberLabel}</label>
            <input className="form-input" value={reference} placeholder="e.g. 1042"
              onChange={e => setReference(e.target.value)} style={{ width: '100%', marginTop: 4 }} />
          </div>
        )}

        {err && <div className="alert alert-warning" style={{ fontSize: '.8rem', marginBottom: 10 }}>{err}</div>}

        <div style={{ fontSize: '.72rem', color: 'var(--text-3)', marginBottom: 12, lineHeight: 1.5 }}>
          Settles all {group.charges.length} charge{group.charges.length === 1 ? '' : 's'} in full.
          You already hold the funds, so GAM disburses nothing. No fee.
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-primary" style={{ flex: 1 }} disabled={!ready || mut.isLoading}
            onClick={() => mut.mutate()}>
            {mut.isLoading ? 'Recording…' : `Record ${fmt(due)}`}
          </button>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  )
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

        {/* Scrollable body.
            S637 (Nic): "it pops up a little window that is not scrollable...
            I can't scroll down to see anything else. I don't know how to
            actually zero out it when he brings cash in."
            `flex: 1` alone does not make a flex child scroll. Its default
            min-height is `auto`, which refuses to shrink below the content —
            so the child grew past the 90vh cap, overflow-y never engaged, and
            the charge list and the Record Payment button sat below the fold
            with no way to reach them. minHeight: 0 is what lets it shrink. */}
        <div style={{ overflowY: 'auto', flex: 1, minHeight: 0 }}>

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
                {/* S636 (Nic): say what the click actually does. The settle
                    clears the household's WHOLE balance, so a dialog that names
                    one charge would understate what is about to happen. */}
                <div style={{ fontSize: '.78rem', color: 'var(--text-2)', marginBottom: 10, lineHeight: 1.5 }}>
                  {(p as any)._groupTotal != null
                    ? <>This settles <strong>all {(p as any)._groupCount} outstanding charge
                        {(p as any)._groupCount === 1 ? '' : 's'}</strong> for this household —{' '}
                        <strong>{fmt((p as any)._groupTotal)}</strong> in full. Cash, checks and
                        money orders are free.</>
                    : <>This settles the household&rsquo;s whole outstanding balance, not just this
                        charge — the same as a card payment. Cash, checks and money orders are free.</>}
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
  // S637: taking money at the counter is its own dialog — see TakePaymentModal.
  // Payment Detail stays what it is: the forensic view of one processed
  // transaction, which is the wrong thing to hand somebody holding cash.
  const [taking, setTaking] = useState<any>(null)
  const [tookMsg, setTookMsg] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [propertyName, setPropertyName] = useState('')
  // S637: which household rows are expanded to show what makes up the balance.
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const toggleExpanded = (k: string) => setExpanded(prev => {
    const next = new Set(prev)
    next.has(k) ? next.delete(k) : next.add(k)
    return next
  })
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

  // S636 (Nic, DIRECTIVE): ONE ROW PER HOUSEHOLD FOR WHAT IS OWED.
  //
  // "It shows everybody's name duplicated for every single charge — Tyler
  // Rhoades four charges, Russ Fuller four charges... any of those are clickable
  // to record a payment on. They need to be consolidated where it's one item per
  // household as a bulk record payment, an all-or-nothing thing."
  //
  // Every outstanding charge was its own clickable row, so nine rows stood for
  // three people and a landlord taking cash picked a line to apply it to. Money
  // arrives against a BALANCE, and letting it be aimed at one line lets the
  // oldest debt be skipped — the thing every other payment path settles first.
  // The backend already settles the whole balance (services/manualPaymentSettle);
  // this is the screen catching up with it.
  //
  // Grouped by LEASE where there is one, else by tenant — the same scope the
  // settle uses, so what the row promises is exactly what the click does.
  // SETTLED history stays itemised: that is a record of individual events, and
  // collapsing it would hide what was actually paid and when.
  const OUTSTANDING = new Set(['pending', 'failed'])
  const outstandingGroups = (() => {
    const groups = new Map<string, any>()
    for (const p of filteredPayments) {
      if (!OUTSTANDING.has(p.status)) continue
      if (p.workTradeSuspendedAt) continue   // worked off, not owed
      const key = p.leaseId || `tenant:${p.tenantId}`
      const g = groups.get(key) ?? {
        key, unitNumber: p.unitNumber, propertyName: p.propertyName,
        tenantFirst: p.tenantFirst, tenantLast: p.tenantLast,
        charges: [] as any[], total: 0, earliestDue: p.dueDate,
      }
      g.charges.push(p)
      g.total += Number(p.amount || 0)
      if (p.dueDate && (!g.earliestDue || p.dueDate < g.earliestDue)) g.earliestDue = p.dueDate
      groups.set(key, g)
    }
    return [...groups.values()].sort((a, b) =>
      String(a.earliestDue ?? '').localeCompare(String(b.earliestDue ?? '')))
  })()

  // S637 (Nic): "you are showing the outstanding balances of tenants near the
  // top... But then down below, you're showing each line item as a separate
  // charge."
  //
  // S636 consolidated what is OWED into one row per household and then left the
  // full itemised table underneath untouched — so every charge that had just
  // been summed into a household row was listed again below it, individually.
  // The consolidation did not replace the duplication, it sat on top of it.
  //
  // The two tables answer different questions and must not overlap: the top one
  // is WHAT IS OWED (grouped, actionable, expandable to its line items); the
  // bottom is WHAT HAPPENED (itemised, historical, read-only). A charge belongs
  // to exactly one of them, and anything the grouping deliberately skipped
  // gets its own band rather than being dropped into whichever table is left.
  const groupedIds = new Set<string>(
    outstandingGroups.flatMap((g: any) => g.charges.map((c: any) => c.id)))

  // S637: a work-trade-suspended charge is neither. The grouping skips it
  // because it is NOT money owed (the hours cover it — see the covered_charges
  // set carried in from the invite), and it has not happened yet either, so
  // listing it as history would be a lie in the other direction. It gets said
  // out loud, in its own band, rather than being quietly filed under a heading
  // that misdescribes it.
  const workTradeCharges = filteredPayments.filter((p: any) =>
    !groupedIds.has(p.id) && p.workTradeSuspendedAt && OUTSTANDING.has(p.status))
  const workTradeIds = new Set<string>(workTradeCharges.map((p: any) => p.id))
  const historyPayments = filteredPayments.filter((p: any) =>
    !groupedIds.has(p.id) && !workTradeIds.has(p.id))
  const totalOutstanding = outstandingGroups.reduce((sum: number, g: any) => sum + g.total, 0)
  const totalWorkTrade = workTradeCharges.reduce((sum: number, p: any) => sum + Number(p.amount || 0), 0)

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

      {isLoading ? (
        <div className="card" style={{ padding: 32, color: 'var(--text-3)', textAlign: 'center' }}>Loading…</div>
      ) : (
        <>
        {/* ── WHAT IS OWED ────────────────────────────────────────────────
            S636/S637 (Nic): one line per household, and clicking Record
            payment settles the whole balance — the same all-or-nothing a card
            payment does. The chevron opens the charges that make the balance
            up, so the detail is one click away instead of a second table. */}
        {tookMsg && (
          <div className="alert" style={{ marginBottom: 12, fontSize: '.84rem',
            borderColor: 'var(--green)', color: 'var(--text-0)' }}>
            {tookMsg} — settled in full.
          </div>
        )}
        {outstandingGroups.length > 0 && (
          <div className="card" style={{ padding: 0, marginBottom: 18, overflowX: 'auto' }}>
            <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border-0)',
                          display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
              <span style={{ fontSize: '.82rem', fontWeight: 700, color: 'var(--text-1)' }}>
                Outstanding balances
              </span>
              <span style={{ fontSize: '.75rem', color: 'var(--text-3)' }}>
                {outstandingGroups.length} household{outstandingGroups.length === 1 ? '' : 's'} · recording a payment settles the whole balance
              </span>
              <span className="mono" style={{ marginLeft: 'auto', fontSize: '.9rem', fontWeight: 700 }}>
                {fmt(totalOutstanding)}
              </span>
            </div>
            <table className="data-table" style={{ minWidth: 760 }}>
              <thead>
                <tr>
                  <th style={{ width: 32 }}></th>
                  <th>Oldest due</th><th>Unit</th><th>Tenant</th>
                  <th>Charges</th><th>Balance</th><th></th>
                </tr>
              </thead>
              <tbody>
                {outstandingGroups.map((g: any) => {
                  const isOpen = expanded.has(g.key)
                  return (
                  <Fragment key={g.key}>
                  <tr onClick={() => toggleExpanded(g.key)} style={{ cursor: 'pointer' }}>
                    <td style={{ color: 'var(--text-3)' }}>
                      {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    </td>
                    <td className="mono" style={{ fontSize: '.78rem' }}>
                      {g.earliestDue ? new Date(g.earliestDue).toLocaleDateString() : '—'}
                    </td>
                    <td className="mono">{g.unitNumber || '—'}</td>
                    <td style={{ fontSize: '.8rem' }}>
                      {`${g.tenantFirst ?? ''} ${g.tenantLast ?? ''}`.trim() || '—'}
                      {/* Unit numbers repeat across parks — name the property. */}
                      {g.propertyName && (
                        <div style={{ fontSize: '.68rem', color: 'var(--text-3)' }}>{g.propertyName}</div>
                      )}
                    </td>
                    <td style={{ fontSize: '.75rem', color: 'var(--text-3)' }}>
                      {g.charges.length} charge{g.charges.length === 1 ? '' : 's'}
                    </td>
                    <td className="mono" style={{ fontWeight: 700 }}>{fmt(g.total)}</td>
                    <td style={{ textAlign: 'right' }}>
                      <button className="btn btn-primary btn-sm"
                        onClick={e => { e.stopPropagation(); setTaking(g) }}>
                        Record payment
                      </button>
                    </td>
                  </tr>
                  {isOpen && g.charges.map((c: any) => (
                    <tr key={c.id} style={{ background: 'var(--bg-3)' }}>
                      <td></td>
                      <td className="mono" style={{ fontSize: '.72rem', color: 'var(--text-3)' }}>
                        {c.dueDate ? new Date(c.dueDate).toLocaleDateString() : '—'}
                      </td>
                      <td colSpan={3} style={{ fontSize: '.76rem', color: 'var(--text-2)' }}>
                        {chargeLabel(c)}
                      </td>
                      <td className="mono" style={{ fontSize: '.78rem' }}>{fmt(c.amount)}</td>
                      <td></td>
                    </tr>
                  ))}
                  </Fragment>
                )})}
              </tbody>
            </table>
          </div>
        )}

        {/* ── COVERED BY WORK TRADE ───────────────────────────────────────
            Not owed, not paid. Shown so the landlord can see the hours are
            doing their job instead of wondering why a charge vanished. */}
        {workTradeCharges.length > 0 && (
          <div className="card" style={{ padding: 0, marginBottom: 18, overflowX: 'auto' }}>
            <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border-0)',
                          display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
              <span style={{ fontSize: '.82rem', fontWeight: 700, color: 'var(--text-1)' }}>
                Covered by work trade
              </span>
              <span style={{ fontSize: '.75rem', color: 'var(--text-3)' }}>
                suspended until month close — not owed by the tenant
              </span>
              <span className="mono" style={{ marginLeft: 'auto', fontSize: '.9rem', fontWeight: 700, color: 'var(--text-3)' }}>
                {fmt(totalWorkTrade)}
              </span>
            </div>
            <table className="data-table" style={{ minWidth: 720 }}>
              <thead>
                <tr><th>Due</th><th>Unit</th><th>Tenant</th><th>Description</th><th>Amount</th></tr>
              </thead>
              <tbody>
                {workTradeCharges.map((p: any) => (
                  <tr key={p.id} onClick={() => setSelected(p)} style={{ cursor: 'pointer' }}>
                    <td className="mono" style={{ fontSize: '.78rem' }}>
                      {p.dueDate ? new Date(p.dueDate).toLocaleDateString() : '—'}
                    </td>
                    <td className="mono">{p.unitNumber || '—'}</td>
                    <td style={{ fontSize: '.8rem' }}>
                      {`${p.tenantFirst ?? ''} ${p.tenantLast ?? ''}`.trim() || '—'}
                      {p.propertyName && (
                        <div style={{ fontSize: '.68rem', color: 'var(--text-3)' }}>{p.propertyName}</div>
                      )}
                    </td>
                    <td style={{ fontSize: '.74rem', color: 'var(--text-3)', maxWidth: 320 }}>{chargeLabel(p)}</td>
                    <td className="mono" style={{ color: 'var(--text-3)' }}>{fmt(p.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* ── WHAT HAPPENED ───────────────────────────────────────────────
            History only. Every charge summed into a household row above is
            excluded here (S637) — it is the same money, and listing it twice
            is what made this page unreadable. */}
        <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
          <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border-0)',
                        fontSize: '.82rem', fontWeight: 700, color: 'var(--text-1)' }}>
            Payment history
          </div>
          <table className="data-table" style={{ minWidth: 880 }}>
            <thead>
              <tr>
                <th>Due</th>
                <th>Unit</th>
                <th>Tenant</th>
                <th>Type</th>
                <th>Description</th>
                <th>Amount</th>
                <th>Status</th>
                <th>Return</th>
              </tr>
            </thead>
            <tbody>
              {historyPayments.length ? historyPayments.map((p: any) => {
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
                  {/* S637: the note the biller wrote — "Trash — 2026-08" — not
                      the `UTILITY` wire literal that made every utility row
                      look identical. */}
                  <td style={{ fontSize: '.74rem', color: 'var(--text-3)', maxWidth: 320 }}>{chargeLabel(p)}</td>
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
                  <td>
                    {p.returnCode
                      ? <span className={'badge ' + (p.zeroToleranceFlag ? 'badge-red' : 'badge-amber')}>{p.returnCode}</span>
                      : <span style={{ color: 'var(--text-3)' }}>—</span>}
                  </td>
                </tr>
              )}) : (
                <tr>
                  <td colSpan={8} style={{ textAlign: 'center', color: 'var(--text-3)', padding: 32 }}>
                    {(payments as any[]).length
                      ? ((outstandingGroups.length || workTradeCharges.length)
                          ? 'Nothing settled yet — every open charge is listed above.'
                          : 'No payments match your filters.')
                      : 'No payments yet.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        </>
      )}

      {selected && <PaymentDetailModal payment={selected} onClose={() => setSelected(null)}
        canRecord={can('take_payment')}
        onRecorded={() => queryClient.invalidateQueries('payments')} />}
      {taking && <TakePaymentModal group={taking} onClose={() => setTaking(null)}
        onRecorded={(msg) => { setTaking(null); setTookMsg(msg); queryClient.invalidateQueries('payments') }} />}
      {creditOpen && <IssueCreditModal onClose={() => setCreditOpen(false)}
        onDone={(msg) => { setCreditOpen(false); setCreditNotice(msg) }} />}
    </div>
  )
}
