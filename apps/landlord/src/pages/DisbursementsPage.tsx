import { useState } from 'react'
import { useQuery } from 'react-query'
import { Link } from 'react-router-dom'
import { humanize } from '@gam/shared'
import { apiGet } from '../lib/api'
import { usePerms } from '../lib/permissions'
import { X, Landmark } from 'lucide-react'
const fmt = (n: any) => n != null ? `$${Number(n).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2})}` : '—'

export function DisbursementsPage() {
  const { data: disbs = [], isLoading } = useQuery<any[]>('disbursements', () => apiGet('/disbursements'))
  const [selected, setSelected] = useState<any | null>(null)
  const { can } = usePerms()

  const totalSettled = (disbs as any[]).filter((d: any) => d.status === 'settled').reduce((sum: number, d: any) => sum + Number(d.amount), 0)
  const totalPending = (disbs as any[]).filter((d: any) => d.status === 'pending').reduce((sum: number, d: any) => sum + Number(d.amount), 0)

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">Disbursements</h1>
          <p className="page-subtitle">Your collected balance pays out automatically to your linked bank account</p>
        </div>
      </div>

      <BalanceWithdrawSection />

      {can('disbursements.pm_impact_view') && <PmImpactSection />}

      <div className="kpi-grid" style={{ marginBottom: 24 }}>
        <div className="kpi-card">
          <div className="kpi-label">Total Disbursed</div>
          <div className="kpi-value green">{fmt(totalSettled)}</div>
          <div className="kpi-sub">{(disbs as any[]).filter((d: any) => d.status === 'settled').length} settled payouts</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">Pending</div>
          <div className="kpi-value amber">{fmt(totalPending)}</div>
          <div className="kpi-sub">{(disbs as any[]).filter((d: any) => d.status === 'pending').length} queued</div>
        </div>
      </div>

      <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
        {isLoading ? (
          <div style={{ padding: 32, color: 'var(--text-3)', textAlign: 'center' }}>Loading...</div>
        ) : (
          <>
            <table className="data-table" style={{ minWidth: 820 }}>
              <thead><tr>
                <th>Date</th><th>Type</th><th>Amount</th><th>Fee</th><th>Bank</th><th>Status</th><th>Settled</th>
              </tr></thead>
              <tbody>
                {(disbs as any[]).length ? (disbs as any[]).map((d: any) => (
                  <tr key={d.id} onClick={() => setSelected(d)} style={{ cursor: 'pointer' }}>
                    <td className="mono">{new Date(d.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</td>
                    <td style={{ fontSize: '.78rem' }}>
                      {d.triggerType === 'auto_friday' ? 'Auto-Friday' : d.triggerType === 'manual_on_demand' ? 'Manual' : (d.triggerType || '—')}
                    </td>
                    <td className="mono" style={{ color: 'var(--green)', fontWeight: 700 }}>{fmt(d.amount)}</td>
                    <td className="mono" style={{ fontSize: '.78rem', color: parseFloat(d.feeCharged ?? '0') > 0 ? 'var(--red)' : 'var(--text-3)' }}>
                      {parseFloat(d.feeCharged ?? '0') > 0 ? `−${fmt(d.feeCharged)}` : '—'}
                    </td>
                    <td style={{ fontSize: '.78rem' }}>
                      {d.bankNickname ? <>{d.bankNickname} <span style={{ color: 'var(--text-3)' }}>•••• {d.bankLast4}</span></> : <span style={{ color: 'var(--text-3)' }}>—</span>}
                    </td>
                    <td>
                      <span className={'badge ' + (d.status === 'settled' ? 'badge-green' : d.status === 'pending' ? 'badge-amber' : 'badge-red')}>
                        {d.status === 'settled' ? 'Settled' : d.status === 'pending' ? 'Pending' : d.status}
                      </span>
                    </td>
                    <td className="mono" style={{ fontSize: '.75rem', color: 'var(--text-3)' }}>
                      {d.settledAt ? new Date(d.settledAt).toLocaleDateString() : '—'}
                    </td>
                  </tr>
                )) : (
                  <tr><td colSpan={7} style={{ textAlign: 'center', color: 'var(--text-3)', padding: 40 }}>
                    No disbursements yet. Auto-Friday payouts begin once a property is routed to a bank account and rent has been collected.
                  </td></tr>
                )}
              </tbody>
            </table>
            <div style={{ padding: '10px 16px', borderTop: '1px solid var(--border-0)', fontSize: '.75rem', color: 'var(--text-3)' }}>
              Click any row for full disbursement detail
            </div>
          </>
        )}
      </div>

      {selected && (
        <div className="modal-overlay" onClick={() => setSelected(null)}>
          <div className="modal" style={{ maxWidth: 480 }} onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
              <div className="modal-title" style={{ marginBottom: 0 }}>Disbursement Detail</div>
              <button className="btn btn-ghost btn-sm" onClick={() => setSelected(null)} style={{ padding: 6 }}><X size={15} /></button>
            </div>
            <div style={{ background: 'var(--bg-3)', borderRadius: 10, padding: 16, marginBottom: 16, textAlign: 'center' }}>
              <div style={{ fontSize: '.75rem', color: 'var(--text-3)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '.06em' }}>Amount Disbursed</div>
              <div style={{ fontFamily: 'var(--font-display)', fontSize: '2rem', fontWeight: 800, color: 'var(--green)' }}>{fmt(selected.amount)}</div>
              <div style={{ fontSize: '.8rem', color: 'var(--text-3)', marginTop: 4 }}>
                {new Date(selected.createdAt).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}
              </div>
            </div>
            <div className="data-row"><span className="data-key">Status</span>
              <span className={'badge ' + (selected.status === 'settled' ? 'badge-green' : 'badge-amber')}>{humanize(selected.status)}</span>
            </div>
            <div className="data-row"><span className="data-key">Trigger</span>
              <span className="data-val">{selected.triggerType === 'auto_friday' ? 'Auto-Friday payout' : selected.triggerType === 'manual_on_demand' ? 'Manual on-demand' : (selected.triggerType || '—')}</span>
            </div>
            {selected.bankNickname && (
              <div className="data-row"><span className="data-key">Destination bank</span>
                <span className="data-val">{selected.bankNickname} •••• {selected.bankLast4}</span>
              </div>
            )}
            {parseFloat(selected.feeCharged ?? '0') > 0 && (
              <div className="data-row"><span className="data-key">Fee</span><span className="data-val mono" style={{ color: 'var(--red)' }}>−{fmt(selected.feeCharged)}</span></div>
            )}
            <div className="data-row"><span className="data-key">Initiated</span><span className="data-val mono" style={{ fontSize: '.8rem' }}>{selected.initiatedAt ? new Date(selected.initiatedAt).toLocaleString() : '—'}</span></div>
            <div className="data-row"><span className="data-key">Settled</span><span className="data-val mono" style={{ fontSize: '.8rem' }}>{selected.settledAt ? new Date(selected.settledAt).toLocaleString() : 'Pending'}</span></div>
          </div>
        </div>
      )}
    </div>
  )
}

// S574 (Nic): on-demand withdrawal retired — the platform holds the balance and
// pays it out on the automatic Friday batch, so this is a read-only balance
// summary now (no "Withdraw Now" flow, no payout banner).
function BalanceWithdrawSection() {
  const { data, isLoading } = useQuery<any>('me-finances-summary', () => apiGet('/users/me/finances?limit=1'))
  if (isLoading || !data) return null

  const balance = Number(data.currentBalance ?? 0)
  const pending = Number(data.pendingBalance ?? 0)
  const connectReady = data.connectReady === true

  return (
    <div style={{ marginBottom: 24 }}>
      <div className="kpi-grid">
        <div className="kpi-card">
          <div className="kpi-label">Available Now</div>
          <div className="kpi-value gold">{fmt(balance)}</div>
          <div className="kpi-sub">{connectReady ? 'Paid out automatically each week — in your bank by Friday' : 'Link your bank to get paid'}</div>
        </div>
        {pending > 0 && (
          <div className="kpi-card">
            <div className="kpi-label">Pending Settlement</div>
            <div className="kpi-value amber">{fmt(pending)}</div>
            <div className="kpi-sub">In flight — clears in 1–3 days</div>
          </div>
        )}
      </div>

      {!connectReady && (
        <div className="card" style={{ padding: 14, marginTop: 12, fontSize: '.82rem' }}>
          <Landmark size={14} color="var(--gold)" style={{ verticalAlign: 'middle', marginRight: 8 }} />
          Link your bank account at{' '}
          <Link to="/banking" style={{ color: 'var(--gold)' }}>Banking →</Link>
          {' '}to receive your automatic payouts.
        </div>
      )}
    </div>
  )
}

// S159: per-property PM impact for the current month. Renders only when
// at least one property has a non-zero PM cut. Mirrors the dashboard
// tile but with per-property breakdown — gross / pm_fee / your net.
function PmImpactSection() {
  const monthStart = (() => { const d = new Date(); d.setDate(1); return d.toISOString().slice(0,10) })()
  const today = new Date().toISOString().slice(0,10)

  const { data } = useQuery<{ rows: Array<{
    propertyId: string; propertyName: string;
    pmCompanyId: string | null; pmCompanyName: string | null;
    pmFeePlanName: string | null;
    pmCompanyCut: string; ownerNet: string; inHouseManagerFee: string;
    totalSplit: string;
  }> }>(
    ['pm-impact-mtd-table', monthStart, today],
    () => apiGet(`/landlords/me/pm-impact?from=${monthStart}&to=${today}`),
    { staleTime: 5 * 60 * 1000 },
  )

  const rows = (data?.rows ?? []).filter(r => r.pmCompanyId)
  if (rows.length === 0) return null

  const totalGross = rows.reduce((s, r) => s + Number(r.totalSplit), 0)
  const totalPmFee = rows.reduce((s, r) => s + Number(r.pmCompanyCut), 0)
  const totalNet   = rows.reduce((s, r) => s + Number(r.ownerNet), 0)

  return (
    <div className="card" style={{ marginBottom: 24, padding: 0, overflow: 'hidden' }}>
      <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border-0)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ fontWeight: 600, color: 'var(--text-0)' }}>PM Impact — month-to-date</div>
        <div style={{ fontSize: '.78rem', color: 'var(--text-3)' }}>
          Gross {fmt(totalGross)} · PM Fee {fmt(totalPmFee)} · Net {fmt(totalNet)}
        </div>
      </div>
      <table className="data-table" style={{ width: '100%' }}>
        <thead>
          <tr>
            <th>Property</th><th>PM Company</th><th>Fee Plan</th>
            <th style={{ textAlign: 'right' }}>Gross</th>
            <th style={{ textAlign: 'right' }}>PM Fee</th>
            <th style={{ textAlign: 'right' }}>Your Net</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.propertyId}>
              <td><strong>{r.propertyName}</strong></td>
              <td>{r.pmCompanyName ?? '—'}</td>
              <td style={{ color: 'var(--text-3)', fontSize: '.78rem' }}>{r.pmFeePlanName ?? '—'}</td>
              <td style={{ textAlign: 'right' }}>{fmt(r.totalSplit)}</td>
              <td style={{ textAlign: 'right', color: 'var(--gold)' }}>{fmt(r.pmCompanyCut)}</td>
              <td style={{ textAlign: 'right', color: 'var(--green, #2ea35a)' }}>{fmt(r.ownerNet)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
