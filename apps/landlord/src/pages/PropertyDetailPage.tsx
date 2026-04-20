import { useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { apiGet, apiPost, apiPatch } from '../lib/api'
import { ArrowLeft, Plus, DoorOpen, Users, DollarSign, Edit2, Building2, MapPin, AlertTriangle, Shield } from 'lucide-react'
import { AddUnitModal } from './AddUnitModal'
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
  const vacant    = (units as any[]).filter(u => !u.tenantId).length
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
