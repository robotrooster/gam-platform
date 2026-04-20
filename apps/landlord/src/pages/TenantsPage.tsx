import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from 'react-query'
import { apiGet } from '../lib/api'
import { Users, Plus } from 'lucide-react'
import { InviteTenantModal } from './InviteTenantModal'

export function TenantsPage() {
  const [showInvite, setShowInvite] = useState(false)
  const navigate = useNavigate()
  const { data: units = [], isLoading } = useQuery<any[]>('units', () => apiGet('/units'))
  const tenants = units.filter(u => u.tenantFirst)

  return (
    <div>
      <div className="page-header">
        <div><h1 className="page-title">Tenants</h1><p className="page-subtitle">{tenants.length} active tenants</p></div>
        <button className="btn btn-primary" onClick={() => setShowInvite(true)}><Plus size={15} /> Invite Tenant</button>
      </div>
      {isLoading ? <div style={{color:'var(--text-3)',padding:32}}>Loading…</div> : (
        <div className="card" style={{padding:0}}>
          <table className="data-table">
            <thead><tr><th>Tenant</th><th>Unit</th><th>Property</th><th>Rent</th><th>ACH</th><th>On-Time Pay</th><th>SSI/SSDI</th></tr></thead>
            <tbody>
              {tenants.length ? tenants.map((u: any) => (
                <tr key={u.id} onClick={() => u.tenantId && navigate(`/tenants/${u.tenantId}`)} style={{ cursor: u.tenantId ? 'pointer' : 'default' }}>
                  <td><div style={{fontWeight:600,color:'var(--text-0)'}}>{u.tenantFirst} {u.tenantLast}</div><div style={{fontSize:'.72rem',color:'var(--text-3)'}}>{u.tenantEmail}</div></td>
                  <td className="mono">{u.unitNumber}</td>
                  <td style={{fontSize:'.82rem'}}>{u.propertyName}</td>
                  <td className="mono">{u.rentAmount ? `$${Number(u.rentAmount).toLocaleString()}` : '—'}</td>
                  <td><span className={`badge ${u.achVerified?'badge-green':'badge-amber'}`}>{u.achVerified?'Verified':'Pending'}</span></td>
                  <td><span className={`badge ${u.onTimePayEnrolled?'badge-green':'badge-muted'}`}>{u.onTimePayEnrolled?'Active':'—'}</span></td>
                  <td>{u.ssiSsdi ? <span className="badge badge-gold">SSI/SSDI</span> : <span style={{color:'var(--text-3)'}}>—</span>}</td>
                </tr>
              )) : (
                <tr><td colSpan={7} style={{textAlign:'center',color:'var(--text-3)',padding:32}}>No tenants yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      {showInvite && <InviteTenantModal onClose={() => setShowInvite(false)} />}
    </div>
  )
}
