import { AddUnitModal } from './AddUnitModal'
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { useNavigate, Link, useSearchParams, useLocation } from 'react-router-dom'
import { humanize, UNIT_STATUS_LABEL, type UnitStatus } from '@gam/shared'
import { apiGet, apiPatch, apiPost, apiDelete } from '../lib/api'
import { usePerms } from '../lib/permissions'
import { PropertySelect } from '../components/ListControls'
import { Search, AlertTriangle, Shield, DoorOpen, Pencil, Trash2, Archive } from 'lucide-react'
import { toast, appConfirm, appPrompt } from '../components/dialogs'
const fmt = (n: any) => n != null ? `$${Number(n).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2})}` : '—'

const STATUS_COLORS: Record<string, string> = {
  active: 'badge-green',
  vacant: 'badge-muted', delinquent: 'badge-amber', suspended: 'badge-red',
  // S604: owner-occupied reads as a deliberate state, not an empty one — muted
  // would make it look identical to vacant, which is the confusion the status
  // exists to remove.
  owner_use: 'badge-blue',
}

export function UnitsPage() {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [showAddUnit, setShowAddUnit] = useState(false)
  const [search, setSearch] = useState('')
  // S527 W-4: dashboard KPI tiles land pre-filtered via ?status=<unit status>.
  const [params] = useSearchParams()
  const [filter, setFilter] = useState(() => {
    const s = params.get('status')
    // S536 (Nic): the dashboard eviction-mode alert links ?status=eviction.
    // Eviction mode is the paymentBlock flag, coupled 1:1 to the
    // 'suspended' unit status — land on the suspended filter, not "All".
    if (s === 'eviction') return 'suspended'
    return s && s in STATUS_COLORS ? s : 'all'
  })
  // S629 (Nic): "it needs to just revert back to the unit page on submission of
  // invites... there's no back button, so I have to click properties, then click
  // into a specific property, and then click into units." Onboarding a park is
  // one unit after another, so the invite flow returns here with the property
  // already selected.
  const [propertyId, setPropertyId] = useState(() => params.get('property') ?? '')
  // S605: retired units are excluded by the API unless asked for, so the working
  // list stays the live units. Turning this on shows the history alongside.
  const [showRetired, setShowRetired] = useState(false)
  // Carried on navigation state so the confirmation is not lost by leaving the
  // invite form — sending and then landing on a page with no acknowledgement
  // reads as though nothing happened.
  const invitedJustNow = (useLocation().state as any)?.invited as string[] | undefined
  const { data: units = [], isLoading } = useQuery<any[]>(
    ['units', showRetired],
    () => apiGet(showRetired ? '/units?includeRetired=true' : '/units'))
  const { can } = usePerms()

  const propertyOptions = units.map((u: any) => ({ id: u.propertyId, name: u.propertyName }))

  const setStatusMut = useMutation(
    ({ id, status }: { id: string; status: string }) => apiPatch(`/units/${id}/status`, { status }),
    { onSuccess: () => qc.invalidateQueries('units') }
  )

  // S604 (Nic): a unit's number was permanent and there was no way to remove one
  // created by mistake. Rename is safe (everything references unit_id); delete
  // is refused server-side the moment the unit has any history.
  const renameMut = useMutation(
    ({ id, unitNumber }: { id: string; unitNumber: string }) =>
      apiPatch(`/units/${id}/number`, { unitNumber }),
    { onSuccess: () => qc.invalidateQueries('units'),
      onError: (e: any) => toast.error(e?.response?.data?.error || 'Could not rename the unit') }
  )
  const deleteMut = useMutation(
    (id: string) => apiDelete(`/units/${id}`),
    { onSuccess: () => { toast('Unit deleted'); qc.invalidateQueries('units') },
      onError: (e: any) => toast.error(e?.response?.data?.error || 'Could not delete the unit') }
  )

  const doRename = async (u: any) => {
    const next = await appPrompt(`Rename unit "${u.unitNumber}" — unit numbers are unique per property, so use a prefix (RV 01 / MH 01) if two types share a number.`,
      { title: 'Rename unit', defaultValue: u.unitNumber })
    if (next && next.trim() && next.trim() !== u.unitNumber) {
      renameMut.mutate({ id: u.id, unitNumber: next.trim() })
    }
  }
  const doDelete = async (u: any) => {
    const ok = await appConfirm(
      `Delete unit "${u.unitNumber}"? This only works for a unit with no leases, payments, bookings or meters — anything with history must be taken out of service instead.`,
      { danger: true, confirmLabel: 'Delete unit' })
    if (ok) deleteMut.mutate(u.id)
  }

  // S605 (Nic): RETIRE & REPLACE. Once a unit carries data its number is locked,
  // because nothing snapshots unit_number — a rename would rewrite how years of
  // invoices display while the signed lease PDFs keep the old number. So the one
  // physical space becomes two records: retire the old, create the replacement
  // under the new number, linked both ways.
  const retireMut = useMutation(
    ({ id, unitNumber }: { id: string; unitNumber: string }) =>
      apiPost(`/units/${id}/retire`, { unitNumber }),
    { onSuccess: (r: any) => {
        toast(`Retired — replaced by ${r?.replacement?.unitNumber ?? 'the new unit'}`)
        qc.invalidateQueries('units'); qc.invalidateQueries('dashboard')
      },
      onError: (e: any) => toast.error(e?.response?.data?.error || 'Could not retire the unit') }
  )
  const doRetire = async (u: any) => {
    const next = await appPrompt(
      `Retire "${u.unitNumber}" and create its replacement under a new number. The old unit keeps all its history — past invoices, payments and signed leases stay exactly as they were — and the new unit inherits its type, rates and site details.`,
      { title: 'Retire & replace unit', defaultValue: u.unitNumber })
    if (next && next.trim() && next.trim() !== u.unitNumber) {
      retireMut.mutate({ id: u.id, unitNumber: next.trim() })
    }
  }

  const filtered = units.filter((u: any) => {
    const matchSearch = search === '' ||
      u.unitNumber.toLowerCase().includes(search.toLowerCase()) ||
      u.propertyName?.toLowerCase().includes(search.toLowerCase()) ||
      `${u.tenantFirst} ${u.tenantLast}`.toLowerCase().includes(search.toLowerCase())
    const matchFilter = filter === 'all' || u.status === filter
    const matchProperty = propertyId === '' || u.propertyId === propertyId
    return matchSearch && matchFilter && matchProperty
  })

  const evictionUnits = units.filter((u: any) => u.paymentBlock)

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">Units</h1>
          <p className="page-subtitle" style={{ display:"flex", alignItems:"center", gap:6 }}>{units.length} total units · <Link to="/properties" style={{ fontSize:'.72rem', color:'var(--gold)', fontWeight:600 }}>+ Add Units Here</Link> · {units.filter((u: any) => u.status === 'active').length} active</p>
        </div>
      </div>

      {evictionUnits.length > 0 && (
        <div className="alert alert-danger">
          <AlertTriangle size={16} />
          <div><strong>{evictionUnits.length} unit(s) in Eviction Mode.</strong> All tenant ACH hard-blocked. Warning: in many jurisdictions, accepting rent while pursuing eviction may waive your right to proceed. Check your local laws before accepting any payment.</div>
        </div>
      )}

      {invitedJustNow?.length ? (
        <div style={{ background:'rgba(38,167,90,.08)', border:'1px solid rgba(38,167,90,.3)', borderRadius:8,
                      padding:'10px 14px', marginBottom:14, fontSize:'.82rem', color:'var(--text-1)' }}>
          <strong style={{ color:'var(--green)' }}>Invited:</strong> {invitedJustNow.join(', ')}. They each get a
          portal invite by email; the lease drafts once everyone on that unit accepts. Pick the next unit below.
        </div>
      ) : null}

      <div className="filter-bar">
        <div className="search-wrap">
          <Search className="search-icon" />
          <input className="search-input" placeholder="Search units, properties, tenants..." value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <PropertySelect value={propertyId} onChange={setPropertyId} properties={propertyOptions} />
        {['all', 'active', 'vacant', 'delinquent', 'suspended'].map(s => (
          <button key={s} className={`btn btn-sm ${filter === s ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setFilter(s)}>
            {s === 'all' ? 'All' : humanize(s)}
          </button>
        ))}
        <button className={`btn btn-sm ${showRetired ? 'btn-primary' : 'btn-ghost'}`}
          title="Show units that were retired and replaced — history only"
          onClick={() => setShowRetired(v => !v)}>
          <Archive size={12} /> Retired
        </button>
      </div>

      {isLoading ? (
        <div className="card"><div style={{ color: 'var(--text-3)', textAlign: 'center', padding: 32 }}>Loading units...</div></div>
      ) : filtered.length === 0 ? (
        <div className="empty-state"><DoorOpen size={48} /><h3>No units found</h3><p>Add your first unit to get started.</p></div>
      ) : (
        <div className="card" style={{ padding: 0 }}>
          <div className="data-table-wrap">
            <table className="data-table">
              <thead><tr>
                <th>Unit</th><th>Property</th><th>Tenant</th><th>Rent</th><th>Status</th><th>Eviction</th><th></th>
              </tr></thead>
              <tbody>
                {filtered.map((u: any) => (
                  <tr key={u.id} onClick={() => navigate('/units/' + u.id)} style={{ cursor: 'pointer' }}>
                    <td>
                      <span className="mono" style={{ color: u.retiredAt ? 'var(--text-3)' : 'var(--text-0)', fontWeight: 600,
                        textDecoration: u.retiredAt ? 'line-through' : undefined }}>{u.unitNumber}</span>
                      {/* S605: a retired unit is history — say so plainly and point
                          at the record that took its place. */}
                      {u.retiredAt && (
                        <span className="badge badge-muted" style={{ marginLeft: 6, fontSize: '.62rem' }}>RETIRED</span>
                      )}
                    </td>
                    <td style={{ fontSize: '.82rem' }}>{u.propertyName}<br /><span style={{ color: 'var(--text-3)', fontSize: '.72rem' }}>{u.city}, {u.state}</span></td>
                    <td style={{ fontSize: '.82rem' }}>
                      {u.tenantFirst
                        ? <><span style={{ color: 'var(--text-0)' }}>{u.tenantFirst} {u.tenantLast}</span><br /><span style={{ color: 'var(--text-3)', fontSize: '.72rem' }}>{u.tenantEmail}</span></>
                        /* S604: an owner_use unit has no tenant BY DESIGN — printing
                           "Vacant" here would contradict its own status column. */
                        : <span style={{ color: 'var(--text-3)' }}>{u.status === 'owner_use' ? 'Owner-occupied' : 'Vacant'}</span>}
                    </td>
                    <td className="mono">{fmt(u.rentAmount)}</td>
                    <td onClick={e => e.stopPropagation()}>
                      {can('units.set_status') && (
                        <select value={u.status} onChange={e => setStatusMut.mutate({ id: u.id, status: e.target.value })}
                          style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '.75rem', color: 'inherit', padding: 0 }}>
                          {/* S554 (landlord button-sweep #9): must send real UNIT_STATUSES enum
                              values — the old occupied/maintenance/eviction options 400'd (zod rejects).
                              occupied→active, eviction→suspended, maintenance dropped; delinquent is
                              system-derived from payment state, not manually set here.
                              S604: 'suspended' REMOVED — the route rejects it outright ("use eviction
                              mode"), so picking it always 400'd. owner_use added (owner-occupied). */}
                          {['vacant','available','active','owner_use'].map(s => <option key={s} value={s}>{UNIT_STATUS_LABEL[s as UnitStatus]}</option>)}
                        </select>
                      )}
                      <span className={'badge ' + (STATUS_COLORS[u.status] || 'badge-muted')} style={{ marginLeft: 4 }}>{UNIT_STATUS_LABEL[u.status as UnitStatus] ?? humanize(u.status)}</span>
                    </td>
                    <td>
                      {u.paymentBlock
                        ? <span className="badge badge-red"><Shield size={10} /> BLOCKED</span>
                        : <span style={{ color: 'var(--text-3)', fontSize: '.75rem' }}>-</span>}
                    </td>
                    {/* S604: rename + delete. Delete is refused server-side the
                        moment the unit has history — GAM keeps records. */}
                    <td onClick={e => e.stopPropagation()} style={{ whiteSpace: 'nowrap' }}>
                      {/* A retired unit is a closed record — no actions on it. */}
                      {can('units.edit') && !u.retiredAt && (
                        <>
                          <button className="btn btn-ghost btn-sm" style={{ padding: '2px 8px' }}
                            title="Rename this unit (only before it has history)" onClick={() => doRename(u)}>
                            <Pencil size={12} />
                          </button>
                          <button className="btn btn-ghost btn-sm" style={{ padding: '2px 8px' }}
                            title="Retire this unit and replace it under a new number" onClick={() => doRetire(u)}>
                            <Archive size={12} />
                          </button>
                          <button className="btn btn-ghost btn-sm" style={{ padding: '2px 8px' }}
                            title="Delete this unit (only if it has no history)" onClick={() => doDelete(u)}>
                            <Trash2 size={12} />
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ padding: '10px 16px', borderTop: '1px solid var(--border-0)', fontSize: '.75rem', color: 'var(--text-3)' }}>
            Click any row to open unit details and manage eviction mode
          </div>
        </div>
      )}
      {showAddUnit && <AddUnitModal onClose={() => setShowAddUnit(false)} />}
    </div>
  )
}
