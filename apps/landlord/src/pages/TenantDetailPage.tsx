import { useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useMutation } from 'react-query'
import { humanize, PAYMENT_STATUS_LABEL, type PaymentStatus } from '@gam/shared'
import { apiGet, apiPost, apiPatch } from '../lib/api'
import { ArrowLeft, Plus } from 'lucide-react'
import { toast, appConfirm } from '../components/dialogs'
import { usePerms } from '../lib/permissions'
import { PostPaymentForm } from '../components/RecordPaymentWindow'
import {
  money, tenantCreditHeadline, tenantCreditLines, toCents, localToday, dayWord, monthTitle, calendarDay, chargeTimeliness,
  CREDIT_USE_RULE, type TenantCredit,
} from '../lib/creditDesk'
import '../styles/credit-desk.css'

/**
 * A charge's status color, one per status. Amber is owed (not paid yet, being
 * paid); a voided charge is owed by nobody (decisions #48.5), so it is muted —
 * never the amber an unpaid bill wears.
 */
const PAYMENT_STATUS_BADGE: Record<PaymentStatus, string> = {
  pending: 'badge-amber',
  processing: 'badge-amber',
  settled: 'badge-green',
  paid_via_deposit: 'badge-green',
  failed: 'badge-red',
  returned: 'badge-red',
  voided: 'badge-muted',
}
const fmt = (n: any) => n != null ? `$${Number(n).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2})}` : '—'

// S252: legacy per-tenant FlexChargePanel removed. The new schema
// scopes FlexCharge accounts per (customer, property); a tenant can
// hold separate tabs at different properties, so a tenant-detail
// view isn't the right surface anymore. Dedicated landlord
// FlexCharge dashboard lands in S254.

export function TenantDetailPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [showPaymentDetail, setShowPaymentDetail] = useState(false)
  // S252: per-tenant FlexCharge query removed alongside the legacy
  // panel. New flex_charge_accounts schema is (customer, property)
  // keyed; consult the FlexCharge dashboard (S254) for per-property
  // account management.
  const { data, isLoading, error, refetch, isFetching } = useQuery(['tenant-profile', id], () => apiGet<any>(`/tenants/${id}/profile`), {
    // A refusal or a missing person will not change on a retry: say it once.
    retry: (count: number, e: any) => {
      const status = e?.response?.status
      return !(status >= 400 && status < 500) && count < 2
    },
  })
  if (isLoading) return <div style={{ color: 'var(--text-3)', padding: 32 }}>Loading...</div>
  if (!data) {
    // S655: say why in plain words, with the way out — a staff member assigned
    // to particular properties cannot open someone who never lived there.
    const status = (error as any)?.response?.status
    const reason: string | undefined = (error as any)?.response?.data?.error
    const title = status === 403 ? "You can't open this resident"
      : status === 404 || !error ? 'Tenant not found'
      : "This resident's page didn't load"
    return (
      <div className="empty-state">
        <h3>{title}</h3>
        {status === 403 && reason && <p>{reason}</p>}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginTop: 12 }}>
          {error && status !== 403 && status !== 404 && (
            <button className="btn btn-primary btn-sm" disabled={isFetching} onClick={() => refetch()}>
              {isFetching ? 'Trying again…' : 'Try again'}
            </button>
          )}
          <button className="btn btn-ghost btn-sm" onClick={() => navigate('/tenants')}>Back to tenants</button>
        </div>
      </div>
    )
  }
  const { tenant, units, payments, maintenance, stats } = data
  // S641: staff without the payment permissions get no payment history or
  // money figures from the server; the payment cards are left out for them.
  const paymentsHidden = !!data.paymentsHidden
  const currentUnit = units?.find((u: any) => u.isCurrent)
  const onTimeColor = stats.onTimeRate >= 90 ? 'var(--green)' : stats.onTimeRate >= 75 ? 'var(--amber)' : 'var(--red)'
  const onTimeLabel = stats.onTimeRate >= 90 ? 'Excellent' : stats.onTimeRate >= 75 ? 'Good' : 'Needs Attention'
  return (
    <div>
      <div className="page-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button className="btn btn-ghost btn-sm" onClick={() => navigate('/tenants')}><ArrowLeft size={15} /></button>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <div style={{ width: 48, height: 48, borderRadius: '50%', background: 'linear-gradient(135deg, var(--gold-dark), var(--gold))', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'var(--font-display)', fontSize: '1rem', fontWeight: 800, color: 'var(--bg-0)', flexShrink: 0 }}>
              {tenant.firstName?.[0]}{tenant.lastName?.[0]}
            </div>
            <div>
              <h1 className="page-title" style={{ marginBottom: 2 }}>{tenant.firstName} {tenant.lastName}</h1>
              <p className="page-subtitle">
                {currentUnit ? `Unit ${currentUnit.unitNumber} - ${currentUnit.propertyName}` : 'No current unit'}
                {/* S655 (Nic, 10/2): no SSI/SSDI badge. "That's our check for
                    the flex products" — GAM-side only; the server no longer
                    sends the flag to a landlord. */}
              </p>
            </div>
          </div>
        </div>
      </div>

      {(
        <div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5,1fr)', gap: 12, marginBottom: 24 }}>
            {/* Figures cover this person's time with YOUR company only — another
                company's history is never shown here. */}
            {(paymentsHidden ? [
              { label: 'Units With You', val: stats.unitsOccupied, color: 'var(--text-0)' },
            ] : [
              // Their first bill's due date, read as a calendar month (never shifted a day by time zone).
              { label: 'Tenant Since', val: calendarDay(stats.firstPayment) ? monthTitle(calendarDay(stats.firstPayment)!) : '--', color: 'var(--text-0)' },
              { label: 'Months With You', val: stats.tenantMonths + ' mo', color: 'var(--text-0)' },
              { label: 'Total Paid', val: fmt(stats.totalPaid), color: 'var(--gold)' },
              { label: 'On-Time Rate', val: stats.onTimeRate + '%', color: onTimeColor, sub: onTimeLabel },
              { label: 'Units With You', val: stats.unitsOccupied, color: 'var(--text-0)' },
            ]).map(s => (
              <div key={s.label} className="card" style={{ padding: '14px 16px' }}>
                <div style={{ fontSize: '.65rem', fontWeight: 700, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.08em', marginBottom: 6 }}>{s.label}</div>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: '1rem', fontWeight: 700, color: s.color }}>{s.val}</div>
                {(s as any).sub && <div style={{ fontSize: '.65rem', color: s.color, marginTop: 2 }}>{(s as any).sub}</div>}
              </div>
            ))}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
            <div className="card">
              <div className="card-title" style={{ marginBottom: 14 }}>Contact</div>
              {[
                { label: 'Email', val: tenant.email },
                { label: 'Phone', val: tenant.phone || '--' },
                { label: 'ACH Verified', val: tenant.achVerified ? 'Verified' : 'Pending', color: tenant.achVerified ? 'var(--green)' : 'var(--amber)' },
                { label: 'Member Since', val: new Date(tenant.accountCreated).toLocaleDateString() },
              ].map(row => (
                <div key={row.label} className="data-row">
                  <span className="data-key">{row.label}</span>
                  <span className="data-val" style={{ color: (row as any).color }}>{row.val}</span>
                </div>
              ))}
            </div>
            {/* W-25 (S531): the health card drills into per-payment lateness —
                aggregate health hides whether "late" meant 2 days or 3 weeks. */}
            {!paymentsHidden && (
            <div className="card" style={{ cursor: 'pointer' }} onClick={() => setShowPaymentDetail(true)} title="See how late each payment actually was">
              <div className="card-title" style={{ marginBottom: 14, display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                <span>Payment Health</span>
                <span style={{ fontSize: '.68rem', color: 'var(--gold)', fontWeight: 600 }}>View detail →</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 16 }}>
                <div style={{ width: 56, height: 56, borderRadius: '50%', background: onTimeColor + '18', border: '3px solid ' + onTimeColor, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: '.9rem', fontWeight: 800, color: onTimeColor }}>{stats.onTimeRate}%</span>
                </div>
                <div>
                  <div style={{ fontSize: '.85rem', fontWeight: 700, color: onTimeColor }}>{onTimeLabel}</div>
                  <div style={{ fontSize: '.72rem', color: 'var(--text-3)', marginTop: 2 }}>On-time payment rate</div>
                </div>
              </div>
              {[
                { label: 'Settled', val: stats.settledCount },
                { label: 'Late', val: stats.lateCount },
                { label: 'Failed', val: stats.failedCount },
                { label: 'Avg Payment', val: fmt(stats.avgPayment) },
              ].map(row => (
                <div key={row.label} className="data-row">
                  <span className="data-key">{row.label}</span>
                  <span className="data-val mono">{row.val}</span>
                </div>
              ))}
            </div>
            )}
          </div>

          <div className="card" style={{ marginBottom: 16 }}>
            <div className="card-title" style={{ marginBottom: 14 }}>Unit History</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {units?.length === 0 && <div style={{ color: 'var(--text-3)', fontSize: '.82rem' }}>No unit history.</div>}
              {units?.map((u: any) => (
                <div key={u.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px', borderRadius: 10, background: 'var(--bg-2)', border: '1px solid ' + (u.isCurrent ? 'rgba(201,162,39,.3)' : 'var(--border-0)') }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: '.85rem', fontWeight: 600, color: 'var(--text-0)' }}>Unit {u.unitNumber}</span>
                      {u.isCurrent && <span className="badge badge-green">Current</span>}
                    </div>
                    <div style={{ fontSize: '.72rem', color: 'var(--text-3)', marginTop: 1 }}>{u.propertyName} - {u.street1}, {u.city}</div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontFamily: 'var(--font-mono)', fontSize: '.82rem', color: 'var(--gold)', fontWeight: 600 }}>{fmt(u.rentAmount)}/mo</div>
                    {u.startDate && <div style={{ fontSize: '.65rem', color: 'var(--text-3)', marginTop: 1 }}>{dayWord(u.startDate, '')} - {u.endDate ? dayWord(u.endDate, '') : 'Present'}</div>}
                  </div>
                  <button className="btn btn-ghost btn-sm" onClick={() => navigate('/units/' + u.id)}>View</button>
                </div>
              ))}
            </div>
          </div>

          <PhotosAndNoticesCard tenantId={id!} />

          <CreditCard credit={data.credit ?? null} />
          <PostPaymentCard tenantId={id!} hasUnit={!!currentUnit} name={`${tenant.firstName ?? ''} ${tenant.lastName ?? ''}`.trim() || 'this tenant'} />
          <OneOffChargesCard tenantId={id!} hasUnit={!!currentUnit} />

          {!paymentsHidden && (
          <div className="card" style={{ marginBottom: 16 }}>
            <div className="card-title" style={{ marginBottom: 14 }}>Payment History</div>
            {payments?.length === 0 ? (
              <div style={{ color: 'var(--text-3)', fontSize: '.82rem' }}>No payments yet.</div>
            ) : (
              <table className="data-table">
                <thead><tr><th>Date</th><th>Property</th><th>Unit</th><th>Amount</th><th>Status</th></tr></thead>
                <tbody>
                  {payments?.map((p: any) => (
                    <tr key={p.id}>
                      <td className="mono" style={{ fontSize: '.72rem' }}>{dayWord(p.dueDate, '')}</td>
                      <td style={{ fontSize: '.78rem' }}>{p.propertyName}</td>
                      <td className="mono">{p.unitNumber}</td>
                      <td className="mono">{fmt(p.amount)}</td>
                      <td><span className={`badge ${PAYMENT_STATUS_BADGE[p.status as PaymentStatus] ?? 'badge-muted'}`}>{PAYMENT_STATUS_LABEL[p.status as PaymentStatus] ?? humanize(p.status)}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          )}

          <div className="card">
            <div className="card-title" style={{ marginBottom: 14 }}>Maintenance History</div>
            {maintenance?.length === 0 ? (
              <div style={{ color: 'var(--text-3)', fontSize: '.82rem' }}>No maintenance requests.</div>
            ) : (
              <table className="data-table">
                <thead><tr><th>Date</th><th>Unit</th><th>Issue</th><th>Priority</th><th>Status</th><th>Cost</th></tr></thead>
                <tbody>
                  {maintenance?.map((m: any) => (
                    <tr key={m.id}>
                      <td className="mono" style={{ fontSize: '.72rem' }}>{new Date(m.createdAt).toLocaleDateString()}</td>
                      <td className="mono">{m.unitNumber}</td>
                      <td style={{ fontSize: '.78rem' }}>{m.title}</td>
                      <td><span className={`badge ${m.priority === 'emergency' ? 'badge-red' : m.priority === 'high' ? 'badge-amber' : 'badge-blue'}`}>{humanize(m.priority)}</span></td>
                      <td><span className={`badge ${m.status === 'completed' ? 'badge-green' : 'badge-amber'}`}>{humanize(m.status)}</span></td>
                      <td className="mono">{m.actualCost ? fmt(m.actualCost) : '--'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {showPaymentDetail && (
        <PaymentTimelinessModal payments={payments || []} tenantName={`${tenant.firstName} ${tenant.lastName}`} onClose={() => setShowPaymentDetail(false)} />
      )}
    </div>
  )
}

// W-25 (S531): per-payment timeliness drill-in. Days late = settled_at vs
// due_date (day-sliced per the date-serialization rule); unpaid past-due rows
// show days overdue against today.
function PaymentTimelinessModal({ payments, tenantName, onClose }: { payments: any[]; tenantName: string; onClose: () => void }) {
  // The day it settled is read on this device's calendar (a payment at 6 pm in
  // Phoenix is already "tomorrow" in UTC), the due day as the calendar day it
  // is; a payment still clearing, or paid from the deposit, is never "overdue",
  // and every status is said in words (lib/creditDesk chargeTimeliness).
  const TONE_BADGE = { good: 'badge-green', warn: 'badge-amber', bad: 'badge-red', info: 'badge-blue', muted: 'badge-muted' } as const
  const rows = payments.map((p: any) => {
    const t = chargeTimeliness(p)
    return { ...p, due: t.due, settled: t.settled, late: t.late, label: t.label, cls: TONE_BADGE[t.tone] }
  })
  const settledRows = rows.filter(r => r.status === 'settled' && r.due && r.settled)
  const onTime = settledRows.filter(r => r.late === 0).length
  const worst = settledRows.reduce((m, r) => Math.max(m, r.late), 0)
  const avgLate = (() => {
    const lateOnes = settledRows.filter(r => r.late > 0)
    if (!lateOnes.length) return 0
    return Math.round(lateOnes.reduce((s2, r) => s2 + r.late, 0) / lateOnes.length)
  })()

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 640 }} onClick={e => e.stopPropagation()}>
        <div className="modal-title">Payment Timeliness — {tenantName}</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 10, marginBottom: 14 }}>
          {[
            { label: 'Paid on time', val: `${onTime} of ${settledRows.length}`, color: 'var(--green)' },
            { label: 'Avg days late (when late)', val: avgLate ? `${avgLate}d` : '—', color: avgLate > 7 ? 'var(--red)' : 'var(--amber)' },
            { label: 'Worst', val: worst ? `${worst}d late` : '—', color: worst > 7 ? 'var(--red)' : worst ? 'var(--amber)' : 'var(--text-3)' },
          ].map(k => (
            <div key={k.label} style={{ background: 'var(--bg-3)', borderRadius: 10, padding: '10px 12px' }}>
              <div style={{ fontSize: '.62rem', fontWeight: 700, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 4 }}>{k.label}</div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: '.95rem', fontWeight: 700, color: k.color }}>{k.val}</div>
            </div>
          ))}
        </div>
        <div style={{ maxHeight: 380, overflowY: 'auto' }}>
          <table className="data-table">
            <thead><tr><th>Due</th><th>Paid</th><th>Amount</th><th>Type</th><th>Timeliness</th></tr></thead>
            <tbody>
              {rows.map((r: any) => (
                <tr key={r.id}>
                  <td className="mono" style={{ fontSize: '.72rem' }}>{r.due ? dayWord(r.due, '') : '—'}</td>
                  <td className="mono" style={{ fontSize: '.72rem' }}>{r.settled ? dayWord(r.settled, '') : '—'}</td>
                  <td className="mono">{r.amount != null ? `$${Number(r.amount).toLocaleString('en-US', { minimumFractionDigits: 2 })}` : '—'}</td>
                  <td style={{ fontSize: '.72rem', textTransform: 'uppercase', color: 'var(--text-3)' }}>{humanize(r.type)}</td>
                  <td><span className={`badge ${r.cls}`}>{r.label}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  )
}

/**
 * S616 (Nic) — charging for something that happened.
 *
 * "You are saying a landlord charging a parking violation would get the charge
 *  ignored?"
 *
 * It would not have been ignored — there was nowhere to enter it. Every charge
 * on the platform came from a system flow or from the lease document itself, so
 * a fire-lane violation, a broken window or a replaced key had no door at all.
 *
 * This is the door. The charge rides the tenant's next invoice as an ordinary
 * line with the reason and the date printed on it, so they recognize it instead
 * of phoning up about an amount.
 */
const CHARGE_TYPES = [
  { value: 'violation',   label: 'Violation' },
  { value: 'damage',      label: 'Damage' },
  { value: 'replacement', label: 'Replacement (key, remote, fob)' },
  { value: 'service',     label: 'Service or callout' },
  { value: 'other',       label: 'Something else' },
] as const

function OneOffChargesCard({ tenantId, hasUnit }: { tenantId: string; hasUnit: boolean }) {
  const [adding, setAdding] = useState(false)
  const { data: charges = [], refetch } = useQuery<any[]>(
    ['one-off-charges', tenantId],
    () => apiGet(`/one-off-charges?tenantId=${tenantId}`),
  )

  const cancel = useMutation(
    (row: any) => apiPatch(`/one-off-charges/${row.id}/cancel`, {}),
    {
      onSuccess: () => { refetch(); toast('Charge withdrawn.') },
      onError: (e: any) => toast.error(e?.response?.data?.error || 'Could not withdraw that'),
    },
  )

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    gap: 10, flexWrap: 'wrap', marginBottom: 6 }}>
        <div className="card-title" style={{ marginBottom: 0 }}>Charges</div>
        {hasUnit && (
          <button className="btn btn-primary btn-sm" onClick={() => setAdding(true)}>
            <Plus size={13}/> Add a charge
          </button>
        )}
      </div>
      <div style={{ fontSize: '.72rem', color: 'var(--text-3)', marginBottom: 12, lineHeight: 1.6 }}>
        Something that happened rather than something in the lease — a violation, damage, a
        replacement key. It goes on their next invoice with the reason and the date on it.
      </div>

      {charges.length === 0 ? (
        <div style={{ color: 'var(--text-3)', fontSize: '.82rem' }}>
          {hasUnit ? 'Nothing charged.' : 'No active lease to charge.'}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {charges.map((c: any) => (
            <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 12,
                                     padding: '10px 12px', borderRadius: 10,
                                     background: 'var(--bg-2)', border: '1px solid var(--border-0)',
                                     opacity: c.status === 'cancelled' ? 0.55 : 1 }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: '.85rem', fontWeight: 600, color: 'var(--text-0)' }}>
                  {c.reason}
                </div>
                <div style={{ fontSize: '.72rem', color: 'var(--text-3)', marginTop: 1 }}>
                  {humanize(c.chargeType)} · {c.incidentDate}
                  {c.status === 'billed' && ' · on their invoice'}
                  {c.status === 'cancelled' && ` · withdrawn${c.cancelReason ? ` — ${c.cancelReason}` : ''}`}
                  {c.status === 'pending' && ` · bills on or after ${c.billOnOrAfter}`}
                </div>
              </div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: '.85rem', fontWeight: 600,
                            color: c.status === 'cancelled' ? 'var(--text-3)' : 'var(--gold)' }}>
                {fmt(c.amount)}
              </div>
              {c.status === 'pending' && (
                <button className="btn btn-ghost btn-sm" disabled={cancel.isLoading}
                  onClick={() => appConfirm(
                    `Withdraw the ${fmt(c.amount)} charge for "${c.reason}"?\n\n` +
                    `It stays on the record as withdrawn — nothing is erased.`,
                    { confirmLabel: 'Withdraw' },
                  ).then(ok => { if (ok) cancel.mutate(c) })}>
                  Withdraw
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {adding && (
        <AddChargeModal tenantId={tenantId}
          onClose={() => setAdding(false)}
          onSaved={() => { setAdding(false); refetch() }} />
      )}
    </div>
  )
}

function AddChargeModal({ tenantId, onClose, onSaved }: {
  tenantId: string; onClose: () => void; onSaved: () => void
}) {
  // This device's calendar day: a UTC day is tomorrow in Phoenix every evening.
  const today = localToday()
  const [chargeType, setChargeType] = useState('violation')
  const [amount, setAmount] = useState('')
  const [reason, setReason] = useState('')
  const [incidentDate, setIncidentDate] = useState(today)
  const [internalNote, setInternalNote] = useState('')
  const [error, setError] = useState('')

  const save = useMutation(
    () => apiPost('/one-off-charges', {
      tenantId, chargeType,
      amount: Number(amount),
      reason: reason.trim(),
      incidentDate,
      internalNote: internalNote.trim() || undefined,
    }),
    {
      onSuccess: () => { toast('Charge added — it goes on their next invoice.'); onSaved() },
      onError: (e: any) => setError(e?.response?.data?.error || 'Could not add that charge'),
    },
  )

  const ready = Number(amount) > 0 && reason.trim().length >= 3
  // Only its own buttons close it, and not while the charge is being added.
  const close = () => { if (!save.isLoading) onClose() }

  return (
    <div className="modal-overlay">
      <div className="modal" style={{ maxWidth: 420 }}>
        <div className="modal-title">Add a charge</div>
        <div style={{ fontSize: '.74rem', color: 'var(--text-3)', marginBottom: 14, lineHeight: 1.6 }}>
          For something that happened — not a term of the lease. The tenant sees the reason and
          the date on their invoice.
        </div>

        <label style={{ fontSize:'.75rem', color:'var(--text-3)', marginBottom:4, display:'block' }}>What kind</label>
        <select className="form-select" value={chargeType} onChange={e => setChargeType(e.target.value)}>
          {CHARGE_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
        </select>

        <label style={{ fontSize:'.75rem', color:'var(--text-3)', margin:'10px 0 4px', display:'block' }}>Amount</label>
        <input className="form-input" type="number" min="0.01" step="0.01" value={amount}
          placeholder="50.00" onChange={e => setAmount(e.target.value)} />

        <label style={{ fontSize:'.75rem', color:'var(--text-3)', margin:'10px 0 4px', display:'block' }}>
          Reason <span style={{ color:'var(--text-3)' }}>(the tenant reads this)</span>
        </label>
        <input className="form-input" value={reason} maxLength={200}
          placeholder="Parking in the fire lane"
          onChange={e => setReason(e.target.value)} />

        <label style={{ fontSize:'.75rem', color:'var(--text-3)', margin:'10px 0 4px', display:'block' }}>When it happened</label>
        <input className="form-input" type="date" value={incidentDate} max={today}
          onChange={e => setIncidentDate(e.target.value)} />

        <label style={{ fontSize:'.75rem', color:'var(--text-3)', margin:'10px 0 4px', display:'block' }}>
          Your own note <span style={{ color:'var(--text-3)' }}>(never shown to them)</span>
        </label>
        <textarea className="form-input" rows={2} value={internalNote} maxLength={1000}
          onChange={e => setInternalNote(e.target.value)} />

        {error && <div style={{ marginTop: 12, fontSize: '.78rem', color: 'var(--red)' }}>{error}</div>}

        <div style={{ display: 'flex', gap: 8, marginTop: 18 }}>
          <button className="btn btn-primary" disabled={!ready || save.isLoading}
            onClick={() => { setError(''); save.mutate() }}>
            {save.isLoading ? 'Adding…' : 'Add charge'}
          </button>
          <button className="btn btn-ghost" disabled={save.isLoading} onClick={close}>Cancel</button>
        </div>
      </div>
    </div>
  )
}


/**
 * S655 (Nic, 10/2): "ALL the credit on their account, and what of it would pay
 * their bills right now" — they differ (paid-ahead money stops at a monthly
 * draw limit, credit pays only your own rent, utilities and fees, and credit
 * tied to one lease pays only that lease). The balance itself is never netted;
 * the credit is used when they (or the desk, for them) say so, and pays a bill
 * by itself only when it covers that whole bill. Only a viewer who may see
 * payments, or the desk that takes them, is sent these figures (tenants.ts).
 */
function CreditCard({ credit }: { credit: TenantCredit | null }) {
  const headline = tenantCreditHeadline(credit)
  if (!credit || !headline) return null
  const lines = tenantCreditLines(credit)
  // Part of it can pay their bills and part cannot: say why the rest cannot.
  const someNotUsable = toCents(credit.usable) > 0 && toCents(credit.usable) < toCents(credit.total)
  return (
    <div className="card cd-credit-card" style={{ marginBottom: 16 }}>
      <div className="card-title" style={{ marginBottom: 10 }}>Account credit</div>
      <div className="cd-credit-lead">{headline}</div>
      {lines.map(l => (
        <div key={l.label} className="data-row">
          <span className="data-key">{l.label}</span>
          <span className="data-val mono">{money(l.amount)}</span>
        </div>
      ))}
      <div className="cd-note" style={{ marginTop: 10 }}>
        {CREDIT_USE_RULE}
        {someNotUsable && ' The rest cannot pay these bills: paid-ahead money stops at its monthly limit, credit pays only your own rent, utilities and fees, and credit tied to one lease pays only that lease.'}
      </div>
    </div>
  )
}

// S652 (Nic): "there's only a way to add a charge. There's no way to post a
// payment." A check that arrived before its bill: settles what is open, and
// the rest is kept as money paid ahead (decisions #29: the same form as Record
// payment for anyone not on the Outstanding list).
function PostPaymentCard({ tenantId, hasUnit, name }: { tenantId: string; hasUnit: boolean; name: string }) {
  // S655: posting a payment needs "Take payments". A worker without it used to
  // see the button and get "Insufficient permissions" after filling the form
  // in — now the card is simply not there.
  const { can } = usePerms()
  const [open, setOpen] = useState(false)
  if (!can('take_payment')) return null
  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', marginBottom: 6 }}>
        <div className="card-title" style={{ marginBottom: 0 }}>Payments</div>
        {hasUnit && (
          <button className="btn btn-primary btn-sm" onClick={() => setOpen(true)}>
            <Plus size={13}/> Post a payment
          </button>
        )}
      </div>
      <div className="cd-note">
        Cash, a check or a money order handed over. It pays whatever is open first; anything beyond that is kept on
        their account as paid ahead. {CREDIT_USE_RULE}
      </div>
      {open && (
        <PostPaymentForm tenantId={tenantId} name={name}
          onClose={() => setOpen(false)}
          onPosted={(m) => { setOpen(false); toast(m) }} />
      )}
    </div>
  )
}


// S652 (Nic): the posted notices and record photos on this resident's file —
// what a maintenance worker (or anyone with the permission) added from the
// Photos & Notices screen. Read here; taken there.
function PhotosAndNoticesCard({ tenantId }: { tenantId: string }) {
  const navigate = useNavigate()
  const { data: docs = [] } = useQuery<any[]>(['documents', 'tenant', tenantId], () => apiGet(`/documents?tenantId=${tenantId}`))
  const items = (docs as any[]).filter(d => ['notice', 'other'].includes(d.type) && String(d.mimeType || '').startsWith('image/'))
  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="card-title" style={{ marginBottom: 14, display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <span>Photos & Notices</span>
        <button className="btn btn-ghost btn-sm" onClick={() => navigate('/tenant-photos')}>Add a photo</button>
      </div>
      {items.length === 0 ? (
        <div style={{ color: 'var(--text-3)', fontSize: '.82rem' }}>Nothing posted or photographed yet.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {items.map((d: any) => (
            <div key={d.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px', borderRadius: 10, background: 'var(--bg-2)', border: '1px solid var(--border-0)' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span className={`badge ${d.type === 'notice' ? 'badge-amber' : 'badge-muted'}`}>{d.type === 'notice' ? 'Notice posted' : 'Photo'}</span>
                  <span style={{ fontSize: '.85rem', fontWeight: 600, color: 'var(--text-0)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.name}</span>
                </div>
                <div style={{ fontSize: '.72rem', color: 'var(--text-3)', marginTop: 2 }}>
                  {d.postedAt ? new Date(String(d.postedAt).slice(0, 10) + 'T12:00:00').toLocaleDateString() : new Date(d.createdAt).toLocaleDateString()}
                  {d.note ? ` · ${d.note}` : ''}
                </div>
              </div>
              <button className="btn btn-ghost btn-sm" onClick={() => navigate(`/view?src=${encodeURIComponent(`/documents/${d.id}/file`)}&title=${encodeURIComponent(d.name || 'Photo')}`)}>View</button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
