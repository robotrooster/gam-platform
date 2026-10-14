import { useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useMutation } from 'react-query'
import { humanize, PAYMENT_STATUS_LABEL, LEASE_STATUS_LABEL, type PaymentStatus, type LeaseStatus } from '@gam/shared'
import { apiGet, apiPost, apiPatch } from '../lib/api'
import { ArrowLeft, Plus } from 'lucide-react'
import { toast, appConfirm } from '../components/dialogs'
import { usePerms } from '../lib/permissions'
import { PostPaymentForm } from '../components/RecordPaymentWindow'
import {
  money, tenantCreditHeadline, tenantCreditLines, toCents, localToday, dayWord, monthTitle, calendarDay,
  CREDIT_USE_RULE, serverMessage, type TenantCredit,
} from '../lib/creditDesk'
import { healthColor, healthWord, healthText } from '../lib/paymentStamps'
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

/** 10/13 (Nic): one lease's payment health on the profile (GET /tenants/:id/profile stats.healthByLease). */
interface LeaseHealthRow {
  leaseId: string
  unitNumber: string | null
  propertyName: string | null
  current: boolean
  /** The lease's own status (shared LEASE_STATUSES). */
  status?: LeaseStatus
  health: { percent: number | null; onTime: number; counted: number; paidLate: number; partial: number; outstanding: number; label: string; onboardingLeftOut?: boolean } | null
}

/**
 * Where one lease stands, beside its health: Current (active), not signed yet
 * (pending — 10/13 review: a new lease waiting for signatures read "Ended"),
 * else Ended.
 */
export function LeaseHealthBadge({ lease }: { lease: Pick<LeaseHealthRow, 'current' | 'status'> }) {
  if (lease.current) return <span className="badge badge-green">Current</span>
  if (lease.status === 'pending') return <span className="badge badge-gold">{LEASE_STATUS_LABEL.pending}</span>
  return <span className="badge badge-muted">Ended</span>
}

export function TenantDetailPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  // 10/12: the payment report opens for the owner or "View all payments" (the
  // route's gate, GET /tenants/:id/payment-report). Staff who see the health
  // card through the books permission are not offered a report they cannot open.
  const { can } = usePerms()
  const opensReport = can('payments.view_all')
  // 10/6 (Nic): the late fee being deleted from the Payment History (one at a time).
  const [deletingFee, setDeletingFee] = useState<string | null>(null)
  // 10/12 (Nic): the household's Payment History, a page at a time (no 36-row cap).
  const [historyPage, setHistoryPage] = useState(1)
  // S252: per-tenant FlexCharge query removed alongside the legacy
  // panel. New flex_charge_accounts schema is (customer, property)
  // keyed; consult the FlexCharge dashboard (S254) for per-property
  // account management.
  const { data, isLoading, error, refetch, isFetching } = useQuery(['tenant-profile', id, historyPage],
    () => apiGet<any>(`/tenants/${id}/profile${historyPage > 1 ? `?historyPage=${historyPage}` : ''}`), {
    // Turning a page keeps the page on screen until the next one arrives.
    keepPreviousData: true,
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
  /**
   * 10/6 (Nic): "the late fee is only deleted during onboarding at landlord's
   * discretion." A late fee that was credited (or, before 10/6, zeroed) on the onboarding
   * month's bill: the server marks the line (canDeleteLateFee) only for the
   * owner or a property manager, and refuses anything else in plain words.
   */
  const deleteLateFee = async (p: any) => {
    const ok = await appConfirm(
      `The ${dayWord(p.dueDate, '')} late fee was credited, and the payment still counts as late on their history. ` +
      'Deleting the late fee removes it and its credit from their record completely, so the payment counts from the day the money was deposited — ' +
      'only for the onboarding month.',
      { title: 'Delete this late fee', confirmLabel: 'Delete this late fee' })
    if (!ok) return
    setDeletingFee(p.id)
    try {
      const r: any = await apiPost(`/payments/${p.id}/delete-late-fee`, {})
      toast(r?.data?.message ?? 'The late fee was deleted — nothing shows on their record.')
      refetch()
    } catch (e) {
      toast.error(serverMessage(e, 'The late fee could not be deleted. Nothing changed — try again.'))
    } finally {
      setDeletingFee(null)
    }
  }
  // S641: staff without the payment permissions get no payment history or
  // money figures from the server; the payment cards are left out for them.
  const paymentsHidden = !!data.paymentsHidden
  const currentUnit = units?.find((u: any) => u.isCurrent)
  // 10/12 (Nic): the one payment-health figure — the household's months paid
  // on time, all time since it joined GAM (null until a month is judged).
  // 10/13 (Nic): "Tenants list + tenant profile: split health BY LEASE" — each
  // lease the person is on is its own household with its own figure (the
  // server's stats.healthByLease, current leases first). One lease: its
  // figure. Several: each, side by side. None on file: the household's.
  const byLease: LeaseHealthRow[] = stats.healthByLease ?? []
  const health = byLease.length === 1 ? (byLease[0].health ?? null) : (stats.health ?? null)
  const rate: number | null = byLease.length === 1 ? (byLease[0].health?.percent ?? null) : (stats.onTimeRate ?? null)
  const onTimeColor = healthColor(rate)
  // 10/13 (Nic): "Keep it out, but say so" — nothing counted yet says why
  // ("Onboarding month — not counted"), never a bare dash.
  const onTimeLabel = healthWord(rate, health)
  const severalLeases = byLease.length > 1
  /** The report for one lease (that lease's household), or the person's whole one. */
  const reportFor = (leaseId?: string | null) => `/tenants/${id}/report${leaseId ? `?leaseId=${encodeURIComponent(leaseId)}` : ''}`
  const singleLeaseId = byLease.length === 1 ? byLease[0].leaseId : null
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
              severalLeases
                ? { label: 'Payment Health', val: byLease.map(l => `${l.unitNumber ?? '—'} ${healthText(l.health)}`).join(' · '),
                    color: 'var(--text-0)', sub: 'by lease' }
                : rate === null
                  // Nothing counted yet: the words in the figure's place (no dash, no repeat under it).
                  ? { label: 'Payment Health', val: onTimeLabel, color: onTimeColor, small: true }
                  : { label: 'Payment Health', val: rate + '%', color: onTimeColor, sub: onTimeLabel },
              { label: 'Units With You', val: stats.unitsOccupied, color: 'var(--text-0)' },
            ]).map(s => (
              <div key={s.label} className="card" style={{ padding: '14px 16px' }}>
                <div style={{ fontSize: '.65rem', fontWeight: 700, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.08em', marginBottom: 6 }}>{s.label}</div>
                <div style={(s as any).small
                  ? { fontFamily: 'var(--font-body)', fontSize: '.8rem', fontWeight: 700, color: 'var(--text-2)' }
                  : { fontFamily: 'var(--font-mono)', fontSize: '1rem', fontWeight: 700, color: s.color }}>{s.val}</div>
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
            {/* W-25 (S531): the health card drills into how late — aggregate
                health hides whether "late" meant 2 days or 3 weeks. 10/12
                (Nic): it opens the household's payment report (days past
                grace, the pattern, partials, every charge). */}
            {!paymentsHidden && severalLeases && (
            <div className="card">
              <div className="card-title" style={{ marginBottom: 14 }}>Payment Health — by lease</div>
              {byLease.map(l => {
                const pct = l.health?.percent ?? null
                const color = healthColor(pct)
                return (
                  <div key={l.leaseId} data-lease={l.leaseId} style={{ padding: '10px 0', borderTop: '1px solid var(--border-0)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                      <div style={{ width: 44, height: 44, borderRadius: '50%', background: 'var(--bg-3)', border: '3px solid ' + color, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                        <span style={{ fontFamily: 'var(--font-mono)', fontSize: '.78rem', fontWeight: 800, color }}
                          title={pct === null ? healthText(l.health) : undefined}>{pct === null ? '—' : `${pct}%`}</span>
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: '.84rem', fontWeight: 700, color: 'var(--text-0)' }}>
                          {l.unitNumber ?? 'Lease'}{l.propertyName ? ` · ${l.propertyName}` : ''}{' '}
                          <LeaseHealthBadge lease={l} />
                        </div>
                        <div style={{ fontSize: '.72rem', color: 'var(--text-3)', marginTop: 2 }}>
                          {/* Nothing counted yet: why, beside the ring's dash (healthText). */}
                          {l.health?.percent == null ? healthText(l.health) : l.health.label} · since joining GAM
                          {l.health?.percent != null && l.health.onboardingLeftOut && ' · onboarding month not counted'}
                          {l.health && ` · ${l.health.paidLate} late, ${l.health.partial} partial, ${l.health.outstanding} outstanding`}
                        </div>
                      </div>
                      {opensReport && (
                        <button className="btn btn-primary btn-sm" onClick={() => navigate(reportFor(l.leaseId))}>Report</button>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
            )}
            {!paymentsHidden && !severalLeases && (
            <div className="card" style={{ cursor: opensReport ? 'pointer' : undefined }}
              onClick={opensReport ? () => navigate(reportFor(singleLeaseId)) : undefined}
              title={opensReport ? 'Open the full payment report' : undefined}>
              <div className="card-title" style={{ marginBottom: 14, display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                <span>Payment Health</span>
                {opensReport && <span style={{ fontSize: '.68rem', color: 'var(--gold)', fontWeight: 600 }}>Full report →</span>}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 16 }}>
                <div style={{ width: 56, height: 56, borderRadius: '50%', background: 'var(--bg-3)', border: '3px solid ' + onTimeColor, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: '.9rem', fontWeight: 800, color: onTimeColor }}>{rate === null ? '—' : `${rate}%`}</span>
                </div>
                <div>
                  <div style={{ fontSize: '.85rem', fontWeight: 700, color: onTimeColor }}>{onTimeLabel}</div>
                  <div style={{ fontSize: '.72rem', color: 'var(--text-3)', marginTop: 2 }}>
                    {/* Nothing counted yet: the words above say why; no repeat. */}
                    {rate === null ? 'Since joining GAM' : `${health?.label ?? 'Months paid on time'} · since joining GAM`}
                    {rate !== null && health?.onboardingLeftOut && ' · onboarding month not counted'}
                  </div>
                </div>
              </div>
              {[
                { label: 'Months on time', val: health ? `${health.onTime} of ${health.counted}` : '—' },
                { label: 'Paid late', val: health?.paidLate ?? 0 },
                { label: 'Partial', val: health?.partial ?? 0 },
                { label: 'Outstanding', val: health?.outstanding ?? 0 },
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
            {/* 10/12 (Nic): "The profile Payment History also gets the 'What it's
                for' column and covers the household." Every charge, newest first,
                a page at a time; the full report has them all on one page. */}
            <div className="card-title" style={{ marginBottom: 14, display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <span>Payment History — household</span>
              {opensReport && <button className="btn btn-primary btn-sm" onClick={() => navigate(reportFor(singleLeaseId))}>Full report</button>}
            </div>
            {payments?.length === 0 ? (
              <div style={{ color: 'var(--text-3)', fontSize: '.82rem' }}>No payments yet.</div>
            ) : (
              <div style={{ overflowX: 'auto' }}>
              <table className="data-table">
                <thead><tr><th>Date</th><th>What it's for</th><th>Property</th><th>Unit</th><th>Amount</th><th>Status</th></tr></thead>
                <tbody>
                  {payments?.map((p: any) => (
                    <tr key={p.id}>
                      <td className="mono" style={{ fontSize: '.72rem' }}>{dayWord(p.dueDate, '')}</td>
                      <td style={{ fontSize: '.78rem' }}>{p.label ?? humanize(p.type)}{p.detail && <div style={{ fontSize: '.66rem', color: 'var(--text-3)' }}>{p.detail}</div>}</td>
                      <td style={{ fontSize: '.78rem' }}>{p.propertyName}</td>
                      <td className="mono">{p.unitNumber}</td>
                      <td className="mono">{fmt(p.amount)}</td>
                      <td>
                        <span className={`badge ${PAYMENT_STATUS_BADGE[p.status as PaymentStatus] ?? 'badge-muted'}`}>{PAYMENT_STATUS_LABEL[p.status as PaymentStatus] ?? humanize(p.status)}</span>
                        {p.canDeleteLateFee && (
                          <button className="btn btn-primary btn-sm" style={{ marginLeft: 8 }}
                            disabled={deletingFee !== null} onClick={() => deleteLateFee(p)}>
                            {deletingFee === p.id ? 'Deleting…' : 'Delete this late fee'}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            )}
            <HistoryPager page={data.paymentsPage} busy={isFetching} onPage={setHistoryPage} />
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

/**
 * 10/12 (Nic): which charges of the household's Payment History are showing,
 * and the way to the newer or older ones (the server sends a page at a time).
 */
export function HistoryPager({ page, busy, onPage }: {
  page?: { page: number; pageSize: number; total: number } | null
  busy: boolean
  onPage: (n: number) => void
}) {
  if (!page || page.total <= page.pageSize) return null
  const pages = Math.max(1, Math.ceil(page.total / page.pageSize))
  const first = (page.page - 1) * page.pageSize + 1
  const last = Math.min(page.total, page.page * page.pageSize)
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginTop: 12, flexWrap: 'wrap' }}>
      <span style={{ fontSize: '.74rem', color: 'var(--text-3)' }}>
        {first > page.total ? `No charges on this page — ${page.total} in all` : `Charges ${first}–${last} of ${page.total}, newest first`}
      </span>
      <span style={{ display: 'flex', gap: 8 }}>
        <button className="btn btn-primary btn-sm" disabled={busy || page.page <= 1} onClick={() => onPage(page.page - 1)}>Newer</button>
        <button className="btn btn-primary btn-sm" disabled={busy || page.page >= pages} onClick={() => onPage(page.page + 1)}>Older</button>
      </span>
    </div>
  )
}
