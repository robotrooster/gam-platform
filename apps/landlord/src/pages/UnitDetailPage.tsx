import { useState, useRef, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { apiGet, apiPost, apiPatch, apiDelete, apiPut } from '../lib/api'
import { usePerms } from '../lib/permissions'
import { ArrowLeft, Shield, AlertTriangle, Camera, Trash2, ExternalLink, Lock, Pencil } from 'lucide-react'
import { UNIT_TYPE_LABEL, UNIT_TYPE_HAS_BEDROOMS, UNIT_TYPES, FLOOR_LEVELS, FLOOR_LEVEL_LABEL, MAX_INSPECTION_LIVING_AREAS, featuresForType, resolveUnitFeatures, humanize, listingMinPhotos, unitSubtypeFactsLabel, type PropertyUnitSubtype, type UnitType, type FloorLevel } from '@gam/shared'
import { toast, appConfirm } from '../components/dialogs'

const fmt = (n: any) => n != null ? `$${Number(n).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2})}` : '—'
const API_URL = (import.meta as any).env?.VITE_API_URL || 'http://localhost:4000'
const LISTINGS_URL = (import.meta as any).env?.VITE_LISTINGS_APP_URL || 'http://localhost:3008'

// S535: photos are no longer static-served — /api/properties/
// unit-photo-files/:filename requires the Bearer token, which an <img>
// tag can't carry. Fetch with auth, render via a blob object-URL.
function AuthImg({ url }: { url: string }) {
  const [src, setSrc] = useState<string | null>(null)
  useEffect(() => {
    let objectUrl: string | null = null
    let cancelled = false
    const token = localStorage.getItem('gam_token') || ''
    fetch(`${API_URL}${url}`, { headers: { Authorization: 'Bearer ' + token } })
      .then(r => r.ok ? r.blob() : null)
      .then(b => {
        if (!b || cancelled) return
        objectUrl = URL.createObjectURL(b)
        setSrc(objectUrl)
      })
      .catch(() => {})
    return () => { cancelled = true; if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [url])
  if (!src) return <div style={{ width: '100%', height: '100%', background: 'var(--bg-2)' }} />
  return <img src={src} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
}

export function UnitDetailPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [evictModal, setEvictModal] = useState(false)
  const [evictConfirm, setEvictConfirm] = useState(false)
  const [listingForm, setListingForm] = useState({ availableDate: '', listingDescription: '', listedVacant: false, bedrooms: '', bathrooms: '', sqft: '' })
  const [listingInit, setListingInit] = useState(false)
  const [savingListing, setSavingListing] = useState(false)
  const [uploadingPhotos, setUploadingPhotos] = useState(false)
  const [listingMsg, setListingMsg] = useState('')
  const [activateModal, setActivateModal] = useState(false)
  const [schedChoice, setSchedChoice] = useState<'now'|'later'>('now')
  const [schedLocal, setSchedLocal] = useState('')  // yyyy-MM-ddTHH:mm local to unit's state tz
  const fileRef = useRef<HTMLInputElement>(null)

  const { data: unit, isLoading } = useQuery(['unit', id], () => apiGet<any>('/units/' + id))
  const { data: econ } = useQuery(['unit-econ', id], () => apiGet<any>('/units/' + id + '/economics'))
  const { data: maintenance = [] } = useQuery(['unit-maint', id], () => apiGet<any[]>('/maintenance?unitId=' + id))

  const markAvailMut = useMutation(() => apiPost('/units/' + id + '/mark-available', {}), { onSuccess: () => qc.invalidateQueries(['unit', id]) })
  const markVacantMut = useMutation(() => apiPost('/units/' + id + '/mark-vacant', {}), { onSuccess: () => qc.invalidateQueries(['unit', id]) })
  const activateMut = useMutation(
    (body: { scheduledFor?: string }) => apiPost('/units/' + id + '/activate', body),
    { onSuccess: () => { qc.invalidateQueries(['unit', id]); setActivateModal(false); setSchedLocal(''); setSchedChoice('now') } }
  )
  const cancelSchedMut = useMutation(() => apiPost('/units/' + id + '/cancel-scheduled-activation', {}), { onSuccess: () => qc.invalidateQueries(['unit', id]) })
  // S573: ONE consolidated unit editor. Every setting is editable here, but only
  // while the unit is between leases; an active/pending lease locks the whole card.
  const [editing, setEditing] = useState(false)
  const [editForm, setEditForm] = useState<any>(null)
  const [detailsErr, setDetailsErr] = useState('')
  const detailsMut = useMutation(
    (body: any) => apiPatch('/units/' + id + '/details', body),
    {
      onSuccess: () => { setDetailsErr(''); setEditing(false); qc.invalidateQueries(['unit', id]) },
      onError: (e: any) => setDetailsErr(e?.response?.data?.error || e?.response?.data?.message || 'Could not save unit settings'),
    },
  )
  const startEdit = () => {
    if (!unit) return
    setDetailsErr('')
    setEditForm({
      unitType: unit.unitType || 'apartment',
      bedrooms: String(unit.bedrooms ?? ''),
      bathrooms: String(unit.bathrooms ?? ''),
      sqft: unit.sqft != null ? String(unit.sqft) : '',
      rentAmount: unit.rentAmount != null ? String(unit.rentAmount) : '',
      securityDeposit: unit.securityDeposit != null ? String(unit.securityDeposit) : '',
      dwellingOwnership: unit.dwellingOwnership || 'tenant',
      ownerHouseholdSize: String(unit.ownerHouseholdSize ?? 1),
      isMultiLevel: !!unit.isMultiLevel,
      isAdaAccessible: !!unit.isAdaAccessible,
      floorLevel: unit.floorLevel || '',
      livingAreas: unit.livingAreas != null ? String(unit.livingAreas) : '1',
      features: resolveUnitFeatures(unit.unitType, unit.features || {}),
      occupancyMode: unit.occupancyMode || 'whole_unit',
      rvSiteLayout: unit.rvSiteLayout || 'none',
      rvAmpService: unit.rvAmpService || 'none',
      storageSize: unit.storageSize || '',
      lotRentAmount: unit.lotRentAmount != null ? String(unit.lotRentAmount) : '',
    })
    setEditing(true)
  }
  const saveDetails = () => {
    const f = editForm
    const num = (v: string) => v === '' ? undefined : Number(v)
    detailsMut.mutate({
      unitType: f.unitType,
      bedrooms: num(f.bedrooms),
      bathrooms: num(f.bathrooms),
      sqft: f.sqft === '' ? null : Number(f.sqft),
      rentAmount: num(f.rentAmount),
      securityDeposit: num(f.securityDeposit),
      dwellingOwnership: f.dwellingOwnership,
      ownerHouseholdSize: Math.max(1, Number(f.ownerHouseholdSize) || 1),
      isMultiLevel: f.isMultiLevel,
      isAdaAccessible: f.isAdaAccessible,
      floorLevel: f.floorLevel || null,
      livingAreas: f.livingAreas ? Number(f.livingAreas) : undefined,
      features: f.features,
      occupancyMode: f.occupancyMode,
      rvSiteLayout: f.rvSiteLayout,
      rvAmpService: f.rvAmpService,
      storageSize: f.storageSize || null,
      lotRentAmount: num(f.lotRentAmount),
    })
  }

  const { data: photos = [], refetch: refetchPhotos } = useQuery(['unit-photos', id], () => apiGet<any[]>('/properties/units/' + id + '/photos'))

  const { can } = usePerms()

  // Init listing form from unit data
  if (unit && !listingInit) {
    setListingForm({
      availableDate: unit.availableDate ? unit.availableDate.split('T')[0] : '',
      listingDescription: unit.listingDescription || '',
      listedVacant: unit.listedVacant || false,
      bedrooms: unit.bedrooms?.toString() || '',
      bathrooms: unit.bathrooms?.toString() || '',
      sqft: unit.sqft?.toString() || '',
    })
    setListingInit(true)
  }

  const saveListing = async () => {
    setSavingListing(true); setListingMsg('')
    try {
      // S573: bed/bath/sq-ft now live only in the consolidated Unit Details
      // editor (lease-gated). The listing card manages marketing fields only.
      await apiPatch('/properties/units/' + id + '/listing', {
        availableDate: listingForm.availableDate || null,
        listingDescription: listingForm.listingDescription || null,
        listedVacant: listingForm.listedVacant,
      })
      qc.invalidateQueries(['unit', id])
      setListingMsg('Listing saved')
      setTimeout(() => setListingMsg(''), 3000)
    } catch (e: any) { setListingMsg('Failed: ' + e.message) }
    finally { setSavingListing(false) }
  }

  const uploadPhotos = async (files: FileList) => {
    setUploadingPhotos(true); setListingMsg('')
    try {
      const fd = new FormData()
      Array.from(files).forEach(f => fd.append('photos', f))
      await fetch(`${API_URL}/api/properties/units/${id}/photos`, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + localStorage.getItem('gam_token') },
        body: fd,
      }).then(r => r.json())
      refetchPhotos()
      setListingMsg(`${files.length} photo(s) uploaded`)
      setTimeout(() => setListingMsg(''), 3000)
    } catch (e: any) { setListingMsg('Upload failed') }
    finally { setUploadingPhotos(false) }
  }

  const deletePhoto = async (photoId: string) => {
    await fetch(`${API_URL}/api/properties/units/${id}/photos/${photoId}`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer ' + localStorage.getItem('gam_token') },
    })
    refetchPhotos()
  }

  const evictMut = useMutation(
    ({ enable }: { enable: boolean }) => apiPost('/units/' + id + '/eviction-mode', { enable, confirm: true }),
    { onSuccess: () => { qc.invalidateQueries(['unit', id]); qc.invalidateQueries('units'); setEvictModal(false); setEvictConfirm(false) } }
  )

  if (isLoading) return <div style={{ color: 'var(--text-3)', padding: 32 }}>Loading...</div>
  if (!unit) return <div className="empty-state"><h3>Unit not found</h3></div>

  return (
    <div>
      <div className="page-header">
        <div className="flex items-center gap-12">
          <button className="btn btn-ghost btn-sm" onClick={() => navigate('/units')}><ArrowLeft size={15} /></button>
          <div>
            <h1 className="page-title">Unit {unit.unitNumber}</h1>
            <p className="page-subtitle">{unit.propertyName} - {unit.street1}, {unit.city}</p>
          </div>
        </div>
        <div className="flex gap-8">
          {unit.paymentBlock && <span className="badge badge-red"><Shield size={10} /> Eviction Mode</span>}
          {unit.scheduledActivationAt && (
            <span className="badge badge-amber" title={'Scheduled: ' + new Date(unit.scheduledActivationAt).toLocaleString()}>
              ⏰ Activation scheduled
            </span>
          )}
          {unit.status === 'vacant' && (
            <>
              <button className="btn btn-sm btn-primary" onClick={() => navigate('/tenant-onboarding')}>
                Onboard Existing Tenant
              </button>
              {can('units.manage_lifecycle') && (
                <button className="btn btn-sm btn-secondary" onClick={() => markAvailMut.mutate()} disabled={markAvailMut.isLoading}>
                  {markAvailMut.isLoading ? 'Saving…' : 'Mark Available'}
                </button>
              )}
            </>
          )}
          {unit.status === 'available' && can('units.manage_lifecycle') && (
            <>
              <button className="btn btn-sm btn-primary" onClick={() => setActivateModal(true)}>
                Activate
              </button>
              <button className="btn btn-sm btn-ghost" onClick={() => markVacantMut.mutate()} disabled={markVacantMut.isLoading}>
                Mark Vacant
              </button>
            </>
          )}
          {unit.scheduledActivationAt && can('units.manage_lifecycle') && (
            <button className="btn btn-sm btn-ghost" onClick={() => cancelSchedMut.mutate()} disabled={cancelSchedMut.isLoading}>
              Cancel schedule
            </button>
          )}
          {can('units.eviction_mode') && (
            <button
              className={'btn btn-sm ' + (unit.paymentBlock ? 'btn-secondary' : 'btn-danger')}
              onClick={() => { setEvictModal(true); setEvictConfirm(false) }}
            >
              <Shield size={13} /> {unit.paymentBlock ? 'Deactivate Eviction Mode' : 'Activate Eviction Mode'}
            </button>
          )}
        </div>
      </div>

      <div className="grid-2">
        <div className="card">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
            <div className="card-title" style={{ margin: 0 }}>Unit Details</div>
            {can('schedule.configure_unit') && !editing && (
              unit.hasActiveLease
                ? <span className="badge badge-amber" style={{ display: 'flex', alignItems: 'center', gap: 4 }} title="Locked while a lease is active"><Lock size={11} /> Locked (leased)</span>
                : <button className="btn btn-sm btn-secondary" onClick={startEdit}><Pencil size={12} /> Edit</button>
            )}
          </div>

          {editing && editForm ? (
            (() => {
              const set = (k: string, v: any) => setEditForm((f: any) => ({ ...f, [k]: v }))
              const hasBeds = !!UNIT_TYPE_HAS_BEDROOMS[editForm.unitType as UnitType]
              const isInterior = ['apartment', 'single_family', 'mobile_home'].includes(editForm.unitType)
              const isBuilding = !['rv_spot', 'storage', 'parking'].includes(editForm.unitType)
              const isRv = editForm.unitType === 'rv_spot'
              const selS = { className: 'form-select', style: { maxWidth: 220, fontSize: '.8rem', padding: '3px 8px' } as any }
              const inpS = { className: 'input', style: { maxWidth: 140, fontSize: '.8rem', padding: '3px 8px' } as any }
              return (
                <div style={{ display: 'grid', gap: 8 }}>
                  {detailsErr && <div style={{ color: 'var(--red)', fontSize: '.76rem', background: 'rgba(239,68,68,.08)', border: '1px solid rgba(239,68,68,.3)', borderRadius: 7, padding: '7px 10px' }}>{detailsErr}</div>}
                  <div className="data-row"><span className="data-key">Type</span>
                    <select {...selS} value={editForm.unitType} onChange={e => set('unitType', e.target.value)}>
                      {(UNIT_TYPES as readonly string[]).map(t => <option key={t} value={t}>{UNIT_TYPE_LABEL[t as UnitType] ?? t}</option>)}
                    </select>
                  </div>
                  {hasBeds && <>
                    <div className="data-row"><span className="data-key">Bedrooms</span><input {...inpS} type="number" min={0} max={30} value={editForm.bedrooms} onChange={e => set('bedrooms', e.target.value)} /></div>
                    <div className="data-row"><span className="data-key">Bathrooms</span><input {...inpS} type="number" min={0} step={0.5} value={editForm.bathrooms} onChange={e => set('bathrooms', e.target.value)} /></div>
                    <div className="data-row"><span className="data-key">Sq ft</span><input {...inpS} type="number" min={0} value={editForm.sqft} onChange={e => set('sqft', e.target.value)} /></div>
                  </>}
                  <div className="data-row"><span className="data-key">Rent (/mo)</span><input {...inpS} type="number" min={0} value={editForm.rentAmount} onChange={e => set('rentAmount', e.target.value)} /></div>
                  <div className="data-row"><span className="data-key">Deposit</span><input {...inpS} type="number" min={0} value={editForm.securityDeposit} onChange={e => set('securityDeposit', e.target.value)} /></div>
                  {(isRv || editForm.unitType === 'mobile_home') && (
                    <div className="data-row"><span className="data-key">{isRv ? 'RV owner' : 'Home owner'}</span>
                      <select {...selS} value={editForm.dwellingOwnership} onChange={e => set('dwellingOwnership', e.target.value)}>
                        <option value="tenant">Tenant-owned</option>
                        <option value="landlord">Park/landlord-owned</option>
                      </select>
                    </div>
                  )}
                  {/* S609 (Nic): only for an owner-occupied unit. It has no lease,
                      so a headcount utility split has nobody to count — this is
                      what it weighs the unit by, and weighing it is what keeps the
                      owner's own usage off the tenants' bills. */}
                  {unit.status === 'owner_use' && (
                    <div className="data-row"><span className="data-key">People living here</span>
                      <input {...inpS} type="number" min={1} max={30}
                        style={{ ...inpS.style, maxWidth: 90 }}
                        value={editForm.ownerHouseholdSize}
                        onChange={e => set('ownerHouseholdSize', e.target.value)} />
                    </div>
                  )}
                  {isInterior && <>
                    <div className="data-row"><span className="data-key">Multi-level</span>
                      <select {...selS} value={editForm.isMultiLevel ? 'yes' : 'no'} onChange={e => set('isMultiLevel', e.target.value === 'yes')}>
                        <option value="no">Single level</option>
                        <option value="yes">Multi-level (has stairs)</option>
                      </select>
                    </div>
                    <div className="data-row"><span className="data-key">Accessible (ADA)</span>
                      <select {...selS} value={editForm.isAdaAccessible ? 'yes' : 'no'} onChange={e => set('isAdaAccessible', e.target.value === 'yes')}>
                        <option value="no">Standard unit</option>
                        <option value="yes">Accessible (ADA)</option>
                      </select>
                    </div>
                  </>}
                  {isBuilding && (
                    <div className="data-row"><span className="data-key">Floor placement</span>
                      <select {...selS} value={editForm.floorLevel} onChange={e => set('floorLevel', e.target.value)}>
                        <option value="">Unspecified</option>
                        {(FLOOR_LEVELS as readonly string[]).map(fl => <option key={fl} value={fl}>{FLOOR_LEVEL_LABEL[fl as FloorLevel]}</option>)}
                      </select>
                    </div>
                  )}
                  {hasBeds && (
                    <div className="data-row"><span className="data-key">Living areas</span>
                      <select {...selS} value={editForm.livingAreas} onChange={e => set('livingAreas', e.target.value)}>
                        {Array.from({ length: MAX_INSPECTION_LIVING_AREAS }, (_, i) => i + 1).map(n =>
                          <option key={n} value={String(n)}>{n} {n === 1 ? 'living/dining' : 'living areas'}</option>)}
                      </select>
                    </div>
                  )}
                  {hasBeds && (
                    <div className="data-row"><span className="data-key">Leasing</span>
                      <select {...selS} value={editForm.occupancyMode} onChange={e => set('occupancyMode', e.target.value)}>
                        <option value="whole_unit">Whole unit (one lease)</option>
                        <option value="by_room">By the room (separate leases)</option>
                      </select>
                    </div>
                  )}
                  {isRv && <>
                    <div className="data-row"><span className="data-key">Site layout</span>
                      <select {...selS} value={editForm.rvSiteLayout} onChange={e => set('rvSiteLayout', e.target.value)}>
                        <option value="none">—</option><option value="back_in">Back-in</option><option value="pull_through">Pull-through</option>
                      </select>
                    </div>
                    <div className="data-row"><span className="data-key">Electrical</span>
                      <select {...selS} value={editForm.rvAmpService} onChange={e => set('rvAmpService', e.target.value)}>
                        <option value="none">—</option><option value="30">30 amp</option><option value="50">50 amp</option><option value="both">30/50 amp</option>
                      </select>
                    </div>
                  </>}
                  {editForm.unitType === 'storage' && (
                    <div className="data-row"><span className="data-key">Size</span><input {...inpS} style={{ ...inpS.style, maxWidth: 160 }} placeholder="10x10" value={editForm.storageSize} onChange={e => set('storageSize', e.target.value)} /></div>
                  )}
                  {/* LOT RENT — MOBILE HOMES ONLY (Nic, S609):
                      "Subleasing would only be on mobile home units. RV units have
                       no need to have that because the space rent is the space rent.
                       There's no lot rent, trailer rent kind of difference like there
                       is on mobile homes."
                      On a mobile home the land and the home are genuinely separate —
                      the resident may own the home, or be buying it — so lot rent is
                      a real, distinct number. On an RV spot the space rent IS the
                      rent, and this field read as a second competing rent right below
                      the first. Someone subletting their own RV is an arrangement
                      outside the platform. */}
                  {editForm.unitType === 'mobile_home' && (
                    <div className="data-row"><span className="data-key">Lot rent (/mo)</span><input {...inpS} type="number" min={0} value={editForm.lotRentAmount} onChange={e => set('lotRentAmount', e.target.value)} /></div>
                  )}
                  {/* S609 (Nic, DIRECTIVE): "Anything to do with editing a unit
                      should be in the unit details portal... you need to add any
                      submeters there, kind of between the unit details and the
                      features of the unit. Features of the unit should be below
                      the submeters."

                      It used to be its own card at the very bottom of the page,
                      under the whole listing/photos block — which is why a unit
                      that was created without a submeter looked like it could
                      never be given one. Editing a unit now means everything
                      about that unit is in one place, in the order you set it up:
                      details, then meters, then features. */}
                  <div style={{ marginTop: 8, borderTop: '1px solid var(--border-0)', paddingTop: 10 }}>
                    <UnitMetersCard unitId={unit.id} propertyId={unit.propertyId} unitNumber={unit.unitNumber} embedded />
                  </div>
                  {/* S609 (Nic): the per-unit inspection features are hidden on RV
                      SPOTS — "those should just go away, it's just extra clutter",
                      about the picnic table / fire ring / gate code ticks under an RV
                      spot's electrical field.

                      Still shown for every other unit type, where the list is about
                      what is actually inside a home. An RV spot with no ticks falls
                      back to the preset list for its type, which was always the
                      behaviour for an unconfigured unit — and any ticks already saved
                      are preserved, since the form still round-trips `features`. */}
                  {!isRv && featuresForType(editForm.unitType).length > 0 && (() => {
                    const offered = featuresForType(editForm.unitType)
                    const groups = Array.from(new Set(offered.map(f => f.group)))
                    const toggle = (k: string, v: boolean) => setEditForm((ef: any) => ({ ...ef, features: { ...ef.features, [k]: v } }))
                    return (
                      <div style={{ marginTop: 8, borderTop: '1px solid var(--border-0)', paddingTop: 10 }}>
                        <div style={{ fontSize: '.72rem', fontWeight: 700, color: 'var(--text-2)', textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 2 }}>Features on this unit</div>
                        <div style={{ fontSize: '.68rem', color: 'var(--text-3)', marginBottom: 8 }}>Optional — controls which items appear on this unit's inspections.</div>
                        {groups.map(g => (
                          <div key={g} style={{ marginBottom: 8 }}>
                            <div style={{ fontSize: '.66rem', fontWeight: 700, color: 'var(--text-3)', marginBottom: 4 }}>{g}</div>
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '3px 12px' }}>
                              {offered.filter(f => f.group === g).map(f => {
                                const on = !!editForm.features?.[f.key]
                                return (
                                  <label key={f.key} onClick={() => toggle(f.key, !on)} style={{ display: 'flex', alignItems: 'center', gap: 7, cursor: 'pointer', fontSize: '.76rem', color: 'var(--text-1)' }}>
                                    <span style={{ width: 15, height: 15, borderRadius: 4, flexShrink: 0, border: `1px solid ${on ? 'var(--gold)' : 'var(--border-0)'}`, background: on ? 'var(--gold)' : 'var(--bg-2)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#000', fontSize: '.6rem', fontWeight: 700 }}>{on ? '✓' : ''}</span>
                                    {f.label}
                                  </label>
                                )
                              })}
                            </div>
                          </div>
                        ))}
                      </div>
                    )
                  })()}
                  <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 6 }}>
                    <button className="btn btn-sm btn-ghost" onClick={() => { setEditing(false); setDetailsErr('') }}>Cancel</button>
                    <button className="btn btn-sm btn-primary" onClick={saveDetails} disabled={detailsMut.isLoading}>{detailsMut.isLoading ? 'Saving…' : 'Save'}</button>
                  </div>
                </div>
              )
            })()
          ) : (
            <>
              <div className="data-row"><span className="data-key">Status</span><span className={'badge badge-' + (unit.status === 'active' ? 'green' : unit.status === 'vacant' ? 'muted' : 'amber')}>{humanize(unit.status)}</span></div>
              <div className="data-row"><span className="data-key">Type</span><span className="data-val">{UNIT_TYPE_LABEL[unit.unitType as UnitType] ?? unit.unitType}</span></div>
              <UnitSubtypeRow unit={unit} />
              <div className="data-row"><span className="data-key">Leasing</span><span className="data-val">{unit.occupancyMode === 'by_room' ? 'By the room' : 'Whole unit'}</span></div>
              <div className="data-row"><span className="data-key">Rent</span><span className="data-val mono">{fmt(unit.rentAmount)}/mo</span></div>
              <div className="data-row"><span className="data-key">Deposit</span><span className="data-val mono">{fmt(unit.securityDeposit)}</span></div>
              {UNIT_TYPE_HAS_BEDROOMS[unit.unitType as UnitType] && <>
                <div className="data-row"><span className="data-key">Bedrooms</span><span className="data-val">{unit.bedrooms}</span></div>
                <div className="data-row"><span className="data-key">Bathrooms</span><span className="data-val">{unit.bathrooms}</span></div>
                <div className="data-row"><span className="data-key">Multi-level</span><span className="data-val">{unit.isMultiLevel ? 'Multi-level' : 'Single level'}</span></div>
                <div className="data-row"><span className="data-key">Accessible (ADA)</span><span className="data-val">{unit.isAdaAccessible ? 'Accessible (ADA)' : 'Standard'}</span></div>
              </>}
              {!['rv_spot', 'storage', 'parking'].includes(unit.unitType) && (
                <div className="data-row"><span className="data-key">Floor placement</span><span className="data-val">{unit.floorLevel ? FLOOR_LEVEL_LABEL[unit.floorLevel as FloorLevel] : 'Unspecified'}</span></div>
              )}
              {unit.unitType === 'rv_spot' && <>
                <div className="data-row"><span className="data-key">Site layout</span><span className="data-val">{unit.rvSiteLayout === 'pull_through' ? 'Pull-through' : unit.rvSiteLayout === 'back_in' ? 'Back-in' : '—'}</span></div>
                <div className="data-row"><span className="data-key">Electrical</span><span className="data-val">{unit.rvAmpService && unit.rvAmpService !== 'none' ? (unit.rvAmpService === 'both' ? '30/50 amp' : `${unit.rvAmpService} amp`) : '—'}</span></div>
              </>}
              {unit.unitType === 'storage' && (
                <div className="data-row"><span className="data-key">Size</span><span className="data-val">{unit.storageSize || '—'}</span></div>
              )}
              {unit.hasActiveLease && can('schedule.configure_unit') && (
                <div style={{ fontSize: '.72rem', color: 'var(--text-3)', marginTop: 10, display: 'flex', alignItems: 'center', gap: 6 }}>
                  <Lock size={12} /> Settings are locked while this unit has an active lease. Edit between leases.
                </div>
              )}
              {/* S609: also visible WITHOUT entering edit — a leased unit's
                  settings are locked, but its meters still need adding and
                  reading. Same section, same place on the card either way. */}
              <div style={{ marginTop: 10, borderTop: '1px solid var(--border-0)', paddingTop: 10 }}>
                <UnitMetersCard unitId={unit.id} propertyId={unit.propertyId} unitNumber={unit.unitNumber} embedded />
              </div>
            </>
          )}
        </div>

        <div className="card">
          <div className="card-title" style={{ marginBottom: 16 }}>Tenant</div>
          {unit.tenantFirst ? (
            <>
              <div className="data-row"><span className="data-key">Name</span><span className="data-val">{unit.tenantFirst} {unit.tenantLast}</span></div>
              <div className="data-row"><span className="data-key">Email</span><span className="data-val">{unit.tenantEmail}</span></div>
              <div className="data-row"><span className="data-key">ACH</span><span className={'badge ' + (unit.achVerified ? 'badge-green' : 'badge-amber')}>{unit.achVerified ? 'Verified' : 'Pending'}</span></div>
              <div className="data-row"><span className="data-key">SSI/SSDI</span><span className="data-val">{unit.ssiSsdi ? 'Yes' : 'No'}</span></div>
            </>
          ) : (
            <div style={{ color: 'var(--text-3)', fontSize: '.875rem', padding: '16px 0' }}>No tenant assigned.</div>
          )}
        </div>

        {(unit.unitType === 'mobile_home' || unit.unitType === 'rv_spot') && (
          <HomeOwnerSection unitId={id!} />
        )}

        {(unit.unitType === 'mobile_home' || unit.unitType === 'rv_spot') && (
          <FinancedSaleSection unitId={id!} />
        )}

        {(unit.unitType === 'mobile_home' || unit.unitType === 'rv_spot') && (
          <ResidentSaleSection unitId={id!} />
        )}

        <div className="card" style={{ gridColumn: "1 / -1" }}>
          <div className="card-title" style={{ marginBottom: 16 }}>Unit Economics</div>
          <div style={{ display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:10, marginBottom:20 }}>
            <div style={{ background:"var(--bg-2)", border:"1px solid var(--border-0)", borderRadius:10, padding:"12px 14px" }}>
              <div style={{ fontSize:".65rem", fontWeight:700, color:"var(--text-3)", textTransform:"uppercase", marginBottom:6 }}>Net Monthly</div>
              <div style={{ fontFamily:"var(--font-mono)", fontSize:".95rem", fontWeight:700, color:"var(--green)" }}>{fmt(unit.rentAmount-(unit.status==="vacant"?0:2))}</div>
            </div>
            <div style={{ background:"var(--bg-2)", border:"1px solid var(--border-0)", borderRadius:10, padding:"12px 14px" }}>
              <div style={{ fontSize:".65rem", fontWeight:700, color:"var(--text-3)", textTransform:"uppercase", marginBottom:6 }}>Projected Yearly</div>
              <div style={{ fontFamily:"var(--font-mono)", fontSize:".95rem", fontWeight:700, color:"var(--gold)" }}>{fmt((unit.rentAmount-(unit.status==="vacant"?0:2))*12)}</div>
            </div>
            <div style={{ background:"var(--bg-2)", border:"1px solid var(--border-0)", borderRadius:10, padding:"12px 14px" }}>
              <div style={{ fontSize:".65rem", fontWeight:700, color:"var(--text-3)", textTransform:"uppercase", marginBottom:6 }}>Lifetime Net</div>
              <div style={{ fontFamily:"var(--font-mono)", fontSize:".95rem", fontWeight:700, color:"var(--gold)" }}>{econ ? fmt(econ.lifetimeNet) : "—"}</div>
            </div>
            <div style={{ background:"var(--bg-2)", border:"1px solid var(--border-0)", borderRadius:10, padding:"12px 14px" }}>
              <div style={{ fontSize:".65rem", fontWeight:700, color:"var(--text-3)", textTransform:"uppercase", marginBottom:6 }}>Tenant Months</div>
              <div style={{ fontFamily:"var(--font-mono)", fontSize:".95rem", fontWeight:700, color:"var(--text-0)" }}>{econ ? econ.tenantMonths+" mo" : "—"}</div>
            </div>
          </div>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:16 }}>
            <div>
              <div style={{ fontSize:".68rem", fontWeight:700, color:"var(--text-3)", textTransform:"uppercase", letterSpacing:".08em", marginBottom:8 }}>Monthly Breakdown</div>
              <div className="data-row"><span className="data-key">Rent</span><span className="data-val mono">{fmt(unit.rentAmount)}/mo</span></div>
              <div className="data-row"><span className="data-key">Platform fee</span><span className="data-val mono" style={{ color:unit.status==="vacant"?"var(--text-3)":"var(--red)" }}>{unit.status==="vacant"?"Free (vacant)":"-2.00/mo"}</span></div>
              <div className="data-row" style={{ borderTop:"1px solid var(--border-1)", paddingTop:8, marginTop:4 }}><span className="data-key" style={{ fontWeight:700 }}>Net monthly</span><span className="data-val mono" style={{ color:"var(--green)", fontWeight:700 }}>{fmt(unit.rentAmount-(unit.status==="vacant"?0:2))}/mo</span></div>
              <div className="data-row"><span className="data-key">Projected yearly</span><span className="data-val mono" style={{ color:"var(--gold)" }}>{fmt((unit.rentAmount-(unit.status==="vacant"?0:2))*12)}</span></div>
            </div>
            <div>
              <div style={{ fontSize:".68rem", fontWeight:700, color:"var(--text-3)", textTransform:"uppercase", letterSpacing:".08em", marginBottom:8 }}>Maintenance Costs</div>
              {(maintenance as any[]).filter((m:any)=>m.actualCost).length===0
                ? <div style={{ fontSize:".78rem", color:"var(--text-3)" }}>No costs recorded.</div>
                : (maintenance as any[]).filter((m:any)=>m.actualCost).slice(0,5).map((m:any)=>(
                    <div key={m.id} className="data-row"><span className="data-key" style={{ fontSize:".73rem" }}>{m.title}</span><span className="data-val mono" style={{ color:"var(--red)", fontSize:".73rem" }}>−{fmt(m.actualCost)}</span></div>
                  ))
              }
              {econ && econ.lifetimeMaintCost > 0 && (<div className="data-row" style={{ borderTop:"1px solid var(--border-1)", paddingTop:8, marginTop:4 }}><span className="data-key" style={{ fontWeight:700 }}>Lifetime total</span><span className="data-val mono" style={{ color:"var(--red)", fontWeight:700 }}>−{fmt(econ.lifetimeMaintCost)}</span></div>)}
            </div>
          </div>
          {econ && econ.tenantMonths > 0 && (
            <div style={{ marginTop:16, padding:"12px 14px", background:"var(--bg-2)", border:"1px solid var(--border-0)", borderRadius:10 }}>
              <div style={{ fontSize:".68rem", fontWeight:700, color:"var(--text-3)", textTransform:"uppercase", letterSpacing:".08em", marginBottom:10 }}>Tenant Lifetime ({econ.tenantMonths} months)</div>
              <div style={{ display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:10 }}>
                <div style={{ textAlign:"center" }}><div style={{ fontSize:".62rem", color:"var(--text-3)", marginBottom:3 }}>Collected</div><div style={{ fontFamily:"var(--font-mono)", fontSize:".82rem", fontWeight:700, color:"var(--text-0)" }}>{fmt(econ.lifetimeCollected)}</div></div>
                <div style={{ textAlign:"center" }}><div style={{ fontSize:".62rem", color:"var(--text-3)", marginBottom:3 }}>Platform Fees</div><div style={{ fontFamily:"var(--font-mono)", fontSize:".82rem", fontWeight:700, color:"var(--red)" }}>{fmt(econ.lifetimePlatformFees)}</div></div>
                <div style={{ textAlign:"center" }}><div style={{ fontSize:".62rem", color:"var(--text-3)", marginBottom:3 }}>Maint. Costs</div><div style={{ fontFamily:"var(--font-mono)", fontSize:".82rem", fontWeight:700, color:"var(--red)" }}>{fmt(econ.lifetimeMaintCost)}</div></div>
                <div style={{ textAlign:"center" }}><div style={{ fontSize:".62rem", color:"var(--text-3)", marginBottom:3 }}>Net to You</div><div style={{ fontFamily:"var(--font-mono)", fontSize:".82rem", fontWeight:700, color:"var(--gold)" }}>{fmt(econ.lifetimeNet)}</div></div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* LISTING MANAGEMENT */}
      <div className="card" style={{ gridColumn: '1 / -1', marginTop: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <div className="card-title" style={{ marginBottom: 0 }}>Listing Management</div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {/* S508 (#9): photos only matter when actually listing the unit.
                Don't nag GAM-imported / occupied units that aren't being listed. */}
            {/* S609 (Nic): the minimum depends on the unit TYPE — one photo for a
                bare site (the renter tows in the dwelling), five where people live
                inside. Read from the shared rule the listing query uses, so this
                badge can never promise a different number than the one enforced. */}
            {listingForm.listedVacant && (photos as any[]).length < listingMinPhotos(unit.unitType) && <span style={{ fontSize: '.72rem', color: 'var(--amber)', fontWeight: 600 }}>⚠ {listingMinPhotos(unit.unitType) - (photos as any[]).length} more photo(s) needed to publish</span>}
            {listingForm.listedVacant && (photos as any[]).length >= listingMinPhotos(unit.unitType) && <span style={{ fontSize: '.72rem', color: 'var(--green)', fontWeight: 600 }}>✓ Ready to publish</span>}
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: '.82rem', fontWeight: 600 }}>
              <span style={{ color: 'var(--text-2)' }}>Listed</span>
              <div style={{ position: 'relative', width: 40, height: 22 }} onClick={() => setListingForm(f => ({ ...f, listedVacant: !f.listedVacant }))}>
                <div style={{ position: 'absolute', inset: 0, borderRadius: 11, background: listingForm.listedVacant ? 'var(--green)' : 'var(--border-1)', transition: 'background .2s' }} />
                <div style={{ position: 'absolute', top: 2, left: listingForm.listedVacant ? 20 : 2, width: 18, height: 18, borderRadius: '50%', background: '#fff', transition: 'left .2s' }} />
              </div>
            </label>
          </div>
        </div>

        {listingMsg && <div style={{ padding: '8px 12px', borderRadius: 7, marginBottom: 12, fontSize: '.78rem', background: listingMsg.startsWith('F') ? 'rgba(239,68,68,.08)' : 'rgba(34,197,94,.08)', color: listingMsg.startsWith('F') ? 'var(--red)' : 'var(--green)', border: `1px solid ${listingMsg.startsWith('F') ? 'rgba(239,68,68,.2)' : 'rgba(34,197,94,.2)'}` }}>{listingMsg}</div>}

        <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 16, marginBottom: 16 }}>
          {/* S573: bed/bath/sq-ft moved to the consolidated Unit Details editor
              (one source of truth, lease-gated). This card is marketing only. */}
          <div>
            <label style={{ display: 'block', fontSize: '.68rem', fontWeight: 700, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 4 }}>Available Date</label>
            <input type="date" value={listingForm.availableDate} onChange={e => setListingForm(f => ({ ...f, availableDate: e.target.value }))} style={{ width: '100%', background: 'var(--bg-2)', border: '1px solid var(--border-1)', borderRadius: 7, color: 'var(--text-0)', padding: '7px 10px', fontSize: '.875rem' }} />
          </div>
        </div>

        <div style={{ marginBottom: 16 }}>
          <label style={{ display: 'block', fontSize: '.68rem', fontWeight: 700, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 4 }}>Listing Description</label>
          <textarea rows={3} value={listingForm.listingDescription} onChange={e => setListingForm(f => ({ ...f, listingDescription: e.target.value }))} placeholder="Describe the unit — features, amenities, neighborhood…" style={{ width: '100%', background: 'var(--bg-2)', border: '1px solid var(--border-1)', borderRadius: 7, color: 'var(--text-0)', padding: '8px 10px', fontSize: '.875rem', resize: 'vertical' }} />
        </div>

        {/* Photos */}
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <label style={{ fontSize: '.68rem', fontWeight: 700, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.06em' }}>Photos ({(photos as any[]).length} / min 5)</label>
            <button className="btn btn-sm btn-secondary" onClick={() => fileRef.current?.click()} disabled={uploadingPhotos}>
              <Camera size={13} /> {uploadingPhotos ? 'Uploading…' : 'Upload Photos'}
            </button>
            <input ref={fileRef} type="file" multiple accept="image/*" style={{ display: 'none' }} onChange={e => e.target.files?.length && uploadPhotos(e.target.files)} />
          </div>
          {(photos as any[]).length > 0 ? (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: 8 }}>
              {(photos as any[]).map((p: any) => (
                <div key={p.id} style={{ position: 'relative', borderRadius: 8, overflow: 'hidden', aspectRatio: '4/3', background: 'var(--bg-2)' }}>
                  <AuthImg url={p.url} />
                  <button onClick={() => deletePhoto(p.id)} style={{ position: 'absolute', top: 4, right: 4, background: 'rgba(0,0,0,.6)', border: 'none', borderRadius: '50%', width: 24, height: 24, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: '#fff' }}>
                    <Trash2 size={12} />
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <div style={{ padding: '24px', textAlign: 'center', background: 'var(--bg-2)', borderRadius: 8, border: '2px dashed var(--border-1)', cursor: 'pointer' }} onClick={() => fileRef.current?.click()}>
              <Camera size={24} style={{ color: 'var(--text-3)', marginBottom: 8 }} />
              <div style={{ fontSize: '.78rem', color: 'var(--text-3)' }}>Click to upload photos · minimum 5 required to publish</div>
            </div>
          )}
        </div>

        <div style={{ display: 'flex', gap: 10, marginTop: 16, paddingTop: 14, borderTop: '1px solid var(--border-0)', justifyContent: 'space-between', alignItems: 'center' }}>
          <a href={LISTINGS_URL} target="_blank" rel="noreferrer" style={{ fontSize: '.78rem', color: 'var(--text-3)', display: 'flex', alignItems: 'center', gap: 4 }}>
            <ExternalLink size={12} /> View public listings page
          </a>
          {can('units.edit_listing') && (
            <button className="btn btn-primary btn-sm" onClick={saveListing} disabled={savingListing}>
              {savingListing ? 'Saving…' : 'Save Listing'}
            </button>
          )}
        </div>
      </div>

      {activateModal && (
        <div className="modal-overlay" onClick={() => setActivateModal(false)}>
          <div className="modal" style={{ maxWidth: 520 }} onClick={e => e.stopPropagation()}>
            <div className="modal-title">Activate Unit {unit.unitNumber}</div>
            <p style={{ fontSize: '.82rem', color: 'var(--text-2)', marginBottom: 16 }}>
              Activation starts billing based on lease terms. Rent collection, disbursements, and platform fees begin at the activation time.
            </p>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 16 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 10, padding: 12, border: '1px solid ' + (schedChoice === 'now' ? 'var(--gold)' : 'var(--border-0)'), borderRadius: 8, cursor: 'pointer' }}>
                <input type="radio" name="sched" checked={schedChoice === 'now'} onChange={() => setSchedChoice('now')} />
                <div>
                  <div style={{ fontWeight: 600, fontSize: '.85rem' }}>Activate now</div>
                  <div style={{ fontSize: '.72rem', color: 'var(--text-3)' }}>Billing starts immediately.</div>
                </div>
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 10, padding: 12, border: '1px solid ' + (schedChoice === 'later' ? 'var(--gold)' : 'var(--border-0)'), borderRadius: 8, cursor: 'pointer' }}>
                <input type="radio" name="sched" checked={schedChoice === 'later'} onChange={() => setSchedChoice('later')} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600, fontSize: '.85rem' }}>Schedule for later</div>
                  <div style={{ fontSize: '.72rem', color: 'var(--text-3)', marginBottom: schedChoice === 'later' ? 10 : 0 }}>
                    Time zone of the unit (based on state: <strong>{unit.state || '—'}</strong>).
                  </div>
                  {schedChoice === 'later' && (
                    <input
                      type="datetime-local"
                      className="input"
                      value={schedLocal}
                      min={new Date(Date.now() + 60 * 60 * 1000).toISOString().slice(0,16)}
                      onChange={e => setSchedLocal(e.target.value)}
                      onClick={e => e.stopPropagation()}
                      style={{ width: '100%' }}
                    />
                  )}
                </div>
              </label>
            </div>

            {activateMut.isError && (
              <div className="alert alert-danger" style={{ marginBottom: 12 }}>
                <AlertTriangle size={16} />
                <div>{(activateMut.error as any)?.response?.data?.error || 'Activation failed. Check that the unit has a lease, tenant, and rent amount.'}</div>
              </div>
            )}

            <div className="modal-footer">
              <button className="btn btn-ghost" onClick={() => setActivateModal(false)}>Cancel</button>
              <button
                className="btn btn-primary"
                disabled={activateMut.isLoading || (schedChoice === 'later' && !schedLocal)}
                onClick={() => {
                  if (schedChoice === 'now') {
                    activateMut.mutate({})
                  } else {
                    // Convert schedLocal (local wall time in unit's state tz) to UTC ISO
                    const STATE_TZ: Record<string,string> = {
                      AL:'America/Chicago',AK:'America/Anchorage',AZ:'America/Phoenix',AR:'America/Chicago',CA:'America/Los_Angeles',CO:'America/Denver',
                      CT:'America/New_York',DE:'America/New_York',DC:'America/New_York',FL:'America/New_York',GA:'America/New_York',HI:'Pacific/Honolulu',
                      ID:'America/Boise',IL:'America/Chicago',IN:'America/Indiana/Indianapolis',IA:'America/Chicago',KS:'America/Chicago',KY:'America/New_York',
                      LA:'America/Chicago',ME:'America/New_York',MD:'America/New_York',MA:'America/New_York',MI:'America/Detroit',MN:'America/Chicago',
                      MS:'America/Chicago',MO:'America/Chicago',MT:'America/Denver',NE:'America/Chicago',NV:'America/Los_Angeles',NH:'America/New_York',
                      NJ:'America/New_York',NM:'America/Denver',NY:'America/New_York',NC:'America/New_York',ND:'America/Chicago',OH:'America/New_York',
                      OK:'America/Chicago',OR:'America/Los_Angeles',PA:'America/New_York',RI:'America/New_York',SC:'America/New_York',SD:'America/Chicago',
                      TN:'America/Chicago',TX:'America/Chicago',UT:'America/Denver',VT:'America/New_York',VA:'America/New_York',WA:'America/Los_Angeles',
                      WV:'America/New_York',WI:'America/Chicago',WY:'America/Denver'
                    }
                    const tz = STATE_TZ[(unit.state || '').toUpperCase()] || 'America/Phoenix'
                    // Compute tz offset for that wall moment
                    const asIfUtc = new Date(schedLocal + 'Z')
                    const offsetFmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' })
                    const offPart = offsetFmt.formatToParts(asIfUtc).find(p => p.type === 'timeZoneName')?.value || 'GMT+00:00'
                    const m = offPart.match(/GMT([+-])(\d{1,2}):?(\d{2})?/)
                    let offsetMin = 0
                    if (m) {
                      const sign = m[1] === '-' ? -1 : 1
                      offsetMin = sign * (parseInt(m[2], 10) * 60 + parseInt(m[3] || '0', 10))
                    }
                    const utcMillis = asIfUtc.getTime() - offsetMin * 60 * 1000
                    const utcIso = new Date(utcMillis).toISOString()
                    activateMut.mutate({ scheduledFor: utcIso })
                  }
                }}
              >
                {activateMut.isLoading ? <span className="spinner" /> : schedChoice === 'now' ? 'Activate Now' : 'Schedule Activation'}
              </button>
            </div>
          </div>
        </div>
      )}

      {evictModal && (
        <div className="modal-overlay" onClick={() => setEvictModal(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-title">{unit.paymentBlock ? 'Deactivate Eviction Mode' : 'Activate Eviction Mode'} - Unit {unit.unitNumber}</div>
            {!unit.paymentBlock ? (
              <>
                <div className="alert alert-danger">
                  <AlertTriangle size={16} />
                  <div><strong>Warning:</strong> in many jurisdictions, accepting rent while pursuing eviction may waive your right to proceed. This hard-blocks all tenant ACH immediately. Check your local laws before accepting any payment.</div>
                </div>
                <p style={{ fontSize: '.875rem', color: 'var(--text-2)', marginBottom: 20 }}>No rent collected and no disbursement made until deactivated.</p>
                <label style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 20, cursor: 'pointer' }}>
                  <input type="checkbox" checked={evictConfirm} onChange={e => setEvictConfirm(e.target.checked)} style={{ marginTop: 3 }} />
                  <span style={{ fontSize: '.82rem', color: 'var(--text-1)' }}>I understand. Activate Eviction Mode for Unit {unit.unitNumber}.</span>
                </label>
                <div className="modal-footer">
                  <button className="btn btn-ghost" onClick={() => setEvictModal(false)}>Cancel</button>
                  <button className="btn btn-danger" disabled={!evictConfirm || evictMut.isLoading} onClick={() => evictMut.mutate({ enable: true })}>
                    {evictMut.isLoading ? <span className="spinner" /> : 'Activate'}
                  </button>
                </div>
              </>
            ) : (
              <>
                <p style={{ fontSize: '.875rem', color: 'var(--text-2)', marginBottom: 20 }}>This will resume ACH rent collection. Only deactivate if eviction is resolved.</p>
                <div className="modal-footer">
                  <button className="btn btn-ghost" onClick={() => setEvictModal(false)}>Cancel</button>
                  <button className="btn btn-secondary" disabled={evictMut.isLoading} onClick={() => evictMut.mutate({ enable: false })}>
                    {evictMut.isLoading ? <span className="spinner" /> : 'Deactivate'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}


// ── UNIT METERS (S533) ───────────────────────────────────────────────
// Sub-meters belong to the unit: add/edit/remove them here. Readings happen
// through the monthly reading run; billing is automatic.
//
// S613 (Nic): "I also wanna figure out how to link subtypes to different units
// because there's nowhere that I can see that links those."
//
// He was right — `units.subtype_id` was written when a unit was created and
// then displayed nowhere and editable nowhere. A landlord who defines his
// subtypes AFTER adding his spaces (which is the normal order, because you
// discover the classes by looking at what you have) could never say which
// space was which.
//
// Deliberately OUTSIDE the lease lock that covers the rest of this card. Saying
// which class a space belongs to commits no money and changes no lease term, so
// it works on an occupied unit — at Oak Park almost every space is occupied,
// and a classification you can only set between tenancies is a classification
// nobody can set. Copying the subtype's VALUES is the separate, explicit second
// step below, and it never moves rent on a leased unit.
function UnitSubtypeRow({ unit }: { unit: any }) {
  const qc = useQueryClient()
  const { can } = usePerms()
  const [err, setErr] = useState('')
  const { data: subtypes = [] } = useQuery<PropertyUnitSubtype[]>(
    ['property-unit-subtypes', unit.propertyId],
    () => apiGet(`/properties/${unit.propertyId}/unit-subtypes`),
    { enabled: !!unit.propertyId },
  )
  const forType = (subtypes as PropertyUnitSubtype[]).filter(s => s.unitType === unit.unitType)
  const current = forType.find(s => s.id === unit.subtypeId) || null

  const linkMut = useMutation(
    (body: { subtypeId: string | null; applyDetails?: boolean }) => apiPatch(`/units/${unit.id}/subtype`, body),
    {
      onSuccess: (data: any) => {
        setErr('')
        if (data?.pricingHeldBack) {
          toast('Details applied. Rent and deposit were left alone — this unit has an active lease.')
        }
        qc.invalidateQueries(['unit', unit.id])
        qc.invalidateQueries(['property-unit-subtypes', unit.propertyId])
      },
      onError: (e: any) => setErr(e?.response?.data?.error || 'Could not set that subtype'),
    },
  )

  // What the unit would gain by applying — shown so "Apply" is never a leap of
  // faith. Blank subtype fields say nothing about the unit and are skipped.
  const diffs: string[] = []
  if (current) {
    const differs = (a: any, b: any) => a != null && a !== '' && a !== 'none' && String(a) !== String(b)
    if (unit.unitType === 'rv_spot') {
      if (differs(current.rvSiteLayout, unit.rvSiteLayout)) diffs.push(current.rvSiteLayout === 'pull_through' ? 'pull-through' : 'back-in')
      if (differs(current.rvAmpService, unit.rvAmpService)) diffs.push(current.rvAmpService === 'both' ? '30/50 amp' : `${current.rvAmpService} amp`)
    }
    if (UNIT_TYPE_HAS_BEDROOMS[unit.unitType as UnitType]) {
      if (differs(current.bedrooms, unit.bedrooms)) diffs.push(`${current.bedrooms} bed`)
      if (differs(current.bathrooms, unit.bathrooms)) diffs.push(`${current.bathrooms} bath`)
    }
    if (unit.unitType === 'storage' && differs(current.storageSize, unit.storageSize)) diffs.push(String(current.storageSize))
    if (!unit.hasActiveLease) {
      if (differs(current.rentAmount, unit.rentAmount)) diffs.push(`rent ${fmt(current.rentAmount)}`)
      if (differs(current.securityDeposit, unit.securityDeposit)) diffs.push(`deposit ${fmt(current.securityDeposit)}`)
    }
  }

  if (forType.length === 0 && !current) {
    // Nothing to pick from is itself an answer — say where subtypes come from
    // rather than showing an empty dropdown that looks broken.
    return (
      <div className="data-row"><span className="data-key">Subtype</span>
        <span className="data-val" style={{ color: 'var(--text-3)', fontSize: '.76rem' }}>
          None defined — add them on the property page
        </span>
      </div>
    )
  }

  return (
    <>
      <div className="data-row"><span className="data-key">Subtype</span>
        {can('schedule.configure_unit') ? (
          <select className="form-select" style={{ maxWidth: 220, fontSize: '.8rem', padding: '3px 8px' }}
            value={unit.subtypeId || ''} disabled={linkMut.isLoading}
            onChange={e => linkMut.mutate({ subtypeId: e.target.value || null })}>
            <option value="">— none —</option>
            {forType.map(s => (
              <option key={s.id} value={s.id}>
                {s.name}{unitSubtypeFactsLabel(s) ? ` (${unitSubtypeFactsLabel(s)})` : ''}
              </option>
            ))}
          </select>
        ) : (
          <span className="data-val">{current ? current.name : '—'}</span>
        )}
      </div>
      {err && <div style={{ color: 'var(--red)', fontSize: '.72rem', marginBottom: 6 }}>{err}</div>}
      {current && diffs.length > 0 && can('schedule.configure_unit') && (
        <div style={{ fontSize: '.7rem', color: 'var(--text-3)', margin: '-2px 0 8px', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span>This unit doesn&apos;t match it: {diffs.join(', ')}.</span>
          <button className="btn btn-secondary btn-sm" style={{ padding: '1px 8px', fontSize: '.7rem' }}
            disabled={linkMut.isLoading}
            onClick={() => linkMut.mutate({ subtypeId: current.id!, applyDetails: true })}>
            Copy onto this unit
          </button>
        </div>
      )}
    </>
  )
}

// S609: the old note here said "the utilities page has no meters list" — that
// stopped being true when the Utilities page grew its own meter management, so
// a submeter can now be created from EITHER screen. That is duplication worth
// naming rather than quietly leaving: the two must keep agreeing about what a
// submeter is (one unit, one utility, an opening read). They share the same
// endpoint, which is what keeps them honest — if that ever forks, consolidate
// on one screen rather than maintaining two.
function UnitMetersCard({ unitId, propertyId, unitNumber, embedded }: {
  unitId: string; propertyId: string; unitNumber: string
  /** S609: rendered INSIDE the Unit Details card — drop the card chrome so it
   *  reads as a section of that form rather than a card nested in a card. */
  embedded?: boolean
}) {
  const qc = useQueryClient()
  const { data: meters = [] } = useQuery<any[]>(
    ['utility-meters', propertyId],
    () => apiGet(`/utility/meters?propertyId=${propertyId}`),
    { enabled: !!propertyId }
  )
  const mine = (meters as any[]).filter((m: any) => (m.assignedUnitIds || []).includes(unitId) && m.billingMethod === 'submeter')

  // S609 (Nic): the PROPERTY's shared charges, and whether THIS unit is on each.
  //
  // "I have set the trash rate, but where do you attach it to each unit? At Oak
  // Park we have some people that opt to not use our trash cans, and they run
  // their own trash down to the transfer station."
  //
  // It was always per-unit — a unit is billed only if it is assigned to the
  // meter — but the only place to say so was the Utilities page, unit by unit
  // from the meter's side. Asking "is THIS unit on trash?" meant opening a
  // different screen and reading a list backwards. Now it is a switch on the
  // unit, which is where the question gets asked.
  //
  // Landlord-pays masters are deliberately absent: nothing bills a tenant from
  // them, so a per-unit switch would imply a choice that changes nothing.
  // S609 (Nic): FLAT CHARGES AND SHARED METERS ARE DIFFERENT THINGS and must not
  // sit in one list. "You put trash as a master meter. It's not a master meter.
  // It's a toggle on or off for people that have it or don't. It's a flat rate."
  //
  // A shared master is a real meter someone reads and a pool that gets divided.
  // Trash is a fixed price and a yes/no. Listing them together made trash look
  // like equipment.
  // S613 (Nic): the two are no longer one list, and only ONE of them is a
  // switch here.
  //
  // "It shows all of the shared meters for the property, not just the one that
  //  that unit is part of... and then it lets you select back and forth willy
  //  nilly instead of actually going into the utilities page. That just needs to
  //  show which one it's a part of. It's informational only."
  //
  // He is right that these are different kinds of decision. A FLAT CHARGE is a
  // per-resident yes/no — the household that hauls its own trash — and the unit
  // page is exactly where that question gets asked. A SHARED METER is a piece of
  // plumbing: which master actually feeds this space, what the pool is, who else
  // divides it. Moving a unit between masters silently re-cuts every other
  // tenant's share on both meters, and it belongs on the Utilities page next to
  // the pool it changes — where the meter's own unit list makes the consequence
  // visible. Here it is a fact to read, not a control.
  const flatCharges = (meters as any[]).filter((m: any) => m.billingMethod === 'flat_rate')
  const onMeter = (m: any) => (m.assignedUnitIds || []).includes(unitId)
  const sharedMeters = (meters as any[]).filter((m: any) => m.billingMethod === 'rubs' && onMeter(m))

  const toggleMut = useMutation(
    async ({ meter, on }: { meter: any; on: boolean }) => {
      if (on) await apiPost(`/utility/meters/${meter.id}/units`, { unitId })
      else await apiDelete(`/utility/meters/${meter.id}/units/${unitId}`)
    },
    { onSuccess: () => qc.invalidateQueries(['utility-meters', propertyId]),
      // The server refuses a unit that is already on another meter of the same
      // kind for this utility — it would be billed twice. Surface that wording
      // rather than a silent no-op.
      onError: (e: any) => toast.error(e?.response?.data?.error || 'Could not change that') })
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState({ utilityType: 'electric', rate: '', digits: '6', sewerRate: '' })

  // S605 (Nic hit this): the picker hides utilities the unit already has, so on
  // a unit with an electric submeter the only option is Water — but the draft
  // still held 'electric' from its initial state. A <select> whose value matches
  // no option DISPLAYS the first one while keeping the old value, so the form
  // showed "water" and submitted "electric". That then failed the
  // double-billing guard (the unit already has an electric submeter) with an
  // error that made no sense against what was on screen.
  //
  // Derive the options once and force the draft onto a valid one whenever the
  // list changes, so what's displayed is always what gets sent.
  // Only electric and water have an odometer a walker can read. Trash is a flat
  // property charge and propane is a delivered fill — neither is a submeter, and
  // both are explained under Property charges below.
  const availableTypes = (['electric', 'water'] as const)
    .filter(t => !mine.some((m: any) => m.utilityType === t))
  useEffect(() => {
    if (availableTypes.length && !availableTypes.includes(draft.utilityType as any)) {
      setDraft(d => ({ ...d, utilityType: availableTypes[0] }))
    }
  }, [availableTypes.join(','), draft.utilityType])

  const [baselineFor, setBaselineFor] = useState<any | null>(null)
  const invalidate = () => qc.invalidateQueries(['utility-meters', propertyId])
  const addMut = useMutation(
    async () => {
      // S605: ONE call. This was create-then-assign, and when the assign was
      // refused the meter had already been created and stayed behind as an
      // orphan — Oak Park collected three before anyone noticed.
      await apiPost('/utility/meters', {
        propertyId, utilityType: draft.utilityType,
        label: `${unitNumber} ${draft.utilityType}`,
        billingMethod: 'submeter',
        ratePerUnit: draft.rate === '' ? null : Number(draft.rate),
        baseFee: 0, digits: Number(draft.digits) || 6,
        ...(draft.utilityType === 'water' && draft.sewerRate !== '' ? { sewerRatePerUnit: Number(draft.sewerRate) } : {}),
        assignUnitId: unitId,
      })
    },
    { onSuccess: () => { invalidate(); setAdding(false); setDraft({ utilityType: 'electric', rate: '', digits: '6', sewerRate: '' }) },
      onError: (e: any) => toast.error(e?.response?.data?.error || 'Could not add meter') }
  )
  const delMut = useMutation((id: string) => apiDelete(`/utility/meters/${id}`), {
    onSuccess: invalidate,
    onError: (e: any) => toast.error(e?.response?.data?.error || 'Could not remove meter'),
  })
  const ICONS: Record<string, string> = { water: '💧', electric: '⚡', sewer: '🚰', trash: '🗑️' }

  return (
    <div className={embedded ? '' : 'card'} style={embedded ? undefined : { marginTop: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        {embedded
          ? <div style={{ fontSize: '.72rem', fontWeight: 700, color: 'var(--text-2)', textTransform: 'uppercase', letterSpacing: '.04em' }}>Sub-meters</div>
          : <h3 style={{ fontSize: '.9rem', margin: 0 }}>Sub-meters</h3>}
        <button className="btn btn-primary btn-sm" onClick={() => setAdding(a => !a)}>{adding ? 'Close' : 'Add Meter'}</button>
      </div>
      {mine.length === 0 && !adding && (
        <div style={{ fontSize: '.78rem', color: 'var(--text-3)' }}>
          No sub-meters on this unit. Metered utilities bill the tenant through the monthly reading run; sewer bills off the water reading as part of the same line item.
        </div>
      )}
      {/* S609 (Nic): shared property charges, switchable per unit — see the note
          where propertyMeters is built. */}
      {/* S609 (Nic): shown even with NOTHING to list. A landlord with no trash
          meter yet saw an empty space and reasonably concluded there was nowhere
          to link trash — "I still don't see where to add trash into any sort of
          unit linkage." The answer is that the meter has to exist first, so the
          empty state says so instead of showing nothing. */}
      <div style={{ marginTop: mine.length || adding ? 12 : 10, borderTop: '1px solid var(--border-0)', paddingTop: 10 }}>
          <div style={{ fontSize: '.72rem', fontWeight: 700, color: 'var(--text-2)', textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 2 }}>
            Flat charges
          </div>
          <div style={{ fontSize: '.68rem', color: 'var(--text-3)', marginBottom: 8, lineHeight: 1.5 }}>
            Switch one off and this unit isn&apos;t billed for it — a resident hauling their own
            trash, for instance.
          </div>
          {/* S613: the nudge to "set a trash price in Rates" is WRONG for a
              landlord who bills trash by RUBS — following it creates a second
              trash meter and the double-billing guard then blocks his units.
              Only offered when the property has no trash setup at all. */}
          {flatCharges.length === 0 && ((meters as any[]).some((m: any) => m.utilityType === 'trash') ? (
            <div style={{ fontSize: '.72rem', color: 'var(--text-3)', lineHeight: 1.5, marginBottom: 4 }}>
              Nothing to switch here — this property bills trash on a shared meter, not as a flat
              charge. It&apos;s below.
            </div>
          ) : (
            <div style={{ fontSize: '.72rem', color: 'var(--text-3)', lineHeight: 1.5, marginBottom: 4 }}>
              Nothing to switch yet. A flat charge like <strong>trash</strong> appears here as soon as
              you set its price in <strong>Rates</strong> on the Utilities page — every unit starts
              off it, and you switch on the ones that have it.
            </div>
          ))}
          {flatCharges.map((m: any) => {
            const on = onMeter(m)
            return (
              <label key={m.id}
                style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 10px',
                         borderRadius: 8, background: 'var(--bg-2)', marginBottom: 6,
                         cursor: toggleMut.isLoading ? 'wait' : 'pointer', fontSize: '.8rem' }}>
                <input type="checkbox" checked={on} disabled={toggleMut.isLoading}
                  onChange={() => toggleMut.mutate({ meter: m, on: !on })} />
                <span style={{ fontWeight: 600 }}>
                  {ICONS[m.utilityType]} {m.utilityType[0].toUpperCase() + m.utilityType.slice(1)}
                </span>
                {/* The price lives on the property rate, not the row — see the
                    anti-discrimination note in services/utilityBilling. */}
                <span style={{ fontSize: '.7rem', color: 'var(--text-3)' }}>
                  flat charge — the property rate, same for everyone on it
                </span>
                {!on && (
                  <span style={{ marginLeft: 'auto', fontSize: '.68rem', color: 'var(--text-3)' }}>
                    not billed here
                  </span>
                )}
              </label>
            )
          })}

          {/* S613 (Nic): READ-ONLY, and only the masters this unit is actually
              on. Which master feeds a space is set on the Utilities page, beside
              the pool it divides. */}
          <div style={{ marginTop: 12 }}>
            <div style={{ fontSize: '.72rem', fontWeight: 700, color: 'var(--text-2)', textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 2 }}>
              Shared meters
            </div>
            {sharedMeters.length === 0 ? (
              <div style={{ fontSize: '.68rem', color: 'var(--text-3)', lineHeight: 1.5 }}>
                This unit isn&apos;t on a shared meter. Which master serves a unit is set on the
                <strong> Utilities</strong> page, on the meter itself.
              </div>
            ) : (
              <>
                {sharedMeters.map((m: any) => (
                  <div key={m.id}
                    style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 10px',
                             borderRadius: 8, background: 'var(--bg-2)', marginBottom: 6, fontSize: '.8rem' }}>
                    <span style={{ fontWeight: 600 }}>{ICONS[m.utilityType]} {m.label}</span>
                    <span style={{ fontSize: '.7rem', color: 'var(--text-3)' }}>
                      split across the units on it
                    </span>
                  </div>
                ))}
                <div style={{ fontSize: '.66rem', color: 'var(--text-3)', lineHeight: 1.5 }}>
                  Change which units a master serves on the <strong>Utilities</strong> page — moving one
                  re-cuts everybody else&apos;s share of both meters.
                </div>
              </>
            )}
          </div>
          {/* Propane has no meter anywhere — a fill is an event, not a reading —
              so it is worth saying rather than leaving someone hunting. */}
          <div style={{ fontSize: '.66rem', color: 'var(--text-3)', marginTop: 8, lineHeight: 1.5 }}>
            Propane isn&apos;t linked to a unit: there is no propane meter. Set the price per gallon
            in <strong>Rates</strong>, then use <strong>Record Delivery</strong> and enter the gallons
            that went into this tank.
          </div>
      </div>
      {mine.map((m: any) => (
        <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 12px', borderRadius: 8, background: 'var(--bg-2)', marginBottom: 6 }}>
          <span style={{ fontSize: '.82rem', fontWeight: 600, minWidth: 110, textTransform: 'capitalize' }}>{ICONS[m.utilityType]} {m.utilityType}</span>
          <span className="mono" style={{ fontSize: '.75rem', color: 'var(--text-3)' }}>{m.digits}-digit</span>
          <span className="mono" style={{ fontSize: '.78rem' }}>
            {m.ratePerUnit != null ? `$${Number(m.ratePerUnit)}/unit` : 'no rate'}
            {m.utilityType === 'water' && m.sewerRatePerUnit != null && ` + sewer $${Number(m.sewerRatePerUnit)}/unit`}
          </span>
          <span style={{ fontSize: '.72rem', color: 'var(--text-3)' }}>{m.lastReadingCycle ? `last read ${String(m.lastReadingCycle).slice(0, 7)}` : 'never read'}</span>
          {/* S605 (Nic): the opening read can always be added LATER — what
              matters is that it lands before the cycle is billed. Surfaced here
              as well as on the Utilities page because a landlord setting up a
              unit works from this screen and would otherwise never see it. */}
          {m.hasBaseline === false && (
            <button className="btn btn-ghost btn-sm" style={{ color: 'var(--red)', padding: '2px 8px' }}
              title="This meter has no opening read, so it cannot bill its first cycle"
              onClick={() => setBaselineFor(m)}>
              ⚠ add opening read
            </button>
          )}
          <button className="btn btn-ghost btn-sm" style={{ marginLeft: 'auto', color: 'var(--red)' }}
            onClick={() => { appConfirm(`Remove the ${m.utilityType} meter? Its readings go with it.`, { danger: true, confirmLabel: 'Remove' }).then(ok => { if (ok) delMut.mutate(m.id) }) }}>Remove</button>
        </div>
      ))}
      {baselineFor && (
        <OpeningReadModal meter={baselineFor} onClose={() => setBaselineFor(null)} onSaved={() => { invalidate(); setBaselineFor(null) }} />
      )}
      {adding && availableTypes.length === 0 && (
        <div style={{ fontSize: '.78rem', color: 'var(--text-3)', padding: '10px 12px', borderRadius: 8, background: 'var(--bg-2)' }}>
          This unit already has a submeter for every utility GAM meters (electric and water).
          Remove one above to replace it.
        </div>
      )}
      {adding && availableTypes.length > 0 && (
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '10px 12px', borderRadius: 8, background: 'var(--bg-2)' }}>
          <select className="input" value={draft.utilityType} onChange={e => setDraft(d => ({ ...d, utilityType: e.target.value }))} style={{ width: 120 }}>
            {availableTypes.map(t => <option key={t} value={t}>{ICONS[t]} {t}</option>)}
          </select>
          <input className="input" type="text" inputMode="decimal" placeholder="$/unit e.g. 0.14" value={draft.rate}
            onChange={e => { const v = e.target.value; if (v === '' || /^\d*\.?\d*$/.test(v)) setDraft(d => ({ ...d, rate: v })) }} style={{ width: 140 }} />
          <select className="input" value={draft.digits} onChange={e => setDraft(d => ({ ...d, digits: e.target.value }))} style={{ width: 110 }}>
            {[4, 5, 6, 7, 8].map(d => <option key={d} value={String(d)}>{d}-digit</option>)}
          </select>
          {draft.utilityType === 'water' && (
            <input className="input" type="text" inputMode="decimal" placeholder="sewer $/gal (optional)" value={draft.sewerRate}
              onChange={e => { const v = e.target.value; if (v === '' || /^\d*\.?\d*$/.test(v)) setDraft(d => ({ ...d, sewerRate: v })) }} style={{ width: 170 }} />
          )}
          <button className="btn btn-primary btn-sm" disabled={addMut.isLoading} onClick={() => addMut.mutate()}>Add</button>
        </div>
      )}
    </div>
  )
}

// S605 (Nic): "make sure that if we don't have an opening meter read at the
// minute we are setting up the meters, we can go back through and add the
// opening read before the billing cycle is done."
//
// The read is BACKDATED on purpose. A submeter's first bill is (cycle read −
// prior read), and the prior-read lookup is point-in-time: it takes the newest
// reading dated BEFORE the cycle read. So an opening read entered late still
// works, as long as its date precedes the reads it is meant to enable. Dating
// it today would place it after an earlier cycle read and produce nothing —
// which is why the date is editable and defaults to the start of the month
// rather than to now.
function OpeningReadModal({ meter, onClose, onSaved }: { meter: any; onClose: () => void; onSaved: () => void }) {
  const [value, setValue] = useState('')
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 8) + '01')
  const [err, setErr] = useState('')
  const save = useMutation(
    () => apiPost(`/utility/meters/${meter.id}/readings`, {
      readingValue: Number(value), readingDate: date,
      billingCycleMonth: date.slice(0, 7) + '-01', reason: 'baseline',
    }),
    { onSuccess: onSaved,
      onError: (e: any) => setErr(e?.response?.data?.error || 'Could not save the opening read') },
  )
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 420 }} onClick={e => e.stopPropagation()}>
        <div className="modal-title">Opening read — {meter.label}</div>
        <div style={{ fontSize: '.82rem', color: 'var(--text-2)', marginBottom: 14, lineHeight: 1.55 }}>
          Usage is the difference between two reads, so this meter can't bill until it has a
          starting point. Enter what the meter face read when the tenancy or cycle began —
          <strong> date it before the reads you want to bill</strong>.
        </div>
        <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          <input className="input" type="number" value={value} autoFocus
            onChange={e => setValue(e.target.value)}
            placeholder={`${meter.digits}-digit read`} style={{ flex: 2 }} />
          <input className="input" type="date" value={date}
            onChange={e => setDate(e.target.value)} style={{ flex: 1 }} />
        </div>
        {err && (
          <div style={{ color: 'var(--red)', fontSize: '.78rem', background: 'rgba(255,71,87,.08)', border: '1px solid rgba(255,71,87,.2)', borderRadius: 8, padding: '8px 12px', marginBottom: 12 }}>{err}</div>
        )}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={value === '' || save.isLoading}
            onClick={() => { setErr(''); save.mutate() }}>
            {save.isLoading ? 'Saving…' : 'Save opening read'}
          </button>
        </div>
      </div>
    </div>
  )
}

// S568 (Nic): financed home/RV sale. A landlord sells a park-owned home to the
// tenant, financed over N years — a separate amortized "home payment" that bills
// alongside space rent, auto-stops at term, and flips the unit to tenant-owned on
// payoff. Shows the contract + progress if one exists; otherwise offers setup.
function FinancedSaleSection({ unitId }: { unitId: string }) {
  const qc = useQueryClient()
  const { data } = useQuery(['home-sale', unitId], () => apiGet<any>(`/home-sales/unit/${unitId}`))
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState({ planType: 'flat', salePrice: '', downPayment: '0', annualInterestRate: '', termMonths: '', monthlyAmount: '', numberOfPayments: '', startMonth: new Date().toISOString().slice(0, 7) + '-01' })
  const [err, setErr] = useState<string | null>(null)

  const contract = data?.contract
  const schedule: any[] = data?.schedule || []
  const eligible = data?.eligibleLease
  const canSetUp = !contract || contract.status !== 'active'

  const create = useMutation(
    () => apiPost(`/home-sales`, form.planType === 'flat'
      ? { unitId, leaseId: eligible?.leaseId, tenantId: eligible?.primaryTenantId, planType: 'flat',
          monthlyAmount: Number(form.monthlyAmount), numberOfPayments: Number(form.numberOfPayments),
          startMonth: form.startMonth }
      : { unitId, leaseId: eligible?.leaseId, tenantId: eligible?.primaryTenantId, planType: 'amortized',
          salePrice: Number(form.salePrice), downPayment: Number(form.downPayment || 0),
          annualInterestRate: Number(form.annualInterestRate || 0), termMonths: Number(form.termMonths),
          startMonth: form.startMonth }),
    { onSuccess: () => { qc.invalidateQueries(['home-sale', unitId]); setOpen(false); toast('Financed sale set up.') },
      onError: (e: any) => setErr(e?.response?.data?.message || e?.message || 'Could not create the contract.') })

  const cancel = useMutation(
    () => apiPost(`/home-sales/${contract.id}/cancel`, {}),
    { onSuccess: () => { qc.invalidateQueries(['home-sale', unitId]); toast('Financed sale cancelled.') } })

  return (
    <div className="card" style={{ gridColumn: '1 / -1' }}>
      <div className="card-title" style={{ marginBottom: 16 }}>Financed sale (home / RV)</div>

      {contract && contract.status === 'active' && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 10, marginBottom: 14 }}>
            {[['Monthly payment', fmt(contract.monthlyPayment)],
              ['Financed', fmt(contract.financedAmount)],
              contract.planType === 'flat' ? ['Plan', 'Flat monthly'] : ['Rate', `${Number(contract.annualInterestRate)}%`],
              ['Progress', `${contract.installmentsPaid}/${contract.installmentsTotal} paid`]].map(([k, v]) => (
              <div key={k} style={{ background: 'var(--bg-2)', border: '1px solid var(--border-0)', borderRadius: 10, padding: '12px 14px' }}>
                <div style={{ fontSize: '.65rem', fontWeight: 700, color: 'var(--text-3)', textTransform: 'uppercase', marginBottom: 6 }}>{k}</div>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: '.95rem', fontWeight: 700, color: 'var(--text-0)' }}>{v}</div>
              </div>
            ))}
          </div>
          <div style={{ fontSize: '.72rem', color: 'var(--text-3)', marginBottom: 10 }}>
            {contract.planType === 'flat'
              ? `Flat plan · ${contract.installmentsTotal} payments of ${fmt(contract.monthlyPayment)} · total ${fmt(contract.salePrice)}.`
              : `Sale price ${fmt(contract.salePrice)} · down ${fmt(contract.downPayment)} · ${contract.termMonths}-month term.`}
            {' '}Billed as a separate “Home payment” each month alongside space rent; stops automatically at payoff, then the unit becomes tenant-owned.
          </div>
          {schedule.length > 0 && (
            <div style={{ maxHeight: 180, overflowY: 'auto', border: '1px solid var(--border-0)', borderRadius: 8 }}>
              <table style={{ width: '100%', fontSize: '.72rem', borderCollapse: 'collapse' }}>
                <thead><tr style={{ color: 'var(--text-3)', textAlign: 'left' }}>
                  <th style={{ padding: '6px 10px' }}>#</th><th>Month</th><th>Amount</th><th>Principal</th><th>Interest</th><th>Balance</th><th>Status</th>
                </tr></thead>
                <tbody>
                  {schedule.map((s: any) => (
                    <tr key={s.installmentNumber} style={{ borderTop: '1px solid var(--border-0)' }}>
                      <td style={{ padding: '5px 10px' }}>{s.installmentNumber}</td>
                      <td>{String(s.billingMonth).slice(0, 7)}</td>
                      <td>{fmt(s.amount)}</td><td>{fmt(s.principalPortion)}</td><td>{fmt(s.interestPortion)}</td><td>{fmt(s.remainingBalance)}</td>
                      <td>{s.paymentStatus ? humanize(s.paymentStatus) : (s.paymentId ? 'billed' : '—')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <button className="btn btn-ghost btn-sm" style={{ marginTop: 12 }} disabled={cancel.isLoading}
            onClick={() => cancel.mutate()}>Cancel financing</button>
        </>
      )}

      {contract && contract.status === 'paid_off' && (
        <div style={{ color: 'var(--green)', fontSize: '.85rem' }}>Paid off — the home is now tenant-owned.</div>
      )}

      {canSetUp && (!contract || contract.status === 'cancelled') && (
        data?.dwellingOwnership !== 'landlord' ? (
          <div style={{ color: 'var(--text-3)', fontSize: '.82rem' }}>
            This unit is tenant-owned — there’s no park-owned home to finance. Set the dwelling to park-owned first if you’re selling one.
          </div>
        ) : !eligible ? (
          <div style={{ color: 'var(--text-3)', fontSize: '.82rem' }}>Assign a tenant on an active lease to set up a financed sale.</div>
        ) : !open ? (
          <button className="btn btn-primary btn-sm" onClick={() => setOpen(true)}>Set up financed sale</button>
        ) : (
          <div>
            <div style={{ fontSize: '.78rem', color: 'var(--text-2)', marginBottom: 10 }}>
              Buyer: {eligible.tenantFirst} {eligible.tenantLast}. Space rent stays on their lease; this adds a separate monthly home payment that stops after the last payment.
            </div>
            {/* Plan shape: flat recurring, or interest-bearing amortized. */}
            <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
              {[['flat', 'Flat monthly'], ['amortized', 'Amortized (interest)']].map(([v, label]) => (
                <button key={v} type="button"
                  className={`btn btn-sm ${form.planType === v ? 'btn-primary' : 'btn-ghost'}`}
                  onClick={() => setForm({ ...form, planType: v })}>{label}</button>
              ))}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,1fr)', gap: 8, maxWidth: 460 }}>
              {(form.planType === 'flat'
                ? [['monthlyAmount', 'Monthly payment ($)'], ['numberOfPayments', 'Number of payments']]
                : [['salePrice', 'Sale price'], ['downPayment', 'Down payment'], ['annualInterestRate', 'Interest rate (%/yr)'], ['termMonths', 'Term (months)']]
              ).map(([k, label]) => (
                <label key={k} style={{ fontSize: '.72rem', color: 'var(--text-3)' }}>{label}
                  <input className="form-input" inputMode="decimal" value={(form as any)[k]}
                    onChange={e => setForm({ ...form, [k]: e.target.value })} />
                </label>
              ))}
              <label style={{ fontSize: '.72rem', color: 'var(--text-3)' }}>First billing month
                <input className="form-input" type="month" value={String(form.startMonth).slice(0, 7)}
                  onChange={e => setForm({ ...form, startMonth: e.target.value + '-01' })} />
              </label>
            </div>
            {form.planType === 'flat' && form.monthlyAmount && form.numberOfPayments && (
              <div style={{ fontSize: '.72rem', color: 'var(--text-3)', marginTop: 8 }}>
                {form.numberOfPayments} payments of {fmt(Number(form.monthlyAmount))} · total {fmt(Number(form.monthlyAmount) * Number(form.numberOfPayments))}
              </div>
            )}
            {err && <div style={{ fontSize: '.72rem', color: 'var(--red)', marginTop: 8 }}>{err}</div>}
            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              <button className="btn btn-primary btn-sm"
                disabled={create.isLoading || (form.planType === 'flat' ? (!form.monthlyAmount || !form.numberOfPayments) : (!form.salePrice || !form.termMonths))}
                onClick={() => { setErr(null); create.mutate() }}>{create.isLoading ? 'Creating…' : 'Create contract'}</button>
              <button className="btn btn-ghost btn-sm" onClick={() => setOpen(false)}>Cancel</button>
            </div>
          </div>
        )
      )}
    </div>
  )
}

// S594 (Nic): resident-to-resident home sale. A resident who OWNS their home
// sells it to another resident on payments. GAM keeps the schedule + a copy of
// the contract on file — it processes NO money between them (the absolute
// distinction from the landlord→tenant financed sale above, which GAM bills).
function ResidentSaleSection({ unitId }: { unitId: string }) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const { data } = useQuery(['resident-sale', unitId], () => apiGet<any>(`/resident-home-sales/unit/${unitId}`))
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState({ planType: 'flat', buyerName: '', buyerEmail: '', salePrice: '', downPayment: '0', annualInterestRate: '', termMonths: '', monthlyAmount: '', numberOfPayments: '', notes: '', startMonth: new Date().toISOString().slice(0, 7) + '-01' })
  const [err, setErr] = useState<string | null>(null)
  const [file, setFile] = useState<File | null>(null)

  const sale = data?.sale
  const schedule: any[] = data?.schedule || []
  const owner = data?.currentOwner
  const dwelling = data?.dwellingOwnership
  const canSetUp = !sale || sale.status !== 'active'

  const create = useMutation(
    () => apiPost('/resident-home-sales', form.planType === 'flat'
      ? { unitId, planType: 'flat', buyerName: form.buyerName.trim(), buyerEmail: form.buyerEmail.trim(),
          monthlyAmount: Number(form.monthlyAmount), numberOfPayments: Number(form.numberOfPayments),
          notes: form.notes.trim() || null, startMonth: form.startMonth }
      : { unitId, planType: 'amortized', buyerName: form.buyerName.trim(), buyerEmail: form.buyerEmail.trim(),
          salePrice: Number(form.salePrice), downPayment: Number(form.downPayment || 0),
          annualInterestRate: Number(form.annualInterestRate || 0), termMonths: Number(form.termMonths),
          notes: form.notes.trim() || null, startMonth: form.startMonth }),
    { onSuccess: () => { qc.invalidateQueries(['resident-sale', unitId]); setOpen(false); toast('Resident sale recorded.') },
      onError: (e: any) => setErr(e?.response?.data?.message || e?.message || 'Could not record the sale.') })

  const markPaid = useMutation(
    ({ n, paid }: { n: number; paid: boolean }) => apiPost(`/resident-home-sales/${sale.id}/installments/${n}/mark-paid`, { paid }),
    { onSuccess: () => { qc.invalidateQueries(['resident-sale', unitId]); qc.invalidateQueries(['home-owner', unitId]); qc.invalidateQueries(['unit', unitId]) } })

  const cancel = useMutation(
    () => apiPost(`/resident-home-sales/${sale.id}/cancel`, {}),
    { onSuccess: () => { qc.invalidateQueries(['resident-sale', unitId]); toast('Resident sale cancelled.') } })

  const uploadContract = useMutation(
    async () => {
      const fd = new FormData(); fd.append('file', file!)
      const res = await fetch(`${(import.meta as any).env?.VITE_API_URL}/api/resident-home-sales/${sale.id}/contract`, {
        method: 'POST', headers: { Authorization: 'Bearer ' + (localStorage.getItem('gam_token') || '') }, body: fd })
      const j = await res.json(); if (!res.ok) throw new Error(j?.error || 'Upload failed'); return j
    },
    { onSuccess: () => { setFile(null); qc.invalidateQueries(['resident-sale', unitId]); toast('Contract uploaded.') },
      onError: (e: any) => setErr(e?.message || 'Upload failed') })

  return (
    <div className="card" style={{ gridColumn: '1 / -1' }}>
      <div className="card-title" style={{ marginBottom: 8 }}>Resident-to-resident sale</div>
      <div style={{ fontSize: '.72rem', color: 'var(--text-3)', marginBottom: 14 }}>
        For a resident selling their own home to another resident on payments. GAM keeps the schedule and a copy of the contract on file — it does not process the money between them.
      </div>

      {dwelling !== 'tenant' ? (
        <div style={{ color: 'var(--text-3)', fontSize: '.82rem' }}>This home is park-owned — use the financed sale above. Resident-to-resident sales apply once a home is tenant-owned.</div>
      ) : !owner ? (
        <div style={{ color: 'var(--text-3)', fontSize: '.82rem' }}>Record the home’s current owner (the seller) above first, then set up the sale.</div>
      ) : (
        <>
          {sale && sale.status === 'active' && (
            <>
              <div style={{ fontSize: '.78rem', color: 'var(--text-2)', marginBottom: 10 }}>
                {sale.sellerFirst} {sale.sellerLast} → {sale.buyerFirst} {sale.buyerLast} · {sale.installmentsPaid}/{sale.installmentsTotal} paid · {sale.planType === 'flat' ? `${sale.installmentsTotal} × ${fmt(sale.monthlyPayment)}` : `${fmt(sale.salePrice)} @ ${Number(sale.annualInterestRate)}%`}
              </div>
              {schedule.length > 0 && (
                <div style={{ maxHeight: 200, overflowY: 'auto', border: '1px solid var(--border-0)', borderRadius: 8 }}>
                  <table style={{ width: '100%', fontSize: '.72rem', borderCollapse: 'collapse' }}>
                    <thead><tr style={{ color: 'var(--text-3)', textAlign: 'left' }}><th style={{ padding: '6px 10px' }}>#</th><th>Month</th><th>Amount</th><th>Paid</th><th></th></tr></thead>
                    <tbody>
                      {schedule.map((s: any) => (
                        <tr key={s.installmentNumber} style={{ borderTop: '1px solid var(--border-0)' }}>
                          <td style={{ padding: '5px 10px' }}>{s.installmentNumber}</td>
                          <td>{String(s.dueMonth).slice(0, 7)}</td>
                          <td>{fmt(s.amount)}</td>
                          <td>{s.paid ? '✓' : '—'}</td>
                          <td><button className="btn btn-ghost btn-sm" disabled={markPaid.isLoading} onClick={() => markPaid.mutate({ n: s.installmentNumber, paid: !s.paid })}>{s.paid ? 'Unmark' : 'Mark paid'}</button></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <div style={{ marginTop: 12, fontSize: '.75rem' }}>
                {sale.contractName
                  ? <button className="btn btn-ghost btn-sm" onClick={() => navigate(`/view?src=${encodeURIComponent(`/resident-home-sales/${sale.id}/contract`)}&title=${encodeURIComponent(sale.contractName)}`)}>View contract on file</button>
                  : <span style={{ color: 'var(--text-3)' }}>No contract uploaded yet.</span>}
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
                  <input type="file" onChange={e => setFile(e.target.files?.[0] || null)} />
                  <button className="btn btn-ghost btn-sm" disabled={!file || uploadContract.isLoading} onClick={() => uploadContract.mutate()}>{uploadContract.isLoading ? 'Uploading…' : 'Upload contract'}</button>
                </div>
              </div>
              <button className="btn btn-ghost btn-sm" style={{ marginTop: 12 }} disabled={cancel.isLoading} onClick={() => cancel.mutate()}>Cancel sale</button>
            </>
          )}

          {sale && sale.status === 'paid_off' && (
            <div style={{ color: 'var(--green)', fontSize: '.85rem' }}>Paid off — {sale.buyerFirst} {sale.buyerLast} now owns the home.</div>
          )}

          {canSetUp && (!sale || sale.status === 'cancelled') && (
            !open ? (
              <button className="btn btn-primary btn-sm" onClick={() => setOpen(true)}>Record resident sale</button>
            ) : (
              <div>
                <div style={{ fontSize: '.78rem', color: 'var(--text-2)', marginBottom: 10 }}>Seller: {owner.firstName} {owner.lastName}. Enter the buyer and the terms the residents agreed on.</div>
                <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
                  {[['flat', 'Flat monthly'], ['amortized', 'Amortized (interest)']].map(([v, label]) => (
                    <button key={v} type="button" className={`btn btn-sm ${form.planType === v ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setForm({ ...form, planType: v })}>{label}</button>
                  ))}
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,1fr)', gap: 8, maxWidth: 460 }}>
                  <label style={{ fontSize: '.72rem', color: 'var(--text-3)' }}>Buyer name<input className="form-input" value={form.buyerName} onChange={e => setForm({ ...form, buyerName: e.target.value })} /></label>
                  <label style={{ fontSize: '.72rem', color: 'var(--text-3)' }}>Buyer email<input className="form-input" value={form.buyerEmail} onChange={e => setForm({ ...form, buyerEmail: e.target.value })} /></label>
                  {(form.planType === 'flat'
                    ? [['monthlyAmount', 'Monthly payment ($)'], ['numberOfPayments', 'Number of payments']]
                    : [['salePrice', 'Sale price'], ['downPayment', 'Down payment'], ['annualInterestRate', 'Interest rate (%/yr)'], ['termMonths', 'Term (months)']]
                  ).map(([k, label]) => (
                    <label key={k} style={{ fontSize: '.72rem', color: 'var(--text-3)' }}>{label}
                      <input className="form-input" inputMode="decimal" value={(form as any)[k]} onChange={e => setForm({ ...form, [k]: e.target.value })} /></label>
                  ))}
                  <label style={{ fontSize: '.72rem', color: 'var(--text-3)' }}>First payment month
                    <input className="form-input" type="month" value={String(form.startMonth).slice(0, 7)} onChange={e => setForm({ ...form, startMonth: e.target.value + '-01' })} /></label>
                </div>
                {err && <div style={{ fontSize: '.72rem', color: 'var(--red)', marginTop: 8 }}>{err}</div>}
                <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                  <button className="btn btn-primary btn-sm"
                    disabled={create.isLoading || !form.buyerName || !/.+@.+\..+/.test(form.buyerEmail) || (form.planType === 'flat' ? (!form.monthlyAmount || !form.numberOfPayments) : (!form.salePrice || !form.termMonths))}
                    onClick={() => { setErr(null); create.mutate() }}>{create.isLoading ? 'Recording…' : 'Record sale'}</button>
                  <button className="btn btn-ghost btn-sm" onClick={() => setOpen(false)}>Cancel</button>
                </div>
              </div>
            )
          )}
        </>
      )}
    </div>
  )
}

// S568 (Nic): who owns the tenant-owned home/RV on this lot — the economic
// sublessor. May be the occupant, an in-park investor, or an EXTERNAL investor
// who owns homes across many parks. Owner by email (existing account) or a new
// name+email (mints a free 'contact' account). Transfers keep prior owners as
// history so the park always has the record.
function HomeOwnerSection({ unitId }: { unitId: string }) {
  const qc = useQueryClient()
  const { data } = useQuery(['home-owner', unitId], () => apiGet<any>(`/home-ownerships/unit/${unitId}`))
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState({ ownerName: '', ownerEmail: '', acquiredVia: 'recorded', notes: '' })
  const [err, setErr] = useState<string | null>(null)

  const owner = data?.owner
  const history: any[] = data?.history || []

  const save = useMutation(
    () => apiPut(`/home-ownerships/unit/${unitId}`, {
      ownerName: form.ownerName.trim(), ownerEmail: form.ownerEmail.trim(),
      acquiredVia: form.acquiredVia, notes: form.notes.trim() || null,
    }),
    { onSuccess: () => { qc.invalidateQueries(['home-owner', unitId]); qc.invalidateQueries(['unit', unitId]); setOpen(false); setForm({ ownerName: '', ownerEmail: '', acquiredVia: 'recorded', notes: '' }); toast('Home owner recorded.') },
      onError: (e: any) => setErr(e?.response?.data?.message || e?.message || 'Could not record the owner.') })

  return (
    <div className="card" style={{ gridColumn: '1 / -1' }}>
      <div className="card-title" style={{ marginBottom: 16 }}>Home owner</div>
      {owner ? (
        <div className="data-row"><span className="data-key">Current owner</span>
          <span className="data-val">{owner.firstName} {owner.lastName} · {owner.email}
            {owner.ownerRole === 'contact' && <span style={{ color: 'var(--text-3)', fontSize: '.72rem' }}> (external)</span>}
          </span>
        </div>
      ) : (
        <div style={{ color: 'var(--text-3)', fontSize: '.82rem', marginBottom: 8 }}>
          No owner recorded. If this home is tenant/investor-owned, record who owns it (they’re the sublessor).
        </div>
      )}

      {history.length > 1 && (
        <div style={{ marginTop: 6, marginBottom: 8 }}>
          <div style={{ fontSize: '.68rem', fontWeight: 700, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 4 }}>Ownership history</div>
          {history.map((h: any) => (
            <div key={h.id} style={{ fontSize: '.74rem', color: h.status === 'active' ? 'var(--text-2)' : 'var(--text-3)' }}>
              {h.firstName} {h.lastName} — {humanize(h.acquiredVia)} {h.acquiredAt ? new Date(h.acquiredAt).toLocaleDateString() : ''} {h.status !== 'active' && '· transferred'}
            </div>
          ))}
        </div>
      )}

      {!open ? (
        <button className="btn btn-ghost btn-sm" style={{ marginTop: 8 }} onClick={() => { setErr(null); setOpen(true) }}>
          {owner ? 'Transfer / change owner' : 'Record home owner'}
        </button>
      ) : (
        <div style={{ marginTop: 10, padding: 12, background: 'var(--bg-2)', borderRadius: 10, border: '1px solid var(--border-0)', maxWidth: 480 }}>
          <div style={{ fontSize: '.72rem', color: 'var(--text-3)', marginBottom: 8 }}>
            Enter the owner’s name + email. If they don’t have a GAM account, a free one is created and they’re invited — external investors welcome.
          </div>
          <input className="form-input" style={{ marginBottom: 6 }} placeholder="Owner full name" value={form.ownerName} onChange={e => setForm({ ...form, ownerName: e.target.value })} />
          <input className="form-input" style={{ marginBottom: 6 }} placeholder="Owner email" value={form.ownerEmail} onChange={e => setForm({ ...form, ownerEmail: e.target.value })} />
          <select className="form-input" style={{ marginBottom: 6 }} value={form.acquiredVia} onChange={e => setForm({ ...form, acquiredVia: e.target.value })}>
            <option value="recorded">Recording current owner</option>
            <option value="sale">Sale</option>
            <option value="transfer">Transfer</option>
          </select>
          {err && <div style={{ fontSize: '.72rem', color: 'var(--red)', marginBottom: 6 }}>{err}</div>}
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-primary btn-sm" disabled={save.isLoading || !form.ownerName.trim() || !/.+@.+\..+/.test(form.ownerEmail)} onClick={() => { setErr(null); save.mutate() }}>{save.isLoading ? 'Saving…' : 'Save owner'}</button>
            <button className="btn btn-ghost btn-sm" onClick={() => setOpen(false)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  )
}
