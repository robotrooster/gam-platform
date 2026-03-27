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
  const tenants = units.filter(u => u.tenant_first)

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
                <tr key={u.id} onClick={() => u.tenant_id && navigate(`/tenants/${u.tenant_id}`)} style={{ cursor: u.tenant_id ? 'pointer' : 'default' }}>
                  <td><div style={{fontWeight:600,color:'var(--text-0)'}}>{u.tenant_first} {u.tenant_last}</div><div style={{fontSize:'.72rem',color:'var(--text-3)'}}>{u.tenant_email}</div></td>
                  <td className="mono">{u.unit_number}</td>
                  <td style={{fontSize:'.82rem'}}>{u.property_name}</td>
                  <td className="mono">{u.rent_amount ? `$${Number(u.rent_amount).toLocaleString()}` : '—'}</td>
                  <td><span className={`badge ${u.ach_verified?'badge-green':'badge-amber'}`}>{u.ach_verified?'Verified':'Pending'}</span></td>
                  <td><span className={`badge ${u.on_time_pay_enrolled?'badge-green':'badge-muted'}`}>{u.on_time_pay_enrolled?'Active':'—'}</span></td>
                  <td>{u.ssi_ssdi ? <span className="badge badge-gold">SSI/SSDI</span> : <span style={{color:'var(--text-3)'}}>—</span>}</td>
                </tr>
              )) : (
                <tr><td colSpan={7} style={{textAlign:'center',color:'var(--text-3)',padding:32}}>No tenants yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )

  {showInvite && <InviteTenantModal onClose={() => setShowInvite(false)} />}
}