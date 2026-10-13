import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from 'react-query'
import { apiGet } from '../lib/api'
import { Plus, UserPlus, MailWarning } from 'lucide-react'
import { InviteTenantModal } from './InviteTenantModal'
import { usePerms } from '../lib/permissions'
import { SearchBox, PropertySelect } from '../components/ListControls'
import { healthColor } from '../lib/paymentStamps'


/**
 * S651 — mail that never arrived.
 *
 * Nic invited Arnoldo Arvizu to RV 39 three times and all three bounced. A
 * lease signing request to RV 08 bounced. Bounce events only ever raised a
 * GAM-side admin notification, so the landlord — the one person who can fix the
 * address — saw nothing, and could only conclude the tenant was ignoring them.
 * Five people at Mountain View are in that state right now.
 *
 * It sits above the tenant list because that is where the address gets fixed.
 * It renders nothing at all when nothing has bounced: an empty "all mail
 * delivered" card is noise that trains people to stop reading this spot.
 */
function UndeliveredEmailNotice() {
  const { data = [] } = useQuery<any[]>('undelivered-email',
    () => apiGet('/landlords/me/undelivered-email'), { retry: false })
  if (!data.length) return null

  return (
    <div className="card" style={{ marginBottom: 16, borderLeft: '3px solid var(--amber)' }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
        <MailWarning size={16} style={{ color: 'var(--amber)' }} />
        <b style={{ fontSize: '.92rem' }}>
          {data.length === 1 ? 'An email never reached someone' : `${data.length} people aren’t getting your email`}
        </b>
      </div>
      <div style={{ fontSize: '.78rem', color: 'var(--text-2)', lineHeight: 1.55, marginBottom: 10 }}>
        Mail to these addresses is not arriving, so invitations, reminders and signing requests
        are going nowhere. Check the spelling with them and update it here — resending to the
        same address cannot work.
      </div>
      {data.map((r: any) => (
        <div key={r.email} style={{ display: 'flex', justifyContent: 'space-between', gap: 10,
                                    padding: '6px 0', borderBottom: '1px solid var(--border-0)', fontSize: '.8rem' }}>
          <span>
            <span style={{ color: 'var(--text-0)', fontWeight: 600 }}>
              {[r.firstName, r.lastName].filter(Boolean).join(' ') || r.email}
            </span>
            {(r.unitNumber || r.invitedUnitNumber) && (
              <span style={{ color: 'var(--text-3)' }}>
                {' · '}Unit {r.unitNumber || r.invitedUnitNumber}
                {!r.unitNumber && r.invitedUnitNumber ? ' (invited)' : ''}
              </span>
            )}
            <div style={{ color: 'var(--text-3)', fontSize: '.72rem' }}>{r.email}</div>
          </span>
          <span style={{ color: 'var(--text-3)', fontSize: '.72rem', whiteSpace: 'nowrap', textAlign: 'right' }}>
            {/* 'suppressed' is the worst of these and reads as the mildest, so
                it gets the plainest words: nothing is being attempted at all. */}
            {r.outcome === 'suppressed'
              ? (r.suppressionOrigin === 'complaint' ? 'marked GAM as spam — nothing is being sent'
                                                     : 'nothing is being sent any more')
              : r.outcome === 'complained' ? 'marked as spam'
              : r.outcome === 'undeliverable' ? 'not sent — address is dead'
              : 'rejected'}
            <div>{new Date(r.decidedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</div>
          </span>
        </div>
      ))}
    </div>
  )
}

/** GET /tenants/health-by-unit: the health of the lease on each space. */
interface LeaseHealth { unitId: string; leaseId: string; percent: number | null; label: string }

/** Said on hover when the lease-by-lease health could not be read (the column shows a dash). */
export const HEALTH_NOT_LOADED = 'Payment health could not be loaded — refresh the page to try again.'

export function TenantsPage() {
  const [showInvite, setShowInvite] = useState(false)
  const [search, setSearch] = useState('')
  const [propertyId, setPropertyId] = useState('')
  const navigate = useNavigate()
  const { data: units = [], isLoading } = useQuery<any[]>('units', () => apiGet('/units'))
  const { can } = usePerms()
  // 10/13 (Nic): "Tenants list + tenant profile: split health BY LEASE." One
  // row per space, and each row's figure is the health of the LEASE on that
  // space (GET /tenants/health-by-unit — the Rent Roll's figure for that
  // household), so a person renting two spots on two leases reads each lease's
  // own number. null (GAM admin): the list's own column. Until it answers, a
  // dash — never the household figure in between; and a dash if it fails
  // (10/13 review: the household figure would read the same number on both of
  // a person's leases, undoing the split without a word), with why on hover.
  const leaseHealth = useQuery<LeaseHealth[] | null>('tenants-health-by-unit',
    () => apiGet<LeaseHealth[] | null>('/tenants/health-by-unit'), { retry: false })
  const healthOf = (u: any): { percent: number | null; label: string | null } => {
    if (leaseHealth.isLoading) return { percent: null, label: null }
    if (leaseHealth.error) return { percent: null, label: HEALTH_NOT_LOADED }
    if (leaseHealth.data == null) {
      return { percent: u.paymentHealth == null ? null : Number(u.paymentHealth), label: null }
    }
    const h = leaseHealth.data.find(x => x.unitId === u.id)
    return { percent: h?.percent ?? null, label: h?.label ?? null }
  }

  const allTenants = units.filter(u => u.tenantFirst)
  const propertyOptions = allTenants.map((u: any) => ({ id: u.propertyId, name: u.propertyName }))
  const q = search.trim().toLowerCase()
  const tenants = allTenants.filter((u: any) => {
    const matchSearch = q === '' ||
      `${u.tenantFirst} ${u.tenantLast}`.toLowerCase().includes(q) ||
      u.tenantEmail?.toLowerCase().includes(q) ||
      u.unitNumber?.toLowerCase().includes(q) ||
      u.propertyName?.toLowerCase().includes(q)
    const matchProperty = propertyId === '' || u.propertyId === propertyId
    return matchSearch && matchProperty
  })

  return (
    <div>
      <div className="page-header">
        <div><h1 className="page-title">Tenants</h1><p className="page-subtitle">{tenants.length === allTenants.length ? `${allTenants.length} active tenants` : `${tenants.length} of ${allTenants.length} active tenants`}</p></div>
        <div style={{ display: 'flex', gap: 8 }}>
          {can('tenants.onboard') && (
            <button className="btn btn-ghost" onClick={() => navigate('/tenant-onboarding')}>
              <UserPlus size={15} /> Onboard Existing Tenant
            </button>
          )}
          {can('tenants.invite') && (
            <button className="btn btn-primary" onClick={() => setShowInvite(true)}>
              <Plus size={15} /> Invite Tenant
            </button>
          )}
        </div>
      </div>
      <UndeliveredEmailNotice />

      <div className="filter-bar">
        <SearchBox value={search} onChange={setSearch} placeholder="Search tenants, units, properties…" />
        <PropertySelect value={propertyId} onChange={setPropertyId} properties={propertyOptions} />
      </div>

      {isLoading ? <div style={{color:'var(--text-3)',padding:32}}>Loading…</div> : (
        <div className="card" style={{padding:0,overflowX:'auto'}}>
          {/* S655 (Nic, 10/2): no SSI/SSDI column. "That's our check for the
              flex products" — GAM-side only. */}
          <table className="data-table" style={{minWidth:880}}>
            <thead><tr><th style={{width:'22%'}}>Tenant</th><th>Unit</th><th>Property</th><th title="Months the lease on this space paid on time since joining GAM — judged on the whole month's bill after its grace period; late fees never count as a bill; a month work trade covers counts as on time">Payment health</th><th>Rent</th><th>ACH</th></tr></thead>
            <tbody>
              {tenants.length ? tenants.map((u: any) => (
                <tr key={u.id} onClick={() => u.tenantId && navigate(`/tenants/${u.tenantId}`)} style={{ cursor: u.tenantId ? 'pointer' : 'default' }}>
                  <td><div style={{fontWeight:600,color:'var(--text-0)'}}>{u.tenantFirst} {u.tenantLast}</div><div style={{fontSize:'.72rem',color:'var(--text-3)'}}>{u.tenantEmail}</div></td>
                  <td className="mono">{u.unitNumber}</td>
                  <td style={{fontSize:'.82rem'}}>{u.propertyName}</td>
                  {/* S652 (Nic): the percentage on the first screen, between property
                      and rent. 10/12 (Nic): the one definition — months paid on
                      time since the household joined GAM (all time, per bill month).
                      10/13 (Nic): the lease on this space's own figure. */}
                  <td className="mono" title={healthOf(u).label ?? undefined}>{(() => {
                    const pct = healthOf(u).percent
                    return pct == null
                      ? <span style={{color:'var(--text-3)'}}>—</span>
                      : <span style={{fontWeight:700,color:healthColor(pct)}}>{pct}%</span>
                  })()}</td>
                  {/* 10/12 (Nic): the lease's rent, not the space's listed price (the Rent Roll's figure). */}
                  <td className="mono">{(u.leaseRentAmount ?? u.rentAmount) ? `$${Number(u.leaseRentAmount ?? u.rentAmount).toLocaleString()}` : '—'}
                    {u.workTradeRent && <div style={{fontSize:'.68rem',color:'var(--text-3)'}}>traded for work</div>}</td>
                  {/* S640 (Nic): a work-trade resident pays in hours and will
                      never link a bank, so "ACH pending" is a chore that can
                      never be finished. Say what is actually true of them. */}
                  <td>{u.workTradeRent
                    ? <span className="badge badge-gold">Work trade</span>
                    : <span className={`badge ${u.achVerified?'badge-green':'badge-amber'}`}>{u.achVerified?'Verified':'Pending'}</span>}</td>
                </tr>
              )) : (
                <tr><td colSpan={6} style={{textAlign:'center',color:'var(--text-3)',padding:32}}>{allTenants.length ? 'No tenants match your filters.' : 'No tenants yet.'}</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      {showInvite && <InviteTenantModal onClose={() => setShowInvite(false)} />}
    </div>
  )
}
