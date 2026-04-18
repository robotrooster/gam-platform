import { useState, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { apiGet, apiPost, apiPatch } from '../lib/api'
import { ArrowLeft, Shield, CheckCircle, AlertTriangle, Camera, Trash2, ExternalLink } from 'lucide-react'

const getReservePhase = (pct: number) => ({ phase: pct >= 90 ? 'full' : pct >= 70 ? 'growth' : 'early' })

const fmt = (n: any) => n != null ? `$${Number(n).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2})}` : '—'

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
  const { data: payments = [] } = useQuery(['unit-payments', id], () => apiGet<any[]>('/payments?unitId=' + id))
  const { data: maintenance = [] } = useQuery(['unit-maint', id], () => apiGet<any[]>('/maintenance?unitId=' + id))

  const markAvailMut = useMutation(() => apiPost('/units/' + id + '/mark-available', {}), { onSuccess: () => qc.invalidateQueries(['unit', id]) })
  const markVacantMut = useMutation(() => apiPost('/units/' + id + '/mark-vacant', {}), { onSuccess: () => qc.invalidateQueries(['unit', id]) })
  const activateMut = useMutation(
    (body: { scheduledFor?: string }) => apiPost('/units/' + id + '/activate', body),
    { onSuccess: () => { qc.invalidateQueries(['unit', id]); setActivateModal(false); setSchedLocal(''); setSchedChoice('now') } }
  )
  const cancelSchedMut = useMutation(() => apiPost('/units/' + id + '/cancel-scheduled-activation', {}), { onSuccess: () => qc.invalidateQueries(['unit', id]) })

  const { data: photos = [], refetch: refetchPhotos } = useQuery(['unit-photos', id], () => apiGet<any[]>('/properties/units/' + id + '/photos'))

  // Init listing form from unit data
  if (unit && !listingInit) {
    setListingForm({
      availableDate: unit.available_date ? unit.available_date.split('T')[0] : '',
      listingDescription: unit.listing_description || '',
      listedVacant: unit.listed_vacant || false,
      bedrooms: unit.bedrooms?.toString() || '',
      bathrooms: unit.bathrooms?.toString() || '',
      sqft: unit.sqft?.toString() || '',
    })
    setListingInit(true)
  }

  const saveListing = async () => {
    setSavingListing(true); setListingMsg('')
    try {
      await apiPatch('/properties/units/' + id + '/listing', {
        availableDate: listingForm.availableDate || null,
        listingDescription: listingForm.listingDescription || null,
        listedVacant: listingForm.listedVacant,
        bedrooms: listingForm.bedrooms ? +listingForm.bedrooms : null,
        bathrooms: listingForm.bathrooms ? +listingForm.bathrooms : null,
        sqft: listingForm.sqft ? +listingForm.sqft : null,
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
      await fetch('http://localhost:4000/api/properties/units/' + id + '/photos', {
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
    await fetch('http://localhost:4000/api/properties/units/' + id + '/photos/' + photoId, {
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

  const { phase } = getReservePhase(econ?.occupiedPortfolio || 0)

  return (
    <div>
      <div className="page-header">
        <div className="flex items-center gap-12">
          <button className="btn btn-ghost btn-sm" onClick={() => navigate('/units')}><ArrowLeft size={15} /></button>
          <div>
            <h1 className="page-title">Unit {unit.unit_number}</h1>
            <p className="page-subtitle">{unit.property_name} - {unit.street1}, {unit.city}</p>
          </div>
        </div>
        <div className="flex gap-8">
          {unit.payment_block && <span className="badge badge-red"><Shield size={10} /> Eviction Mode</span>}
          {unit.on_time_pay_active && <span className="badge badge-green"><CheckCircle size={10} /> On-Time Pay Active</span>}
          {unit.scheduled_activation_at && (
            <span className="badge badge-amber" title={'Scheduled: ' + new Date(unit.scheduled_activation_at).toLocaleString()}>
              ⏰ Activation scheduled
            </span>
          )}
          {unit.status === 'vacant' && (
            <button className="btn btn-sm btn-secondary" onClick={() => markAvailMut.mutate()} disabled={markAvailMut.isLoading}>
              {markAvailMut.isLoading ? 'Saving…' : 'Mark Available'}
            </button>
          )}
          {unit.status === 'available' && (
            <>
              <button className="btn btn-sm btn-primary" onClick={() => setActivateModal(true)}>
                Activate
              </button>
              <button className="btn btn-sm btn-ghost" onClick={() => markVacantMut.mutate()} disabled={markVacantMut.isLoading}>
                Mark Vacant
              </button>
            </>
          )}
          {unit.scheduled_activation_at && (
            <button className="btn btn-sm btn-ghost" onClick={() => cancelSchedMut.mutate()} disabled={cancelSchedMut.isLoading}>
              Cancel schedule
            </button>
          )}
          <button
            className={'btn btn-sm ' + (unit.payment_block ? 'btn-secondary' : 'btn-danger')}
            onClick={() => { setEvictModal(true); setEvictConfirm(false) }}
          >
            <Shield size={13} /> {unit.payment_block ? 'Deactivate Eviction Mode' : 'Activate Eviction Mode'}
          </button>
        </div>
      </div>

      <div className="grid-2">
        <div className="card">
          <div className="card-title" style={{ marginBottom: 16 }}>Unit Details</div>
          <div className="data-row"><span className="data-key">Status</span><span className={'badge badge-' + (unit.status === 'active' ? 'green' : unit.status === 'vacant' ? 'muted' : 'amber')}>{unit.status}</span></div>
          <div className="data-row"><span className="data-key">Rent</span><span className="data-val mono">{fmt(unit.rent_amount)}/mo</span></div>
          <div className="data-row"><span className="data-key">Deposit</span><span className="data-val mono">{fmt(unit.security_deposit)}</span></div>
          <div className="data-row"><span className="data-key">Bedrooms</span><span className="data-val">{unit.bedrooms}</span></div>
          <div className="data-row"><span className="data-key">Bathrooms</span><span className="data-val">{unit.bathrooms}</span></div>
        </div>

        <div className="card">
          <div className="card-title" style={{ marginBottom: 16 }}>Tenant</div>
          {unit.tenant_first ? (
            <>
              <div className="data-row"><span className="data-key">Name</span><span className="data-val">{unit.tenant_first} {unit.tenant_last}</span></div>
              <div className="data-row"><span className="data-key">Email</span><span className="data-val">{unit.tenant_email}</span></div>
              <div className="data-row"><span className="data-key">ACH</span><span className={'badge ' + (unit.ach_verified ? 'badge-green' : 'badge-amber')}>{unit.ach_verified ? 'Verified' : 'Pending'}</span></div>
              <div className="data-row"><span className="data-key">SSI/SSDI</span><span className="data-val">{unit.ssi_ssdi ? 'Yes' : 'No'}</span></div>
              <div className="data-row"><span className="data-key">On-Time Pay</span><span className={'badge ' + (unit.on_time_pay_enrolled ? 'badge-green' : 'badge-muted')}>{unit.on_time_pay_enrolled ? 'Enrolled' : 'Not enrolled'}</span></div>
            </>
          ) : (
            <div style={{ color: 'var(--text-3)', fontSize: '.875rem', padding: '16px 0' }}>No tenant assigned.</div>
          )}
        </div>

        <div className="card" style={{ gridColumn: "1 / -1" }}>
          <div className="card-title" style={{ marginBottom: 16 }}>Unit Economics</div>
          <div style={{ display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:10, marginBottom:20 }}>
            <div style={{ background:"var(--bg-2)", border:"1px solid var(--border-0)", borderRadius:10, padding:"12px 14px" }}>
              <div style={{ fontSize:".65rem", fontWeight:700, color:"var(--text-3)", textTransform:"uppercase", marginBottom:6 }}>Net Monthly</div>
              <div style={{ fontFamily:"var(--font-mono)", fontSize:".95rem", fontWeight:700, color:"var(--green)" }}>{fmt(unit.rent_amount-(unit.status==="vacant"?0:unit.status==="direct_pay"?5:15))}</div>
            </div>
            <div style={{ background:"var(--bg-2)", border:"1px solid var(--border-0)", borderRadius:10, padding:"12px 14px" }}>
              <div style={{ fontSize:".65rem", fontWeight:700, color:"var(--text-3)", textTransform:"uppercase", marginBottom:6 }}>Projected Yearly</div>
              <div style={{ fontFamily:"var(--font-mono)", fontSize:".95rem", fontWeight:700, color:"var(--gold)" }}>{fmt((unit.rent_amount-(unit.status==="vacant"?0:unit.status==="direct_pay"?5:15))*12)}</div>
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
              <div className="data-row"><span className="data-key">Rent</span><span className="data-val mono">{fmt(unit.rent_amount)}/mo</span></div>
              <div className="data-row"><span className="data-key">Platform fee</span><span className="data-val mono" style={{ color:unit.status==="vacant"?"var(--text-3)":"var(--red)" }}>{unit.status==="vacant"?"Free (vacant)":unit.status==="direct_pay"?"-5.00/mo (direct pay)":"-15.00/mo (on-time pay)"}</span></div>
              <div className="data-row" style={{ borderTop:"1px solid var(--border-1)", paddingTop:8, marginTop:4 }}><span className="data-key" style={{ fontWeight:700 }}>Net monthly</span><span className="data-val mono" style={{ color:"var(--green)", fontWeight:700 }}>{fmt(unit.rent_amount-(unit.status==="vacant"?0:unit.status==="direct_pay"?5:15))}/mo</span></div>
              <div className="data-row"><span className="data-key">Projected yearly</span><span className="data-val mono" style={{ color:"var(--gold)" }}>{fmt((unit.rent_amount-(unit.status==="vacant"?0:unit.status==="direct_pay"?5:15))*12)}</span></div>
            </div>
            <div>
              <div style={{ fontSize:".68rem", fontWeight:700, color:"var(--text-3)", textTransform:"uppercase", letterSpacing:".08em", marginBottom:8 }}>Maintenance Costs</div>
              {(maintenance as any[]).filter((m:any)=>m.actual_cost).length===0
                ? <div style={{ fontSize:".78rem", color:"var(--text-3)" }}>No costs recorded.</div>
                : (maintenance as any[]).filter((m:any)=>m.actual_cost).slice(0,5).map((m:any)=>(
                    <div key={m.id} className="data-row"><span className="data-key" style={{ fontSize:".73rem" }}>{m.title}</span><span className="data-val mono" style={{ color:"var(--red)", fontSize:".73rem" }}>−{fmt(m.actual_cost)}</span></div>
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
            {(photos as any[]).length < 5 && <span style={{ fontSize: '.72rem', color: 'var(--amber)', fontWeight: 600 }}>⚠ {5 - (photos as any[]).length} more photo(s) needed to publish</span>}
            {(photos as any[]).length >= 5 && <span style={{ fontSize: '.72rem', color: 'var(--green)', fontWeight: 600 }}>✓ Ready to publish</span>}
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

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
            <div>
              <label style={{ display: 'block', fontSize: '.68rem', fontWeight: 700, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 4 }}>Bedrooms</label>
              <input type="number" min="0" step="1" value={listingForm.bedrooms} onChange={e => setListingForm(f => ({ ...f, bedrooms: e.target.value }))} style={{ width: '100%', background: 'var(--bg-2)', border: '1px solid var(--border-1)', borderRadius: 7, color: 'var(--text-0)', padding: '7px 10px', fontSize: '.875rem' }} />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: '.68rem', fontWeight: 700, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 4 }}>Bathrooms</label>
              <input type="number" min="0" step="0.5" value={listingForm.bathrooms} onChange={e => setListingForm(f => ({ ...f, bathrooms: e.target.value }))} style={{ width: '100%', background: 'var(--bg-2)', border: '1px solid var(--border-1)', borderRadius: 7, color: 'var(--text-0)', padding: '7px 10px', fontSize: '.875rem' }} />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: '.68rem', fontWeight: 700, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 4 }}>Sq Ft</label>
              <input type="number" min="0" value={listingForm.sqft} onChange={e => setListingForm(f => ({ ...f, sqft: e.target.value }))} style={{ width: '100%', background: 'var(--bg-2)', border: '1px solid var(--border-1)', borderRadius: 7, color: 'var(--text-0)', padding: '7px 10px', fontSize: '.875rem' }} />
            </div>
          </div>
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
                  <img src={'http://localhost:4000' + p.url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
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
          <a href="http://localhost:3008" target="_blank" rel="noreferrer" style={{ fontSize: '.78rem', color: 'var(--text-3)', display: 'flex', alignItems: 'center', gap: 4 }}>
            <ExternalLink size={12} /> View public listings page
          </a>
          <button className="btn btn-primary btn-sm" onClick={saveListing} disabled={savingListing}>
            {savingListing ? 'Saving…' : 'Save Listing'}
          </button>
        </div>
      </div>

      {activateModal && (
        <div className="modal-overlay" onClick={() => setActivateModal(false)}>
          <div className="modal" style={{ maxWidth: 520 }} onClick={e => e.stopPropagation()}>
            <div className="modal-title">Activate Unit {unit.unit_number}</div>
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
                    Time zone of the unit (based on state: <strong>{unit.state || 'AZ'}</strong>).
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
                    const tz = STATE_TZ[(unit.state || 'AZ').toUpperCase()] || 'America/Phoenix'
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
            <div className="modal-title">{unit.payment_block ? 'Deactivate Eviction Mode' : 'Activate Eviction Mode'} - Unit {unit.unit_number}</div>
            {!unit.payment_block ? (
              <>
                <div className="alert alert-danger">
                  <AlertTriangle size={16} />
                  <div><strong>Warning:</strong> in many jurisdictions, accepting rent while pursuing eviction may waive your right to proceed. This hard-blocks all tenant ACH immediately. Check your local laws before accepting any payment.</div>
                </div>
                <p style={{ fontSize: '.875rem', color: 'var(--text-2)', marginBottom: 20 }}>No rent collected and no disbursement made until deactivated.</p>
                <label style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 20, cursor: 'pointer' }}>
                  <input type="checkbox" checked={evictConfirm} onChange={e => setEvictConfirm(e.target.checked)} style={{ marginTop: 3 }} />
                  <span style={{ fontSize: '.82rem', color: 'var(--text-1)' }}>I understand. Activate Eviction Mode for Unit {unit.unit_number}.</span>
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
