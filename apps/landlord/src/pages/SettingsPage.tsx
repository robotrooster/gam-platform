import { useState } from 'react'
import { useQuery } from 'react-query'
import { apiGet } from '../lib/api'
const fmt = (n: any) => n != null ? `$${Number(n).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2})}` : '—'

export function SettingsPage() {
  const { data: settings, isLoading } = useQuery<any>('landlord-settings', () => apiGet('/landlord/settings'))

  return (
    <div>
      <div className="page-header">
        <div><h1 className="page-title">Settings</h1><p className="page-subtitle">Account and property configuration</p></div>
      </div>
      {isLoading ? <div style={{padding:32,color:'var(--text-3)',textAlign:'center'}}>Loading…</div> : (
        <div style={{display:'grid',gap:16}}>
          <div className="card">
            <div className="card-header"><span className="card-title">Property Info</span></div>
            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:16,marginTop:12}}>
              <div><div style={{fontSize:'.78rem',color:'var(--text-3)',marginBottom:4}}>Property Name</div><div style={{fontWeight:500}}>{settings?.property_name || '—'}</div></div>
              <div><div style={{fontSize:'.78rem',color:'var(--text-3)',marginBottom:4}}>Address</div><div>{settings?.address || '—'}</div></div>
              <div><div style={{fontSize:'.78rem',color:'var(--text-3)',marginBottom:4}}>City / State</div><div>{settings?.city || '—'}, {settings?.state || '—'}</div></div>
              <div><div style={{fontSize:'.78rem',color:'var(--text-3)',marginBottom:4}}>Total Units</div><div>{settings?.total_units || '—'}</div></div>
            </div>
          </div>
          <div className="card">
            <div className="card-header"><span className="card-title">Billing</span></div>
            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:16,marginTop:12}}>
              <div><div style={{fontSize:'.78rem',color:'var(--text-3)',marginBottom:4}}>Plan</div><div><span className="badge badge-green">{settings?.plan || 'standard'}</span></div></div>
              <div><div style={{fontSize:'.78rem',color:'var(--text-3)',marginBottom:4}}>Monthly Fee</div><div className="mono">{fmt(settings?.monthly_fee)}</div></div>
              <div><div style={{fontSize:'.78rem',color:'var(--text-3)',marginBottom:4}}>Next Billing Date</div><div className="mono">{settings?.next_billing ? new Date(settings.next_billing).toLocaleDateString() : '—'}</div></div>
              <div><div style={{fontSize:'.78rem',color:'var(--text-3)',marginBottom:4}}>ACH Tier</div><div>{settings?.ach_tier || '—'}</div></div>
            </div>
          </div>
          <div className="card">
            <div className="card-header"><span className="card-title">Notifications</span></div>
            <div style={{color:'var(--text-3)',fontSize:'.88rem',marginTop:12}}>Notification preferences coming soon.</div>
          </div>
        </div>
      )}
    </div>
  )
}
