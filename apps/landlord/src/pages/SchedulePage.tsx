import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { apiGet, apiPost, apiPatch } from '../lib/api'

const fmt = (n: any) => n != null ? `$${Number(n).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2})}` : '—'

const UNIT_TYPES = ['residential','rv_spot','storage','parking','short_term_cabin']
const UNIT_TYPE_LABELS: Record<string,string> = {
  residential:'🏠 Residential', rv_spot:'🚐 RV Spot', storage:'📦 Storage',
  parking:'🅿️ Parking', short_term_cabin:'🏕️ Short-Term Cabin'
}
const LEASE_TYPES = ['nightly','weekly','month_to_month','long_term']
const LEASE_TYPE_LABELS: Record<string,string> = {
  nightly:'Nightly', weekly:'Weekly', month_to_month:'Month-to-Month', long_term:'Long Term'
}
const TYPE_COLORS: Record<string,string> = {
  residential:'var(--blue)', rv_spot:'var(--green)', storage:'var(--amber)',
  parking:'var(--text-3)', short_term_cabin:'var(--gold)'
}
const STATUS_COLORS: Record<string,string> = {
  confirmed:'badge-green', pending:'badge-amber', cancelled:'badge-red', checked_in:'badge-blue'
}

function getDaysInRange(from: string, to: string) {
  const days = []
  const cur = new Date(from)
  const end = new Date(to)
  while (cur <= end) {
    days.push(cur.toISOString().split('T')[0])
    cur.setDate(cur.getDate() + 1)
  }
  return days
}

function addDays(dateStr: string, days: number) {
  const d = new Date(dateStr)
  d.setDate(d.getDate() + days)
  return d.toISOString().split('T')[0]
}

export function SchedulePage() {
  const qc = useQueryClient()
  const today = new Date().toISOString().split('T')[0]
  const [view, setView] = useState<'timeline'|'list'|'units'>('timeline')
  const [fromDate, setFromDate] = useState(today)
  const [toDate, setToDate] = useState(addDays(today, 30))
  const [filterType, setFilterType] = useState('all')
  const [bookingModal, setBookingModal] = useState<{show:boolean; unit:any}>({show:false, unit:null})
  const [typeModal, setTypeModal] = useState<{show:boolean; unit:any}>({show:false, unit:null})
  const [newBooking, setNewBooking] = useState({ guestName:'', guestEmail:'', guestPhone:'', leaseType:'nightly', checkIn:'', checkOut:'', totalAmount:'', notes:'' })
  const [typeForm, setTypeForm] = useState<any>({})

  const { data: schedule, isLoading } = useQuery(
    ['schedule', fromDate, toDate, filterType],
    () => apiGet(`/units/schedule/master?from=${fromDate}&to=${toDate}${filterType!=='all'?'&unitType='+filterType:''}`),
    { staleTime: 30000 }
  )

  const units: any[] = schedule?.units || []
  const bookings: any[] = schedule?.bookings || []
  const leases: any[] = schedule?.leases || []
  const days = getDaysInRange(fromDate, addDays(fromDate, Math.min(30, Math.ceil((new Date(toDate).getTime()-new Date(fromDate).getTime())/(1000*60*60*24)))))

  const createBookingMut = useMutation(
    () => apiPost(`/units/${bookingModal.unit?.id}/bookings`, { ...newBooking, totalAmount: Number(newBooking.totalAmount) }),
    { onSuccess: () => { qc.invalidateQueries('schedule'); setBookingModal({show:false,unit:null}); setNewBooking({ guestName:'', guestEmail:'', guestPhone:'', leaseType:'nightly', checkIn:'', checkOut:'', totalAmount:'', notes:'' }) } }
  )

  const updateTypeMut = useMutation(
    () => apiPatch(`/units/${typeModal.unit?.id}/type`, typeForm),
    { onSuccess: () => { qc.invalidateQueries('schedule'); setTypeModal({show:false,unit:null}) } }
  )

  const cancelBookingMut = useMutation(
    (id:string) => apiPatch(`/units/${bookingModal.unit?.id||'x'}/bookings/${id}`, { status:'cancelled' }),
    { onSuccess: () => qc.invalidateQueries('schedule') }
  )

  const getBookingsForUnit = (unitId: string) =>
    bookings.filter(b => b.unit_id === unitId)

  const getLeasesForUnit = (unitId: string) =>
    leases.filter(l => l.unit_id === unitId)

  const isDateBooked = (unitId: string, date: string) => {
    const unitBookings = getBookingsForUnit(unitId)
    const unitLeases = getLeasesForUnit(unitId)
    return unitBookings.some(b => date >= b.check_in && date < b.check_out) ||
           unitLeases.some(l => date >= l.start_date && date <= l.end_date)
  }

  const getBookingForDate = (unitId: string, date: string) => {
    return bookings.find(b => b.unit_id === unitId && date >= b.check_in && date < b.check_out) ||
           leases.find(l => l.unit_id === unitId && date >= l.start_date && date <= l.end_date)
  }

  const filteredUnits = filterType === 'all' ? units : units.filter(u => u.unit_type === filterType)

  const openTypeModal = (unit: any) => {
    setTypeForm({
      unitType: unit.unit_type || 'residential',
      nightlyRate: unit.nightly_rate || '',
      weeklyRate: unit.weekly_rate || '',
      monthlyRate: unit.monthly_rate || '',
      minStayNights: unit.min_stay_nights || 1,
      checkInTime: unit.check_in_time?.slice(0,5) || '15:00',
      checkOutTime: unit.check_out_time?.slice(0,5) || '11:00',
      amenities: (unit.amenities||[]).join(', '),
      unitDescription: unit.unit_description || '',
      isBookable: unit.is_bookable || false,
    })
    setTypeModal({show:true, unit})
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">Master Schedule</h1>
          <p className="page-subtitle">Bookings · Leases · Availability across all units</p>
        </div>
        <div style={{display:'flex',gap:8,alignItems:'center',flexWrap:'wrap'}}>
          <input type="date" className="form-input" value={fromDate} onChange={e=>setFromDate(e.target.value)} style={{fontSize:'.78rem'}} />
          <span style={{color:'var(--text-3)',fontSize:'.8rem'}}>to</span>
          <input type="date" className="form-input" value={toDate} onChange={e=>setToDate(e.target.value)} style={{fontSize:'.78rem'}} />
          {['all',...UNIT_TYPES].map(t => (
            <button key={t} className={`tab-btn ${filterType===t?'active':''}`} style={{fontSize:'.72rem',padding:'4px 10px',textTransform:'capitalize'}}
              onClick={()=>setFilterType(t)}>{t==='all'?'All Types':UNIT_TYPE_LABELS[t]||t}</button>
          ))}
        </div>
      </div>

      {/* View toggle */}
      <div style={{display:'flex',gap:6,marginBottom:16}}>
        {(['timeline','list','units'] as const).map(v => (
          <button key={v} className={`tab-btn ${view===v?'active':''}`} onClick={()=>setView(v)} style={{textTransform:'capitalize'}}>{v}</button>
        ))}
        <div style={{marginLeft:'auto',fontSize:'.78rem',color:'var(--text-3)',alignSelf:'center'}}>
          {filteredUnits.length} units · {bookings.length} bookings · {leases.length} active leases
        </div>
      </div>

      {isLoading && <div style={{padding:48,textAlign:'center',color:'var(--text-3)'}}>Loading schedule...</div>}

      {/* ── TIMELINE VIEW ── */}
      {!isLoading && view==='timeline' && (
        <div className="card" style={{padding:0,overflowX:'auto'}}>
          <table style={{width:'100%',borderCollapse:'collapse',minWidth:800}}>
            <thead>
              <tr>
                <th style={{background:'var(--bg-3)',padding:'8px 12px',textAlign:'left',fontSize:'.72rem',color:'var(--text-3)',fontWeight:600,position:'sticky',left:0,zIndex:2,minWidth:180,borderBottom:'1px solid var(--border-1)'}}>Unit</th>
                {days.map(d => (
                  <th key={d} style={{background:'var(--bg-3)',padding:'6px 4px',fontSize:'.65rem',color:d===today?'var(--gold)':'var(--text-3)',fontWeight:d===today?700:400,textAlign:'center',minWidth:32,borderBottom:'1px solid var(--border-1)',borderLeft:'1px solid var(--border-1)'}}>
                    <div>{new Date(d+'T12:00:00').toLocaleDateString('en-US',{month:'numeric',day:'numeric'})}</div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filteredUnits.map(unit => (
                <tr key={unit.id}>
                  <td style={{padding:'8px 12px',borderBottom:'1px solid var(--border-1)',position:'sticky',left:0,background:'var(--bg-2)',zIndex:1}}>
                    <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',gap:8}}>
                      <div>
                        <div style={{fontWeight:600,fontSize:'.82rem'}}>{unit.unit_number}</div>
                        <div style={{fontSize:'.68rem',color:TYPE_COLORS[unit.unit_type]||'var(--text-3)'}}>{UNIT_TYPE_LABELS[unit.unit_type]||unit.unit_type}</div>
                        <div style={{fontSize:'.65rem',color:'var(--text-3)'}}>{unit.property_name}</div>
                      </div>
                      <div style={{display:'flex',gap:4}}>
                        {unit.is_bookable && <button className="btn btn-ghost btn-sm" style={{fontSize:'.65rem',padding:'2px 6px'}} onClick={()=>{setBookingModal({show:true,unit});setNewBooking(b=>({...b,leaseType:unit.lease_types_allowed?.[0]||'nightly'}))}}>+ Book</button>}
                        <button className="btn btn-ghost btn-sm" style={{fontSize:'.65rem',padding:'2px 6px'}} onClick={()=>openTypeModal(unit)}>⚙</button>
                      </div>
                    </div>
                  </td>
                  {days.map(d => {
                    const booking = getBookingForDate(unit.id, d)
                    const isBooked = !!booking
                    const isStart = booking && (booking.check_in === d || booking.start_date === d)
                    return (
                      <td key={d} style={{borderBottom:'1px solid var(--border-1)',borderLeft:'1px solid var(--border-1)',padding:2,textAlign:'center',background:d===today?'rgba(201,162,39,.04)':''}}>
                        {isBooked ? (
                          <div style={{background:booking.guest_name?'var(--green)':'var(--blue)',borderRadius:3,height:24,display:'flex',alignItems:'center',justifyContent:'center',fontSize:'.6rem',color:'#fff',overflow:'hidden',whiteSpace:'nowrap',padding:'0 2px',opacity:.85}} title={booking.guest_name||booking.first_name||'Tenant'}>
                            {isStart ? (booking.guest_name||booking.first_name||'●').slice(0,8) : ''}
                          </div>
                        ) : (
                          <div style={{height:24,background:unit.is_bookable?'transparent':'var(--bg-3)',borderRadius:3,opacity:.3}} />
                        )}
                      </td>
                    )
                  })}
                </tr>
              ))}
              {filteredUnits.length===0 && (
                <tr><td colSpan={days.length+1} style={{textAlign:'center',padding:48,color:'var(--text-3)'}}>No units found.</td></tr>
              )}
            </tbody>
          </table>
          <div style={{padding:'8px 12px',fontSize:'.72rem',color:'var(--text-3)',display:'flex',gap:16,borderTop:'1px solid var(--border-1)'}}>
            <span><span style={{display:'inline-block',width:12,height:12,background:'var(--green)',borderRadius:2,marginRight:4}}/>Booking</span>
            <span><span style={{display:'inline-block',width:12,height:12,background:'var(--blue)',borderRadius:2,marginRight:4}}/>Lease</span>
            <span><span style={{display:'inline-block',width:12,height:12,background:'var(--gold)',borderRadius:2,opacity:.3,marginRight:4}}/>Today</span>
          </div>
        </div>
      )}

      {/* ── LIST VIEW ── */}
      {!isLoading && view==='list' && (
        <div style={{display:'grid',gap:12}}>
          {bookings.length===0 && leases.length===0 && <div className="card" style={{textAlign:'center',padding:48,color:'var(--text-3)'}}>No bookings or leases in this date range.</div>}
          {bookings.map(b => (
            <div key={b.id} className="card" style={{display:'flex',alignItems:'center',gap:16}}>
              <div style={{width:4,background:'var(--green)',borderRadius:2,alignSelf:'stretch'}} />
              <div style={{flex:1}}>
                <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:4}}>
                  <span style={{fontWeight:600,fontSize:'.88rem'}}>{b.unit_number}</span>
                  <span style={{fontSize:'.72rem',color:'var(--text-3)'}}>{b.property_name}</span>
                  <span className="badge badge-green" style={{fontSize:'.65rem'}}>{b.lease_type}</span>
                  <span className={`badge ${STATUS_COLORS[b.status]||'badge-muted'}`} style={{fontSize:'.65rem'}}>{b.status}</span>
                </div>
                <div style={{fontSize:'.82rem',color:'var(--text-2)'}}>
                  {b.guest_name||'Guest'} · {new Date(b.check_in+'T12:00:00').toLocaleDateString()} — {new Date(b.check_out+'T12:00:00').toLocaleDateString()} ({b.nights} nights)
                </div>
                {b.guest_email && <div style={{fontSize:'.75rem',color:'var(--text-3)'}}>{b.guest_email} · {b.guest_phone||''}</div>}
              </div>
              <div style={{textAlign:'right'}}>
                <div style={{fontWeight:700,color:'var(--gold)'}}>{fmt(b.total_amount)}</div>
                <div style={{fontSize:'.72rem',color:'var(--text-3)'}}>Fee: {fmt(b.platform_fee)}</div>
              </div>
            </div>
          ))}
          {leases.map(l => (
            <div key={l.id} className="card" style={{display:'flex',alignItems:'center',gap:16}}>
              <div style={{width:4,background:'var(--blue)',borderRadius:2,alignSelf:'stretch'}} />
              <div style={{flex:1}}>
                <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:4}}>
                  <span style={{fontWeight:600,fontSize:'.88rem'}}>{l.unit_number}</span>
                  <span style={{fontSize:'.72rem',color:'var(--text-3)'}}>{l.property_name}</span>
                  <span className="badge badge-blue" style={{fontSize:'.65rem'}}>lease</span>
                </div>
                <div style={{fontSize:'.82rem',color:'var(--text-2)'}}>
                  {l.first_name} {l.last_name} · {new Date(l.start_date+'T12:00:00').toLocaleDateString()} — {new Date(l.end_date+'T12:00:00').toLocaleDateString()}
                </div>
              </div>
              <div style={{textAlign:'right'}}>
                <div style={{fontWeight:700,color:'var(--gold)'}}>{fmt(l.rent_amount)}/mo</div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── UNITS VIEW ── */}
      {!isLoading && view==='units' && (
        <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(280px,1fr))',gap:12}}>
          {filteredUnits.map(unit => (
            <div key={unit.id} className="card">
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:10}}>
                <div>
                  <div style={{fontWeight:700,fontSize:'.95rem'}}>{unit.unit_number}</div>
                  <div style={{fontSize:'.72rem',color:TYPE_COLORS[unit.unit_type]||'var(--text-3)',marginTop:2}}>{UNIT_TYPE_LABELS[unit.unit_type]||unit.unit_type}</div>
                  <div style={{fontSize:'.7rem',color:'var(--text-3)'}}>{unit.property_name}</div>
                </div>
                <div style={{display:'flex',gap:4,flexDirection:'column',alignItems:'flex-end'}}>
                  <span className={`badge ${unit.status==='active'?'badge-green':unit.status==='vacant'?'badge-muted':'badge-amber'}`}>{unit.status}</span>
                  {unit.is_bookable && <span className="badge badge-green" style={{fontSize:'.6rem'}}>Bookable</span>}
                </div>
              </div>
              <div style={{fontSize:'.78rem',display:'grid',gap:3,marginBottom:10}}>
                {unit.nightly_rate && <div style={{display:'flex',justifyContent:'space-between'}}><span style={{color:'var(--text-3)'}}>Nightly</span><span style={{color:'var(--gold)',fontWeight:600}}>{fmt(unit.nightly_rate)}</span></div>}
                {unit.weekly_rate && <div style={{display:'flex',justifyContent:'space-between'}}><span style={{color:'var(--text-3)'}}>Weekly</span><span style={{color:'var(--gold)',fontWeight:600}}>{fmt(unit.weekly_rate)}</span></div>}
                {unit.rent_amount && <div style={{display:'flex',justifyContent:'space-between'}}><span style={{color:'var(--text-3)'}}>Monthly</span><span style={{fontWeight:600}}>{fmt(unit.rent_amount)}</span></div>}
                {unit.tenant_first && <div style={{display:'flex',justifyContent:'space-between'}}><span style={{color:'var(--text-3)'}}>Tenant</span><span>{unit.tenant_first} {unit.tenant_last}</span></div>}
              </div>
              {unit.lease_types_allowed?.length > 0 && (
                <div style={{display:'flex',gap:4,flexWrap:'wrap',marginBottom:10}}>
                  {unit.lease_types_allowed.map((lt:string) => (
                    <span key={lt} style={{fontSize:'.62rem',background:'var(--bg-3)',border:'1px solid var(--border-1)',borderRadius:3,padding:'1px 5px',color:'var(--text-3)'}}>{LEASE_TYPE_LABELS[lt]||lt}</span>
                  ))}
                </div>
              )}
              {unit.unit_description && <div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:10,lineHeight:1.5}}>{unit.unit_description}</div>}
              <div style={{display:'flex',gap:6}}>
                <button className="btn btn-ghost btn-sm" style={{flex:1}} onClick={()=>openTypeModal(unit)}>⚙ Configure</button>
                {unit.is_bookable && <button className="btn btn-primary btn-sm" style={{flex:1}} onClick={()=>{setBookingModal({show:true,unit});setNewBooking(b=>({...b,leaseType:unit.lease_types_allowed?.[0]||'nightly'}))}}>+ Book</button>}
              </div>
            </div>
          ))}
          {filteredUnits.length===0 && <div style={{gridColumn:'1/-1',textAlign:'center',padding:48,color:'var(--text-3)'}}>No units found.</div>}
        </div>
      )}

      {/* ── CONFIGURE UNIT TYPE MODAL ── */}
      {typeModal.show && (
        <div className="modal-overlay" onClick={()=>setTypeModal({show:false,unit:null})}>
          <div className="modal" style={{maxWidth:540}} onClick={e=>e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">Configure Unit — {typeModal.unit?.unit_number}</span>
              <button className="btn btn-ghost btn-sm" onClick={()=>setTypeModal({show:false,unit:null})}>✕</button>
            </div>
            <div style={{padding:'0 24px 24px',display:'grid',gap:12}}>
              <div>
                <div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Unit Type</div>
                <select className="form-select" style={{width:'100%'}} value={typeForm.unitType} onChange={e=>setTypeForm((s:any)=>({...s,unitType:e.target.value}))}>
                  {UNIT_TYPES.map(t=><option key={t} value={t}>{UNIT_TYPE_LABELS[t]}</option>)}
                </select>
              </div>
              <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:10}}>
                <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Nightly Rate</div><input className="form-input" type="number" style={{width:'100%'}} placeholder="0.00" value={typeForm.nightlyRate} onChange={e=>setTypeForm((s:any)=>({...s,nightlyRate:e.target.value}))} /></div>
                <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Weekly Rate</div><input className="form-input" type="number" style={{width:'100%'}} placeholder="0.00" value={typeForm.weeklyRate} onChange={e=>setTypeForm((s:any)=>({...s,weeklyRate:e.target.value}))} /></div>
                <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Monthly Rate</div><input className="form-input" type="number" style={{width:'100%'}} placeholder="0.00" value={typeForm.monthlyRate} onChange={e=>setTypeForm((s:any)=>({...s,monthlyRate:e.target.value}))} /></div>
              </div>
              <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:10}}>
                <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Min Stay (nights)</div><input className="form-input" type="number" style={{width:'100%'}} value={typeForm.minStayNights} onChange={e=>setTypeForm((s:any)=>({...s,minStayNights:Number(e.target.value)}))} /></div>
                <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Check-in Time</div><input className="form-input" type="time" style={{width:'100%'}} value={typeForm.checkInTime} onChange={e=>setTypeForm((s:any)=>({...s,checkInTime:e.target.value}))} /></div>
                <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Check-out Time</div><input className="form-input" type="time" style={{width:'100%'}} value={typeForm.checkOutTime} onChange={e=>setTypeForm((s:any)=>({...s,checkOutTime:e.target.value}))} /></div>
              </div>
              <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Amenities (comma separated)</div><input className="form-input" style={{width:'100%'}} placeholder="Water hookup, Electric 30amp, WiFi" value={typeForm.amenities} onChange={e=>setTypeForm((s:any)=>({...s,amenities:e.target.value}))} /></div>
              <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Description</div><textarea className="form-input" style={{width:'100%',minHeight:70,resize:'vertical'}} placeholder="Pull-through site, full hookups..." value={typeForm.unitDescription} onChange={e=>setTypeForm((s:any)=>({...s,unitDescription:e.target.value}))} /></div>
              <div style={{display:'flex',alignItems:'center',gap:8}}>
                <input type="checkbox" id="ib" checked={typeForm.isBookable} onChange={e=>setTypeForm((s:any)=>({...s,isBookable:e.target.checked}))} />
                <label htmlFor="ib" style={{fontSize:'.82rem'}}>Allow short-term bookings on this unit</label>
              </div>
              <button className="btn btn-primary" onClick={()=>updateTypeMut.mutate()} disabled={updateTypeMut.isLoading}>
                {updateTypeMut.isLoading?'Saving...':'Save Configuration'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── NEW BOOKING MODAL ── */}
      {bookingModal.show && (
        <div className="modal-overlay" onClick={()=>setBookingModal({show:false,unit:null})}>
          <div className="modal" style={{maxWidth:480}} onClick={e=>e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">New Booking — {bookingModal.unit?.unit_number}</span>
              <button className="btn btn-ghost btn-sm" onClick={()=>setBookingModal({show:false,unit:null})}>✕</button>
            </div>
            <div style={{padding:'0 24px 24px',display:'grid',gap:12}}>
              <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}}>
                <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Guest Name</div><input className="form-input" style={{width:'100%'}} value={newBooking.guestName} onChange={e=>setNewBooking(s=>({...s,guestName:e.target.value}))} /></div>
                <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Guest Email</div><input className="form-input" type="email" style={{width:'100%'}} value={newBooking.guestEmail} onChange={e=>setNewBooking(s=>({...s,guestEmail:e.target.value}))} /></div>
                <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Phone</div><input className="form-input" style={{width:'100%'}} value={newBooking.guestPhone} onChange={e=>setNewBooking(s=>({...s,guestPhone:e.target.value}))} /></div>
                <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Lease Type</div>
                  <select className="form-select" style={{width:'100%'}} value={newBooking.leaseType} onChange={e=>setNewBooking(s=>({...s,leaseType:e.target.value}))}>
                    {(bookingModal.unit?.lease_types_allowed||LEASE_TYPES).map((lt:string)=><option key={lt} value={lt}>{LEASE_TYPE_LABELS[lt]||lt}</option>)}
                  </select>
                </div>
                <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Check-in</div><input className="form-input" type="date" style={{width:'100%'}} value={newBooking.checkIn} onChange={e=>setNewBooking(s=>({...s,checkIn:e.target.value}))} /></div>
                <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Check-out</div><input className="form-input" type="date" style={{width:'100%'}} value={newBooking.checkOut} onChange={e=>setNewBooking(s=>({...s,checkOut:e.target.value}))} /></div>
                <div style={{gridColumn:'1/-1'}}><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Total Amount</div><input className="form-input" type="number" style={{width:'100%'}} placeholder="0.00" value={newBooking.totalAmount} onChange={e=>setNewBooking(s=>({...s,totalAmount:e.target.value}))} /></div>
                <div style={{gridColumn:'1/-1'}}><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Notes</div><input className="form-input" style={{width:'100%'}} value={newBooking.notes} onChange={e=>setNewBooking(s=>({...s,notes:e.target.value}))} /></div>
              </div>
              <div style={{fontSize:'.75rem',color:'var(--text-3)',background:'var(--bg-3)',borderRadius:6,padding:'8px 10px'}}>
                Platform fee: 5% of total · Net to you: {fmt(Number(newBooking.totalAmount||0)*0.95)}
              </div>
              <button className="btn btn-primary" onClick={()=>createBookingMut.mutate()} disabled={!newBooking.checkIn||!newBooking.checkOut||createBookingMut.isLoading}>
                {createBookingMut.isLoading?'Creating...':'Create Booking'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
