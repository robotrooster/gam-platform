import { useMemo, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { TrendingUp, AlertTriangle, CheckCircle2, Clock } from 'lucide-react'
import { apiGet, apiPost } from '../lib/api'

type Tenant = {
  id: string
  firstName: string
  lastName: string
  email: string
  unitNumber: string
  propertyName: string
  onTimePayEnrolled: boolean
  otpDisqualifiedUntil: string | null
  qualification: {
    eligible: boolean
    blockers: string[]
    cooldownUntil: string | null
  }
}

type Advance = {
  id: string
  cycleMonth: string
  tenantId: string
  rentAmount: string | number
  feeAmount: string | number
  advanceAmount: string | number
  status: 'pending' | 'advanced' | 'reconciled' | 'defaulted'
  advancedAt: string | null
  reconciledAt: string | null
  defaultedAt: string | null
  defaultReason: string | null
  firstName: string
  lastName: string
  unitNumber: string
  propertyName: string
}

const BLOCKER_LABEL: Record<string, string> = {
  ach_unverified:        'Bank not verified',
  deposit_not_funded:    'Deposit not fully funded',
  flex_deposit_active:   'On FlexDeposit installments',
  bg_check_not_approved: 'Background check not approved',
  nsf_cooldown:          '6-month cooldown after NSF',
  tenant_not_found:      'Tenant record missing',
}

const STATUS_BADGE: Record<string, string> = {
  pending:    'badge-amber',
  advanced:   'badge-blue',
  reconciled: 'badge-green',
  defaulted:  'badge-red',
}

const fmt = (n: any) => {
  if (n == null) return '$—'
  const v = typeof n === 'string' ? parseFloat(n) : n
  return `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

export function OtpPage() {
  const qc = useQueryClient()
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  const { data: visibility } = useQuery<{ visible: boolean }>(
    'otp-visibility',
    () => apiGet<{ visible: boolean }>('/landlords/me/otp/visibility'),
  )

  const { data: tenants = [], isLoading: tLoading } = useQuery<Tenant[]>(
    'otp-eligible-tenants',
    () => apiGet<Tenant[]>('/landlords/me/otp/eligible-tenants'),
    { enabled: visibility?.visible === true },
  )

  const { data: advances = [], isLoading: aLoading } = useQuery<Advance[]>(
    'otp-advances',
    () => apiGet<Advance[]>('/landlords/me/otp/advances'),
    { enabled: visibility?.visible === true },
  )

  const enableMut = useMutation(
    (tenantId: string) => apiPost(`/landlords/me/otp/tenants/${tenantId}/enable`),
    {
      onSuccess: () => { qc.invalidateQueries('otp-eligible-tenants'); setSuccess('Enrolled. Next advance will run on the last business day of the month.') ; setTimeout(() => setSuccess(null), 4000) },
      onError: (e: any) => setError(e?.response?.data?.error || 'Failed'),
    },
  )

  const disableMut = useMutation(
    (tenantId: string) => apiPost(`/landlords/me/otp/tenants/${tenantId}/disable`, {}),
    {
      onSuccess: () => { qc.invalidateQueries('otp-eligible-tenants'); setSuccess('Disabled.'); setTimeout(() => setSuccess(null), 3000) },
      onError: (e: any) => setError(e?.response?.data?.error || 'Failed'),
    },
  )

  // KPI calc from advances
  const kpis = useMemo(() => {
    const list = advances as Advance[]
    const reconciled = list.filter(a => a.status === 'reconciled')
    const advanced = list.filter(a => a.status === 'advanced')
    const defaulted = list.filter(a => a.status === 'defaulted')
    const totalAdvancedAllTime = list
      .filter(a => a.status === 'advanced' || a.status === 'reconciled')
      .reduce((s, a) => s + Number(a.advanceAmount || 0), 0)
    const totalFeesEarned = reconciled.reduce((s, a) => s + Number(a.feeAmount || 0), 0)
    const totalLossEaten = defaulted.reduce((s, a) => s + Number(a.advanceAmount || 0), 0)
    const enrolled = (tenants as Tenant[]).filter(t => t.onTimePayEnrolled).length
    return {
      enrolled,
      pendingThisMonth: advanced.length,
      totalAdvancedAllTime,
      totalFeesEarned,
      totalLossEaten,
    }
  }, [advances, tenants])

  if (!visibility) return <div style={{ padding: 32, color: 'var(--text-3)' }}>Loading…</div>

  if (!visibility.visible) {
    return (
      <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--text-3)' }}>
        <strong>OTP not yet available for your account.</strong>
        <div style={{ marginTop: 8, fontSize: '.85rem' }}>This product is in limited beta.</div>
      </div>
    )
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <TrendingUp size={22} /> On-Time Pay
          </h1>
          <div className="page-sub">
            Get rent advanced to your bank on the 1st. GAM collects from the tenant at their normal pull date later in the month.
            We charge 1% — the tenant pays the same amount they always have.
          </div>
        </div>
      </div>

      {error && <div className="card" style={{ padding: 12, marginBottom: 16, background: 'rgba(239,68,68,.08)', borderColor: 'rgba(239,68,68,.3)', color: 'var(--red)' }}>{error}</div>}
      {success && <div className="card" style={{ padding: 12, marginBottom: 16, background: 'rgba(34,197,94,.06)', borderColor: 'rgba(34,197,94,.25)', color: 'var(--green)' }}>{success}</div>}

      {/* KPI strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, marginBottom: 20 }}>
        <Tile label="Enrolled tenants" value={String(kpis.enrolled)} sub="receiving advances" />
        <Tile label="In flight (advanced)" value={String(kpis.pendingThisMonth)} sub="awaiting tenant settlement" />
        <Tile label="Total advanced" value={fmt(kpis.totalAdvancedAllTime)} sub="all time" />
        <Tile label="Fees earned" value={fmt(kpis.totalFeesEarned)} sub="reconciled cycles" tone="green" />
        {kpis.totalLossEaten > 0 && (
          <Tile label="Defaulted (loss)" value={fmt(kpis.totalLossEaten)} sub="NSF write-offs" tone="red" />
        )}
      </div>

      {/* Eligible tenants */}
      <div className="card" style={{ padding: 0, marginBottom: 20 }}>
        <div style={{ padding: 14, borderBottom: '1px solid var(--border-0)' }}>
          <strong style={{ color: 'var(--text-0)' }}>Tenants</strong>
          <div style={{ fontSize: '.78rem', color: 'var(--text-3)', marginTop: 2 }}>
            Enable OTP on a tenant to start receiving their rent on the 1st. Disable anytime.
          </div>
        </div>
        {tLoading ? (
          <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-3)' }}>Loading tenants…</div>
        ) : (tenants as Tenant[]).length === 0 ? (
          <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-3)' }}>No active tenants.</div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="data-table" style={{ width: '100%', minWidth: 800 }}>
              <thead>
                <tr>
                  <th>Tenant</th>
                  <th>Unit</th>
                  <th>Status</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {(tenants as Tenant[]).map(t => (
                  <tr key={t.id}>
                    <td>
                      <div style={{ color: 'var(--text-0)', fontWeight: 600 }}>{t.firstName} {t.lastName}</div>
                      <div style={{ fontSize: '.7rem', color: 'var(--text-3)' }}>{t.email}</div>
                    </td>
                    <td>
                      <div style={{ color: 'var(--text-1)' }}>{t.unitNumber}</div>
                      <div style={{ fontSize: '.7rem', color: 'var(--text-3)' }}>{t.propertyName}</div>
                    </td>
                    <td>
                      {t.onTimePayEnrolled ? (
                        <span className="badge badge-green">
                          <CheckCircle2 size={11} style={{ verticalAlign: 'middle', marginRight: 3 }} /> Enrolled
                        </span>
                      ) : t.qualification.eligible ? (
                        <span className="badge badge-muted">Eligible — not enrolled</span>
                      ) : (
                        <div>
                          <span className="badge badge-amber" style={{ marginBottom: 4 }}>
                            <AlertTriangle size={11} style={{ verticalAlign: 'middle', marginRight: 3 }} /> Not eligible
                          </span>
                          <div style={{ fontSize: '.7rem', color: 'var(--text-3)', marginTop: 2 }}>
                            {t.qualification.blockers.map(b => BLOCKER_LABEL[b] || b).join(' · ')}
                          </div>
                          {t.qualification.cooldownUntil && (
                            <div style={{ fontSize: '.65rem', color: 'var(--amber)', marginTop: 2 }}>
                              <Clock size={10} style={{ verticalAlign: 'middle' }} /> until {new Date(t.qualification.cooldownUntil).toLocaleDateString()}
                            </div>
                          )}
                        </div>
                      )}
                    </td>
                    <td>
                      {t.onTimePayEnrolled ? (
                        <button
                          className="btn btn-ghost btn-sm"
                          onClick={() => disableMut.mutate(t.id)}
                          disabled={disableMut.isLoading}
                          style={{ color: 'var(--red)' }}
                        >
                          Disable
                        </button>
                      ) : t.qualification.eligible ? (
                        <button
                          className="btn btn-primary btn-sm"
                          onClick={() => enableMut.mutate(t.id)}
                          disabled={enableMut.isLoading}
                        >
                          Enable
                        </button>
                      ) : (
                        <span style={{ fontSize: '.7rem', color: 'var(--text-3)' }}>—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Advances history */}
      <div className="card" style={{ padding: 0 }}>
        <div style={{ padding: 14, borderBottom: '1px solid var(--border-0)' }}>
          <strong style={{ color: 'var(--text-0)' }}>Advance history</strong>
          <div style={{ fontSize: '.78rem', color: 'var(--text-3)', marginTop: 2 }}>
            Each row = one tenant × one cycle month. Reconciled = tenant rent landed and we kept the 1% fee.
          </div>
        </div>
        {aLoading ? (
          <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-3)' }}>Loading…</div>
        ) : (advances as Advance[]).length === 0 ? (
          <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-3)' }}>
            No advances yet. The first cycle runs on the last business day of the month.
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="data-table" style={{ width: '100%', minWidth: 880 }}>
              <thead>
                <tr>
                  <th>Cycle</th>
                  <th>Tenant</th>
                  <th>Unit</th>
                  <th>Rent</th>
                  <th>Fee</th>
                  <th>Advance</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {(advances as Advance[]).map(a => (
                  <tr key={a.id}>
                    <td className="mono" style={{ fontSize: '.78rem' }}>{a.cycleMonth?.slice(0, 7)}</td>
                    <td>{a.firstName} {a.lastName}</td>
                    <td>
                      <div style={{ color: 'var(--text-1)' }}>{a.unitNumber}</div>
                      <div style={{ fontSize: '.7rem', color: 'var(--text-3)' }}>{a.propertyName}</div>
                    </td>
                    <td className="mono">{fmt(a.rentAmount)}</td>
                    <td className="mono" style={{ color: 'var(--text-3)' }}>{fmt(a.feeAmount)}</td>
                    <td className="mono" style={{ color: 'var(--text-0)', fontWeight: 600 }}>{fmt(a.advanceAmount)}</td>
                    <td>
                      <span className={`badge ${STATUS_BADGE[a.status] || 'badge-muted'}`}>{a.status}</span>
                      {a.defaultReason && (
                        <div style={{ fontSize: '.65rem', color: 'var(--red)', marginTop: 2 }}>{a.defaultReason}</div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}

function Tile({ label, value, sub, tone = 'default' }: { label: string; value: string; sub?: string; tone?: 'default' | 'green' | 'red' }) {
  const color = tone === 'green' ? 'var(--green)' : tone === 'red' ? 'var(--red)' : 'var(--text-0)'
  return (
    <div className="card" style={{ padding: 14 }}>
      <div style={{ fontSize: '.7rem', color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 4 }}>{label}</div>
      <div style={{ fontFamily: 'var(--font-display)', fontSize: '1.5rem', fontWeight: 800, color, lineHeight: 1.1 }}>{value}</div>
      {sub && <div style={{ fontSize: '.7rem', color: 'var(--text-3)', marginTop: 2 }}>{sub}</div>}
    </div>
  )
}
