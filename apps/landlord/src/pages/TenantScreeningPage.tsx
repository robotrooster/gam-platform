import { useMemo, useState } from 'react'
import { useQuery } from 'react-query'
import { Search, UserSearch, Info } from 'lucide-react'
import { apiGet } from '../lib/api'

type ScreeningPayload = {
  subjectId: string | null
  subjectType: 'tenant'
  subjectRefId: string
  events: ScreeningEvent[]
  stats: {
    paymentStats?: any
    propertyStats?: any
    tenancyStats?: any
    communityStats?: any
    cooperationStats?: any
  } | null
}

type ScreeningEvent = {
  id: string
  eventType: string
  occurredAt: string
  recordedAt: string
  attestationSource: string
  dimensionTags: string[]
  networkVisibility: 'private_to_subject' | 'visible_to_current_landlord' | 'visible_to_gam_network'
  superseded: boolean
  thisHash: string | null
}

const EVENT_LABEL: Record<string, string> = {
  payment_received_on_time:           'Rent paid on time',
  payment_received_late_grace:        'Paid within grace period',
  payment_received_late_minor:        'Paid late (minor)',
  payment_received_late_major:        'Paid late (major)',
  payment_received_late_severe:       'Paid late (severe)',
  payment_partial:                    'Partial payment',
  payment_failed_nsf:                 'Payment failed (NSF)',
  payment_skipped:                    'Payment skipped',
  payment_refunded:                   'Payment refunded',
  lease_signed:                       'Lease signed',
  lease_renewed:                      'Lease renewed',
  lease_anniversary:                  'Lease anniversary',
  lease_terminated_natural:           'Lease completed',
  lease_terminated_early_by_tenant:   'Lease ended early (by tenant)',
  lease_terminated_early_by_landlord: 'Lease ended early (by landlord)',
  lease_abandoned:                    'Lease abandoned',
  proper_notice_given_for_move_out:   'Proper move-out notice',
  move_in_inspection_completed:       'Move-in inspection completed',
  move_out_inspection_completed:      'Move-out inspection completed',
  move_out_condition_matches_move_in: 'Move-out condition matches',
  move_out_condition_damage_documented:'Move-out damage documented',
  move_in_photos_submitted:           'Move-in photos submitted',
  move_out_photos_submitted:          'Move-out photos submitted',
  deposit_returned_full:              'Deposit returned in full',
  deposit_returned_partial:           'Deposit partially withheld',
  deposit_returned_zero:              'Deposit fully withheld',
  deposit_interest_paid:              'Statutory deposit interest settled',
  sublease_requested:                 'Sublease requested',
  sublease_approved:                  'Sublease approved',
  sublease_denied:                    'Sublease denied',
  sublease_completed_natural:         'Sublease completed (end of term)',
  sublease_terminated_early:          'Sublease terminated early',
  lease_addendum_recorded:            'Lease amended (addendum)',
  renters_insurance_verified:         'Renters insurance verified',
  utilities_transferred_at_move_in:   'Utilities transferred',
  maintenance_resolution_confirmed:   'Maintenance fix confirmed',
  entry_request_granted_within_window:'Entry granted within window',
  entry_request_denied:               'Entry request denied',
  lease_violation_notice_issued:      'Lease violation notice',
  lease_violation_cured:              'Lease violation cured',
  noise_complaint_logged:             'Noise complaint',
  property_damage_event_documented:   'Property damage documented',
  nuisance_event_documented:          'Nuisance event documented',
  eviction_notice_filed:              'Eviction notice filed',
  eviction_settled:                   'Eviction settled',
  eviction_hearing_dismissed:         'Eviction dismissed',
  eviction_hearing_judgment_issued:   'Eviction judgment',
  tenancy_ended_with_balance:         'Tenancy ended with balance',
  balance_paid_post_move:             'Balance paid post-move',
  balance_sent_to_collections:        'Balance sent to collections',
  multi_landlord_history_clean:       'Clean history across landlords',
}

const POSITIVE_EVENT_TYPES = new Set([
  'payment_received_on_time','payment_received_late_grace','payment_received_late_minor',
  'lease_signed','lease_renewed','lease_terminated_natural','lease_anniversary',
  'proper_notice_given_for_move_out','move_in_inspection_completed','move_out_inspection_completed',
  'move_out_condition_matches_move_in','move_in_photos_submitted','move_out_photos_submitted',
  'deposit_returned_full','renters_insurance_verified','utilities_transferred_at_move_in',
  'maintenance_resolution_confirmed','entry_request_granted_within_window','lease_violation_cured',
  'balance_paid_post_move','multi_landlord_history_clean',
  'sublease_completed_natural',
])

function eventTone(eventType: string): 'positive' | 'negative' | 'neutral' {
  if (POSITIVE_EVENT_TYPES.has(eventType)) return 'positive'
  if (eventType.startsWith('dispute_')) return 'neutral'
  if (eventType === 'hardship_context_added' || eventType === 'subject_added_event_context') return 'neutral'
  return 'negative'
}

function attestationLabel(src: string): string {
  switch (src) {
    case 'stripe_attested':       return 'Verified by payment processor'
    case 'gam_workflow_auto':     return 'GAM workflow'
    case 'gam_bill_pay_attested': return 'GAM bill-pay'
    case 'plaid_attested':        return 'Plaid'
    case 'system_derived':        return 'system'
    case 'tenant_self_reported':  return 'self-reported'
    case 'partner_cra':           return 'CRA partner'
    default:                      return src.replace(/_/g, ' ')
  }
}

export function TenantScreeningPage() {
  const [search, setSearch] = useState('')
  const [selectedTenantId, setSelectedTenantId] = useState<string | null>(null)

  const { data: units = [] } = useQuery<any[]>('units', () => apiGet<any[]>('/units'))
  const { data: tenants = [] } = useQuery<any[]>('tenants-for-screening', () => apiGet<any[]>('/tenants'))

  // Build a lightweight tenant-id-keyed search list
  const tenantOptions = useMemo(() => {
    const idToTenant = new Map<string, { id: string; firstName: string; lastName: string; email: string }>()
    for (const t of tenants as any[]) {
      idToTenant.set(t.id, t)
    }
    const list: { id: string; label: string; sub: string }[] = []
    for (const u of units as any[]) {
      if (u.tenantId && idToTenant.has(u.tenantId)) {
        const t = idToTenant.get(u.tenantId)!
        list.push({
          id: u.tenantId,
          label: `${t.firstName} ${t.lastName}`,
          sub: `Unit ${u.unitNumber} · ${u.propertyName}`,
        })
      }
    }
    // Add tenants without an active unit (applicants etc.)
    for (const t of tenants as any[]) {
      if (!list.find(x => x.id === t.id)) {
        list.push({ id: t.id, label: `${t.firstName} ${t.lastName}`, sub: t.email })
      }
    }
    if (!search) return list
    const q = search.toLowerCase()
    return list.filter(x => x.label.toLowerCase().includes(q) || x.sub.toLowerCase().includes(q))
  }, [units, tenants, search])

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <UserSearch size={22} /> Tenant Screening
          </h1>
          <div className="page-sub">
            Network-visible behavioral record for prospective and current tenants
          </div>
        </div>
      </div>

      <div className="card" style={{ padding: 12, marginBottom: 16, background: 'rgba(59,130,246,.04)', borderColor: 'rgba(59,130,246,.2)' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
          <Info size={16} style={{ color: 'var(--blue, #3b82f6)', marginTop: 2, flexShrink: 0 }} />
          <div style={{ fontSize: '.82rem', color: 'var(--text-2)' }}>
            You see events the tenant has consented to share with the GAM network.
            With an active tenancy you also see current-landlord-only events.
            Score is internal-only and not exposed here. Make screening decisions
            based on the events themselves, not a single number.
          </div>
        </div>
      </div>

      <div className="card" style={{ padding: 16, marginBottom: 16 }}>
        <label style={{ display: 'block', fontSize: '.7rem', color: 'var(--text-3)', marginBottom: 4 }}>Find tenant</label>
        <div style={{ position: 'relative' }}>
          <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-3)' }} />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search by name or email"
            className="input"
            style={{ paddingLeft: 32 }}
          />
        </div>
        {search && tenantOptions.length > 0 && (
          <div style={{ maxHeight: 280, overflowY: 'auto', marginTop: 8, border: '1px solid var(--border-0)', borderRadius: 8 }}>
            {tenantOptions.slice(0, 12).map(opt => (
              <button
                key={opt.id}
                onClick={() => { setSelectedTenantId(opt.id); setSearch('') }}
                style={{ display: 'block', width: '100%', textAlign: 'left', padding: 10, background: 'transparent', border: 'none', borderBottom: '1px solid var(--border-0)', cursor: 'pointer', color: 'var(--text-1)' }}
              >
                <div style={{ fontWeight: 600, color: 'var(--text-0)' }}>{opt.label}</div>
                <div style={{ fontSize: '.72rem', color: 'var(--text-3)' }}>{opt.sub}</div>
              </button>
            ))}
          </div>
        )}
      </div>

      {selectedTenantId && (
        <ScreeningResult tenantId={selectedTenantId} onClear={() => setSelectedTenantId(null)} />
      )}
    </div>
  )
}

function ScreeningResult({ tenantId, onClear }: { tenantId: string; onClear: () => void }) {
  const { data, isLoading, error } = useQuery<ScreeningPayload>(
    ['screening', tenantId],
    () => apiGet<ScreeningPayload>(`/credit/screening-by-tenant/${tenantId}`),
  )

  if (isLoading) return <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--text-3)' }}>Loading…</div>
  if (error) return <div className="card" style={{ padding: 16, background: 'rgba(239,68,68,.06)', borderColor: 'rgba(239,68,68,.3)', color: 'var(--red)' }}>Unable to load tenant record. (You may not have visibility for this tenant.)</div>
  if (!data) return null

  const events = data.events || []
  const activeEvents = events.filter(e => !e.superseded)
  const payment = data.stats?.paymentStats?.lifetime || {}
  const totalPayments = payment.totalEvents ?? 0
  const onTimePct = payment.onTimePct
  const longestStreak = data.stats?.paymentStats?.longestOnTimeStreakCount ?? 0
  const currentStreak = data.stats?.paymentStats?.currentOnTimeStreakCount ?? 0

  const grouped: { label: string; rows: ScreeningEvent[] }[] = []
  for (const ev of activeEvents) {
    const d = new Date(ev.occurredAt)
    const key = d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
    let bucket = grouped.find(g => g.label === key)
    if (!bucket) { bucket = { label: key, rows: [] }; grouped.push(bucket) }
    bucket.rows.push(ev)
  }
  grouped.reverse()

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <div style={{ fontSize: '.78rem', color: 'var(--text-3)' }}>
          Subject: {data.subjectId ? <span style={{ fontFamily: 'var(--font-mono)' }}>{data.subjectId}</span> : <em>no record yet</em>}
        </div>
        <button className="btn btn-ghost btn-sm" onClick={onClear}>Pick a different tenant</button>
      </div>

      <div className="grid3" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, marginBottom: 16 }}>
        <Kpi label="Visible events" value={String(activeEvents.length)} sub="network + your relationship" />
        <Kpi label="On-time payments" value={totalPayments > 0 ? `${onTimePct}%` : '—'} sub={`${totalPayments} payments tracked`} />
        <Kpi label="On-time streak" value={String(currentStreak)} sub={`longest: ${longestStreak}`} />
      </div>

      {activeEvents.length === 0 ? (
        <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--text-3)' }}>
          No visible events for this tenant. Either they have no GAM history yet, or you have no relationship granting visibility.
        </div>
      ) : (
        <div className="card" style={{ padding: 0 }}>
          <div style={{ padding: 12, borderBottom: '1px solid var(--border-0)' }}>
            <strong style={{ color: 'var(--text-0)' }}>Event timeline</strong>
          </div>
          {grouped.map(bucket => (
            <div key={bucket.label}>
              <div style={{ padding: '8px 14px', background: 'var(--bg-1)', fontSize: '.7rem', color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.08em', fontWeight: 600 }}>
                {bucket.label}
              </div>
              {bucket.rows.map(ev => <ScreeningEventRow key={ev.id} ev={ev} />)}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function ScreeningEventRow({ ev }: { ev: ScreeningEvent }) {
  const tone = eventTone(ev.eventType)
  const dotColor = tone === 'positive' ? 'var(--green)' : tone === 'negative' ? 'var(--red)' : 'var(--text-3)'
  const label = EVENT_LABEL[ev.eventType] || ev.eventType
  const visBadge = ev.networkVisibility === 'visible_to_gam_network' ? 'badge-blue' : 'badge-muted'
  const visLabel = ev.networkVisibility === 'visible_to_gam_network' ? 'network' : 'current relationship'

  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: '12px 14px', borderBottom: '1px solid var(--border-0)' }}>
      <div style={{ width: 8, height: 8, borderRadius: '50%', background: dotColor, marginTop: 6, flexShrink: 0 }} />
      <div style={{ flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
          <strong style={{ color: 'var(--text-0)' }}>{label}</strong>
          <span style={{ fontSize: '.7rem', color: 'var(--text-3)' }}>{new Date(ev.occurredAt).toLocaleDateString()}</span>
          <span className={`badge ${visBadge}`}>{visLabel}</span>
        </div>
        <div style={{ fontSize: '.75rem', color: 'var(--text-3)', marginTop: 2 }}>
          attested by {attestationLabel(ev.attestationSource)}
          {ev.dimensionTags?.length ? <> · tags: {ev.dimensionTags.join(', ')}</> : null}
        </div>
      </div>
    </div>
  )
}

function Kpi({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="card" style={{ padding: 16 }}>
      <div style={{ fontSize: '.7rem', color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 6 }}>{label}</div>
      <div style={{ fontFamily: 'var(--font-display)', fontSize: '1.6rem', fontWeight: 800, color: 'var(--text-0)', lineHeight: 1, marginBottom: 4 }}>{value}</div>
      <div style={{ fontSize: '.72rem', color: 'var(--text-3)' }}>{sub}</div>
    </div>
  )
}
