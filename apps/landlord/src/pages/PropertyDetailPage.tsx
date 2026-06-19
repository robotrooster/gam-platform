import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient, useMutation } from 'react-query'
import { apiGet, apiPatch } from '../lib/api'
import { ArrowLeft, Plus, DoorOpen, DollarSign, Building2, MapPin, UserCheck } from 'lucide-react'
import { AddUnitModal } from './AddUnitModal'
import { PropertyFeeScheduleSection } from './PropertyFeeScheduleSection'
import { PropertyAgentPermissionsSection } from './PropertyAgentPermissionsSection'
import { LawWarningBanner } from '../components/LawWarningBanner'
const fmt = (n: any) => n != null ? `$${Number(n).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2})}` : '—'

const STATUS_COLORS: Record<string,string> = {
  active:'badge-green', direct_pay:'badge-blue',
  vacant:'badge-muted', delinquent:'badge-amber', suspended:'badge-red'
}

export function PropertyDetailPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [showAddUnit, setShowAddUnit] = useState(false)

  const { data: property, isLoading: propLoading } = useQuery(
    ['property', id], () => apiGet<any>(`/properties/${id}`)
  )
  const { data: units = [], isLoading: unitsLoading } = useQuery<any[]>(
    ['property-units', id], () => apiGet(`/units?propertyId=${id}`)
  )

  if (propLoading) return <div style={{ color:'var(--text-3)', padding:32 }}>Loading…</div>
  if (!property) return <div className="empty-state"><h3>Property not found</h3></div>

  const occupied  = (units as any[]).filter(u => u.tenantId).length
  const revenue   = (units as any[]).filter(u => u.tenantId).reduce((s,u) => s + parseFloat(u.rentAmount||0), 0)
  const occupancy = units.length > 0 ? Math.round((occupied / units.length) * 100) : 0
  const maxRevenue  = (units as any[]).reduce((s, u) => s + parseFloat(u.rentAmount||0), 0)

  return (
    <div>
      {/* Header */}
      <div className="page-header">
        <div style={{ display:'flex', alignItems:'center', gap:12 }}>
          <button className="btn btn-ghost btn-sm" onClick={() => navigate('/properties')}><ArrowLeft size={15} /></button>
          <div style={{ display:'flex', alignItems:'center', gap:12 }}>
            <div style={{ width:44, height:44, borderRadius:10, background:'rgba(201,162,39,.1)', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
              <Building2 size={20} style={{ color:'var(--gold)' }} />
            </div>
            <div>
              <h1 className="page-title" style={{ marginBottom:2 }}>{property.name}</h1>
              <p className="page-subtitle" style={{ display:'flex', alignItems:'center', gap:4 }}>
                <MapPin size={11} /> {property.street1}, {property.city}, {property.state} {property.zip}
              </p>
            </div>
          </div>
        </div>
        <button className="btn btn-primary" onClick={() => setShowAddUnit(true)}>
          <Plus size={15} /> Add Unit
        </button>
      </div>

      {/* S486: state-law warnings recomputed against the persisted
          property defaults. Late-fee config flows into new leases at
          this property via the LeaseFormModal default-pull, so a
          hedged factual notice here catches the landlord before the
          value propagates to new leases. Auto-hides when empty. */}
      <LawWarningBanner warnings={property.stateLawWarnings} />

      {/* Stats */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(5,1fr)', gap:12, marginBottom:24 }}>
        {[
          { label:'Total Units',      val: units.length,              color:'var(--text-0)' },
          { label:'Occupied',         val: `${occupied} / ${units.length}`, color:'var(--green)' },
          { label:'Occupancy',        val: `${occupancy}%`,           color: occupancy >= 80 ? 'var(--green)' : 'var(--amber)' },
          { label:'Monthly Revenue',  val: fmt(revenue),   color:'var(--gold)' },
          { label:'Max Potential',      val: fmt(maxRevenue), color:'var(--text-3)' },
        ].map(s => (
          <div key={s.label} className="card" style={{ padding:'14px 16px' }}>
            <div style={{ fontSize:'.62rem', fontWeight:700, color:'var(--text-3)', textTransform:'uppercase', letterSpacing:'.08em', marginBottom:6 }}>{s.label}</div>
            <div style={{ fontFamily:'var(--font-mono)', fontSize:'1rem', fontWeight:700, color:s.color }}>{s.val}</div>
          </div>
        ))}
      </div>

      {/* S159: PM Linkage section — visible whether or not a PM is set;
            CTA to /pm-invitations is the discoverability path for landlords
            without a PM yet. */}
      <PmLinkageCard
        propertyId={property.id}
        propertyName={property.name}
        pmCompanyId={property.pmCompanyId ?? null}
        pmFeePlanId={property.pmFeePlanId ?? null}
      />

      {/* S184: individual day-to-day manager assignment. Hidden when a PM
            company is set — that takes priority in the responsible-party
            resolver. */}
      {!property.pmCompanyId && <PropertyManagerCard propertyId={property.id} />}

      {/* Occupancy bar */}
      <div style={{ marginBottom:24 }}>
        <div style={{ display:'flex', justifyContent:'space-between', fontSize:'.72rem', color:'var(--text-3)', marginBottom:6 }}>
          <span>Occupancy Rate</span>
          <span style={{ color: occupancy >= 80 ? 'var(--green)' : 'var(--amber)', fontWeight:700 }}>{occupancy}%</span>
        </div>
        <div style={{ height:6, background:'var(--bg-3)', borderRadius:3, overflow:'hidden' }}>
          <div style={{ height:'100%', width:`${occupancy}%`, background: occupancy >= 80 ? 'var(--green)' : 'var(--amber)', borderRadius:3, transition:'width .3s' }} />
        </div>
      </div>

      {/* Amenities */}
      {property.amenities?.length > 0 && (
        <div style={{ marginBottom:20, display:'flex', flexWrap:'wrap', gap:6 }}>
          {property.amenities.map((a: string) => (
            <span key={a} style={{ fontSize:'.72rem', padding:'3px 10px', borderRadius:20, background:'var(--bg-2)', border:'1px solid var(--border-0)', color:'var(--text-3)' }}>{a}</span>
          ))}
        </div>
      )}

      {/* Finances — only visible to property owner / manager / admin */}
      <PropertyFinances propertyId={id!} />

      {/* Units */}
      <div className="card" style={{ padding:0 }}>
        {unitsLoading ? (
          <div style={{ padding:32, textAlign:'center', color:'var(--text-3)' }}>Loading units…</div>
        ) : units.length === 0 ? (
          <div className="empty-state" style={{ padding:48 }}>
            <DoorOpen size={40} />
            <h3>No units yet</h3>
            <p>Add your first unit to this property.</p>
            <button className="btn btn-primary" onClick={() => setShowAddUnit(true)}><Plus size={14} /> Add Unit</button>
          </div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Unit</th><th>Tenant</th><th>Rent</th><th>Status</th>
                <th>Bed/Bath</th><th>Sq Ft</th><th>On-Time Pay</th><th></th>
              </tr>
            </thead>
            <tbody>
              {(units as any[]).map((u: any) => (
                <tr key={u.id} style={{ cursor:'pointer' }} onClick={() => navigate(`/units/${u.id}`)}>
                  <td>
                    <div style={{ fontFamily:'var(--font-mono)', fontWeight:700, color:'var(--text-0)' }}>{u.unitNumber}</div>
                  </td>
                  <td>
                    {u.tenantFirst ? (
                      <div>
                        <div style={{ fontSize:'.82rem', fontWeight:600, color:'var(--text-0)' }}>{u.tenantFirst} {u.tenantLast}</div>
                        <div style={{ fontSize:'.68rem', color:'var(--text-3)' }}>{u.tenantEmail}</div>
                      </div>
                    ) : (
                      <span style={{ color:'var(--text-3)', fontSize:'.78rem' }}>Vacant</span>
                    )}
                  </td>
                  <td className="mono">{fmt(u.rentAmount)}/mo</td>
                  <td><span className={`badge ${STATUS_COLORS[u.status] || 'badge-muted'}`}>{u.status?.replace('_',' ')}</span></td>
                  <td style={{ fontSize:'.78rem' }}>{u.bedrooms}bd / {u.bathrooms}ba</td>
                  <td className="mono" style={{ fontSize:'.75rem' }}>{u.sqft ? u.sqft.toLocaleString() : '—'}</td>
                  <td>
                    {u.onTimePayActive
                      ? <span className="badge badge-green">Active</span>
                      : <span className="badge badge-muted">Inactive</span>
                    }
                  </td>
                  <td onClick={e => e.stopPropagation()}>
                    <button className="btn btn-ghost btn-sm" onClick={() => navigate(`/units/${u.id}`)}>View</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {showAddUnit && (
        <AddUnitModal
          preselectedPropertyId={id}
          onClose={() => { setShowAddUnit(false); qc.invalidateQueries(['property-units', id]) }}
        />
      )}
    </div>
  )
}

const LEDGER_TYPE_LABELS: Record<string, string> = {
  allocation_owner_share: 'Owner share',
  allocation_manager_fee: 'Manager fee',
  withdrawal_auto: 'Auto Friday payout',
  withdrawal_manual: 'Manual withdrawal',
  withdrawal_otp: 'OTP withdrawal',
  reserve_fund_replenishment: 'Reserve fund',
  adjustment: 'Adjustment',
}

function PropertyFinances({ propertyId }: { propertyId: string }) {
  const fmtCurr = (n: any) => n != null
    ? `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : '—'
  const fmtDate = (s: string) => new Date(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })

  const { data, isLoading } = useQuery<any>(
    ['property-finances', propertyId],
    () => apiGet(`/users/me/finances?propertyId=${propertyId}&limit=50`),
    { retry: false }
  )

  if (isLoading) return null
  if (!data) return null

  const propertyTotal = (data.entries as any[]).reduce(
    (s, e) => s + parseFloat(e.amount), 0
  )

  return (
    <div style={{ marginBottom: 24 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <DollarSign size={16} color="var(--gold)" />
        <h2 style={{ fontSize: '1rem', fontWeight: 600, margin: 0 }}>My Earnings on This Property</h2>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 14 }}>
        <div className="card" style={{ padding: '14px 16px' }}>
          <div style={{ fontSize: '.62rem', fontWeight: 700, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.08em', marginBottom: 6 }}>
            Net Posted (this property)
          </div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: '1rem', fontWeight: 700, color: 'var(--gold)' }}>
            {fmtCurr(propertyTotal)}
          </div>
        </div>
        <div className="card" style={{ padding: '14px 16px' }}>
          <div style={{ fontSize: '.62rem', fontWeight: 700, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.08em', marginBottom: 6 }}>
            Your Current Balance (all properties)
          </div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: '1rem', fontWeight: 700, color: 'var(--text-0)' }}>
            {fmtCurr(data.currentBalance)}
          </div>
        </div>
      </div>

      {data.entries.length === 0 ? (
        <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-3)', fontSize: '.82rem', background: 'var(--bg-1)', border: '1px solid var(--border-0)', borderRadius: 10 }}>
          No ledger activity yet for this property.
        </div>
      ) : (
        <div className="card" style={{ padding: 0 }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>Date</th><th>Type</th><th style={{ textAlign: 'right' }}>Amount</th><th>Notes</th>
              </tr>
            </thead>
            <tbody>
              {(data.entries as any[]).map((e: any) => (
                <tr key={e.id}>
                  <td style={{ fontSize: '.78rem', color: 'var(--text-3)' }}>{fmtDate(e.createdAt)}</td>
                  <td style={{ fontSize: '.78rem' }}>{LEDGER_TYPE_LABELS[e.type] || e.type}</td>
                  <td className="mono" style={{ textAlign: 'right', color: parseFloat(e.amount) >= 0 ? 'var(--green)' : 'var(--red)' }}>
                    {parseFloat(e.amount) >= 0 ? '+' : ''}{fmtCurr(e.amount)}
                  </td>
                  <td style={{ fontSize: '.72rem', color: 'var(--text-3)' }}>{e.notes || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <PropertyFeeScheduleSection propertyId={data.id} />

      <PropertyAgentPermissionsSection propertyId={data.id} />
    </div>
  )
}

// S159: PM linkage card. Two states:
//   linked  — show PM company name + fee plan + "Manage" CTA
//   unlinked — short pitch + "Send invitation" CTA pre-routing to /pm-invitations
function PmLinkageCard({
  propertyId, propertyName, pmCompanyId, pmFeePlanId,
}: {
  propertyId: string
  propertyName: string
  pmCompanyId: string | null
  pmFeePlanId: string | null
}) {
  void propertyId; void propertyName
  const navigate = useNavigate()

  const pmQ = useQuery<{ id: string; name: string; status: string } | null>(
    ['pm-company-name', pmCompanyId],
    async () => pmCompanyId
      ? apiGet<{ id: string; name: string; status: string }>(`/pm/companies/${pmCompanyId}`)
      : null,
    { enabled: !!pmCompanyId, retry: false },
  )
  const fpQ = useQuery<Array<{ id: string; name: string; feeType: string }> | null>(
    ['pm-fee-plans-for-company', pmCompanyId],
    async () => pmCompanyId
      ? apiGet<Array<{ id: string; name: string; feeType: string }>>(`/pm/companies/${pmCompanyId}/fee-plans`)
      : null,
    { enabled: !!pmCompanyId && !!pmFeePlanId, retry: false },
  )
  const feePlan = (fpQ.data ?? []).find(p => p.id === pmFeePlanId)

  if (pmCompanyId) {
    return (
      <div className="card" style={{ padding: 14, marginBottom: 20, background: 'rgba(201,162,39,.04)', border: '1px solid rgba(201,162,39,.25)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16 }}>
          <div>
            <div style={{ fontSize: '.7rem', fontWeight: 700, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.08em', marginBottom: 4 }}>
              Managed by
            </div>
            <div style={{ fontWeight: 700, fontSize: '1rem', color: 'var(--gold)' }}>
              {pmQ.isLoading ? '…' : pmQ.data?.name ?? '— PM company unavailable —'}
            </div>
            {feePlan && (
              <div style={{ fontSize: '.78rem', color: 'var(--text-2)', marginTop: 4 }}>
                Fee plan: <strong>{feePlan.name}</strong> <span style={{ color: 'var(--text-3)' }}>({feePlan.feeType})</span>
              </div>
            )}
            {!feePlan && pmFeePlanId && (
              <div style={{ fontSize: '.72rem', color: 'var(--text-3)', marginTop: 4, fontStyle: 'italic' }}>
                Fee plan {pmFeePlanId.slice(0,8)}… (PM company has restricted access)
              </div>
            )}
            {!pmFeePlanId && (
              <div style={{ fontSize: '.72rem', color: 'var(--text-3)', marginTop: 4, fontStyle: 'italic' }}>
                View-only linkage — no fee plan attached, no money routing changes.
              </div>
            )}
          </div>
          <button className="btn btn-ghost btn-sm" onClick={() => navigate('/pm-invitations')}>
            Manage
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="card" style={{ padding: 14, marginBottom: 20 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16 }}>
        <div>
          <div style={{ fontWeight: 600, color: 'var(--text-0)' }}>No PM Company Linked</div>
          <div style={{ fontSize: '.78rem', color: 'var(--text-3)', marginTop: 4 }}>
            Self-managed. Link a third-party PM company to route rent + maintenance through them.
          </div>
        </div>
        <button className="btn btn-primary btn-sm" onClick={() => navigate('/pm-invitations')}>
          Invite PM Company
        </button>
      </div>
    </div>
  )
}

// S184: individual property-manager assignment card. Pairs with backend
// PATCH /properties/:id/manager. Reads /:id/eligible-managers for the
// dropdown options (owner as 'self' + every property_manager_scopes
// holder covering this property under this landlord). Sets
// properties.managedByUserId, which the responsible-party resolver
// then routes routine notifications through.
//
// Hidden by parent when pm_company_id is set — PM company takes
// precedence in the resolver and individual manager assignment is
// meaningless under a contract.
function PropertyManagerCard({ propertyId }: { propertyId: string }) {
  const qc = useQueryClient()
  const [selected, setSelected] = useState<string>('')
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)

  type EligibleManager = {
    userId: string
    email: string
    firstName: string | null
    lastName: string | null
    role: 'self' | 'manager'
  }
  type EligibleResponse = {
    currentManagedByUserId: string
    ownerUserId: string
    owner: EligibleManager | null
    managers: EligibleManager[]
  }

  const { data, isLoading } = useQuery<EligibleResponse>(
    ['eligible-managers', propertyId],
    () => apiGet(`/properties/${propertyId}/eligible-managers`),
  )

  // Sync local selection from server payload on first load + after save.
  useEffect(() => {
    if (data) setSelected(data.currentManagedByUserId)
  }, [data?.currentManagedByUserId])

  const saveMut = useMutation(
    (userId: string | null) => apiPatch(`/properties/${propertyId}/manager`, { userId }),
    {
      onSuccess: () => {
        setError(null)
        setSuccess(true)
        qc.invalidateQueries(['property', propertyId])
        qc.invalidateQueries(['eligible-managers', propertyId])
        setTimeout(() => setSuccess(false), 2500)
      },
      onError: (e: any) => {
        setError(e?.response?.data?.error || 'Failed to update manager')
        setSuccess(false)
      },
    },
  )

  if (isLoading) return null
  if (!data) return null

  const formatName = (m: EligibleManager) => {
    const name = [m.firstName, m.lastName].filter(Boolean).join(' ')
    return name ? `${name} (${m.email})` : m.email
  }

  const owner = data.owner
  const managers = data.managers
  const currentlyDelegated = data.currentManagedByUserId !== data.ownerUserId
  const dirty = selected !== data.currentManagedByUserId

  return (
    <div className="card" style={{ padding: 14, marginBottom: 20 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, marginBottom: 12 }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <UserCheck size={14} style={{ color: 'var(--gold)' }} />
            <div style={{ fontSize: '.7rem', fontWeight: 700, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.08em' }}>
              Day-to-day manager
            </div>
          </div>
          <div style={{ fontSize: '.78rem', color: 'var(--text-3)', maxWidth: 420 }}>
            Routes routine notifications (lease expiring, rent collected, etc.) for this property. Owner-financial alerts (over-threshold approvals, bank account) always go to the owner regardless.
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <select
          className="input"
          value={selected}
          onChange={(e) => setSelected(e.target.value)}
          style={{ minWidth: 320, flex: '0 1 auto' }}
        >
          {owner && (
            <option value={owner.userId}>
              Self-managed — {formatName(owner)}
            </option>
          )}
          {managers.length === 0 ? (
            <option disabled>No property-manager scope holders. Add via Team page first.</option>
          ) : (
            managers.map((m) => (
              <option key={m.userId} value={m.userId}>
                {formatName(m)}
              </option>
            ))
          )}
        </select>

        <button
          className="btn btn-primary btn-sm"
          disabled={!dirty || saveMut.isLoading}
          onClick={() => {
            const userId = selected === data.ownerUserId ? null : selected
            saveMut.mutate(userId)
          }}
        >
          {saveMut.isLoading ? 'Saving…' : 'Save'}
        </button>

        {currentlyDelegated && (
          <span className="badge badge-blue" style={{ fontSize: '.7rem' }}>
            Delegated
          </span>
        )}

        {success && (
          <span style={{ color: 'var(--green)', fontSize: '.78rem' }}>Saved.</span>
        )}
      </div>

      {error && (
        <div style={{ marginTop: 10, padding: 10, background: 'rgba(239,68,68,.08)', border: '1px solid rgba(239,68,68,.3)', borderRadius: 6, color: 'var(--red)', fontSize: '.82rem' }}>
          {error}
        </div>
      )}
    </div>
  )
}
