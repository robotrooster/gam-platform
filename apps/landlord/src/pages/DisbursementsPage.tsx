import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { Link } from 'react-router-dom'
import { apiGet, apiPost } from '../lib/api'
import { ArrowDownToLine, X, Landmark, Check } from 'lucide-react'
const fmt = (n: any) => n != null ? `$${Number(n).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2})}` : '—'

export function DisbursementsPage() {
  const { data: disbs = [], isLoading } = useQuery<any[]>('disbursements', () => apiGet('/disbursements'))
  const [selected, setSelected] = useState<any | null>(null)
  const [withdrawBank, setWithdrawBank] = useState<any | null>(null)

  const totalSettled = (disbs as any[]).filter((d: any) => d.status === 'settled').reduce((sum: number, d: any) => sum + Number(d.amount), 0)
  const totalPending = (disbs as any[]).filter((d: any) => d.status === 'pending').reduce((sum: number, d: any) => sum + Number(d.amount), 0)

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">Disbursements</h1>
          <p className="page-subtitle">On-Time Pay - rent initiated on or before the 1st business day of each month</p>
        </div>
      </div>

      <div className="alert alert-gold" style={{ marginBottom: 24 }}>
        <ArrowDownToLine size={16} />
        <span><strong>Auto-Friday payouts:</strong> Available balance pays out automatically every Friday (Monday if Friday is a US federal holiday). Need it sooner? Withdraw on demand — standard ACH is free, instant payout carries a Stripe surcharge.</span>
      </div>

      <BalanceWithdrawSection onWithdraw={() => setWithdrawBank({ open: true })} />

      <PmImpactSection />

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

      {withdrawBank && (
        <WithdrawNowModal onClose={() => setWithdrawBank(null)} />
      )}


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
              <span className={'badge ' + (selected.status === 'settled' ? 'badge-green' : 'badge-amber')}>{selected.status}</span>
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

function BalanceWithdrawSection({ onWithdraw }: { onWithdraw: () => void }) {
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
          <div className="kpi-sub">{connectReady ? 'Eligible to withdraw' : 'Finish Stripe onboarding first'}</div>
        </div>
        {pending > 0 && (
          <div className="kpi-card">
            <div className="kpi-label">Pending Settlement</div>
            <div className="kpi-value amber">{fmt(pending)}</div>
            <div className="kpi-sub">In flight from Stripe — clears in 1–3 days</div>
          </div>
        )}
      </div>

      {!connectReady && (
        <div className="card" style={{ padding: 14, marginTop: 12, fontSize: '.82rem' }}>
          <Landmark size={14} color="var(--gold)" style={{ verticalAlign: 'middle', marginRight: 8 }} />
          Complete Stripe Connect onboarding at{' '}
          <Link to="/banking" style={{ color: 'var(--gold)' }}>Banking →</Link>
          {' '}before you can withdraw.
        </div>
      )}

      {connectReady && balance > 0 && (
        <div className="card" style={{ padding: '14px 16px', marginTop: 12, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '.82rem' }}>
            <Landmark size={14} color="var(--gold)" />
            <span style={{ fontWeight: 600 }}>Withdraw Now</span>
            <span style={{ color: 'var(--text-3)', fontSize: '.72rem' }}>
              · Skip the Friday batch and get the money sooner
            </span>
          </div>
          <button className="btn btn-primary btn-sm" onClick={onWithdraw}>
            Choose Method
          </button>
        </div>
      )}
    </div>
  )
}

function WithdrawNowModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient()
  const [error, setError] = useState<string | null>(null)
  const [method, setMethod] = useState<'standard' | 'instant'>('standard')

  const { data: preview, isLoading: previewLoading } = useQuery<any>(
    'withdraw-preview',
    () => apiGet('/users/me/withdrawals/preview'),
    { retry: false }
  )

  const mut = useMutation(
    () => apiPost('/users/me/withdrawals', { method }),
    {
      onSuccess: () => {
        qc.invalidateQueries('me-finances-summary')
        qc.invalidateQueries('disbursements')
        onClose()
      },
      onError: (e: any) => setError(e?.response?.data?.error || 'Withdrawal failed'),
    }
  )

  const standard = preview?.standard
  const instant  = preview?.instant
  const chosen   = method === 'standard' ? standard : instant
  const eligible = chosen?.eligible === true

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 480 }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <div className="modal-title" style={{ marginBottom: 0 }}>Withdraw Now</div>
          <button className="btn btn-ghost btn-sm" onClick={onClose} style={{ padding: 6 }}><X size={15} /></button>
        </div>

        {previewLoading && <div style={{ color: 'var(--text-3)' }}>Loading…</div>}

        {preview && (
          <>
            <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
              <button
                className={'btn btn-sm ' + (method === 'standard' ? 'btn-primary' : 'btn-ghost')}
                style={{ flex: 1 }}
                onClick={() => setMethod('standard')}
              >
                Standard ACH
              </button>
              <button
                className={'btn btn-sm ' + (method === 'instant' ? 'btn-primary' : 'btn-ghost')}
                style={{ flex: 1 }}
                onClick={() => setMethod('instant')}
                disabled={!instant?.eligible}
              >
                Instant
              </button>
            </div>

            <div style={{ background: 'var(--bg-3)', borderRadius: 10, padding: 14, marginBottom: 14 }}>
              <div className="data-row">
                <span className="data-key">Available</span>
                <span className="data-val mono">{fmt(chosen?.available ?? 0)}</span>
              </div>
              {method === 'instant' && (
                <div className="data-row">
                  <span className="data-key">Stripe instant fee</span>
                  <span className="data-val mono" style={{ color: 'var(--red)' }}>−{fmt(instant?.fee ?? 0)}</span>
                </div>
              )}
              <div className="data-row" style={{ borderTop: '1px solid var(--border-0)', paddingTop: 8, marginTop: 4 }}>
                <span className="data-key" style={{ fontWeight: 600 }}>You'll receive</span>
                <span className="data-val mono" style={{ color: 'var(--green)', fontWeight: 700 }}>
                  {fmt(method === 'instant' ? (instant?.net ?? 0) : (standard?.available ?? 0))}
                </span>
              </div>
            </div>

            <div style={{ fontSize: '.72rem', color: 'var(--text-3)', marginBottom: 14, lineHeight: 1.5 }}>
              {method === 'standard'
                ? 'Standard ACH typically settles in 1–2 business days. No fee.'
                : 'Instant payouts arrive in minutes. Stripe deducts a 1.5% fee (min $0.50) from the amount.'}
            </div>
          </>
        )}

        {error && (
          <div style={{ color: 'var(--red)', fontSize: '.78rem', background: 'rgba(255,71,87,.08)', border: '1px solid rgba(255,71,87,.2)', borderRadius: 8, padding: '8px 12px', marginBottom: 12 }}>
            {error}
          </div>
        )}

        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary"
            onClick={() => mut.mutate()}
            disabled={!eligible || mut.isLoading}>
            {mut.isLoading ? <span className="spinner" /> : <><Check size={14} /> Confirm Withdrawal</>}
          </button>
        </div>
      </div>
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
