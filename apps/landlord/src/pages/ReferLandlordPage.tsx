import { useState } from 'react'
import { useQuery } from 'react-query'
import { apiGet } from '../lib/api'

// S567: landlord-to-landlord referral. A landlord who refers another landlord
// becomes the CLOSER on that account and earns 25¢/occupied unit/month for as
// long as the referred landlord stays on the platform.
export function ReferLandlordPage() {
  const { data: ref } = useQuery('my-referral', () => apiGet<any>('/landlords/my-referral'))
  const { data: earn } = useQuery('referral-earnings', () => apiGet<any>('/landlords/referral-earnings'))
  const [copied, setCopied] = useState(false)
  const copy = () => {
    if (ref?.referralLink) { navigator.clipboard?.writeText(ref.referralLink); setCopied(true); setTimeout(() => setCopied(false), 2000) }
  }
  const fmt = (n: number) => `$${(Number(n) || 0).toFixed(2)}`
  const rows: any[] = earn?.byLandlord || []

  return (
    <div>
      <div className="page-header"><h1>Refer &amp; Earn</h1><p>Refer another landlord and earn a residual for as long as they stay.</p></div>

      <div className="card">
        <div className="card-title">Your referral link</div>
        <p style={{ color: 'var(--text-3)', fontSize: '.85rem', marginBottom: 12 }}>
          Share this link with another landlord. When they sign up through it, you earn
          <strong style={{ color: 'var(--gold)' }}> 25¢ per occupied unit, every month</strong>, for as long as
          they're on the platform. No cap on how many you refer.
        </p>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <code className="mono" style={{ flex: 1, minWidth: 240, background: 'var(--bg-3)', padding: '10px 12px', borderRadius: 8, color: 'var(--text-0)', overflowX: 'auto' }}>
            {ref?.referralLink || '—'}
          </code>
          <span className="mono" style={{ color: 'var(--text-3)' }}>Code {ref?.referralCode || '—'}</span>
          <button className="btn btn-primary" onClick={copy} disabled={!ref?.referralLink}>{copied ? 'Copied ✓' : 'Copy link'}</button>
        </div>
      </div>

      <div className="kpi-grid" style={{ marginTop: 16 }}>
        <div className="kpi-card">
          <div className="kpi-label">This month</div>
          <div className="kpi-value gold">{fmt(earn?.thisMonth)}</div>
          <div className="kpi-sub">referral commission</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">All time</div>
          <div className="kpi-value">{fmt(earn?.allTime)}</div>
          <div className="kpi-sub">earned to date</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">Landlords referred</div>
          <div className="kpi-value">{earn?.referredCount || 0}</div>
          <div className="kpi-sub">signed up with your link</div>
        </div>
      </div>

      <div className="card mt-16">
        <div className="card-title">Your referred landlords</div>
        <table className="data-table">
          <thead><tr><th>Landlord</th><th>Occupied units</th><th>This month</th><th>All time</th></tr></thead>
          <tbody>
            {rows.length ? rows.map((r) => (
              <tr key={r.landlordId}>
                <td>{r.businessName || `${r.firstName || ''} ${r.lastName || ''}`.trim()}</td>
                <td className="mono">{r.occupiedUnits || 0}</td>
                <td className="mono">{fmt(r.thisMonth)}</td>
                <td className="mono">{fmt(r.allTime)}</td>
              </tr>
            )) : (
              <tr><td colSpan={4} style={{ textAlign: 'center', color: 'var(--text-3)', padding: 24 }}>
                No referrals yet — share your link to start earning.
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
