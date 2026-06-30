// S233: real pool browse + reach-out flow. Replaces the placeholder
// page that queried a nonexistent /applicants endpoint.
//
// Backend surface:
//   GET  /api/background/pool/search          — redacted previews
//   GET  /api/background/pool/matches         — landlord's outgoing
//   POST /api/background/pool/:poolId/reach-out — initiate contact
//
// Tenant identity is redacted in the search results until the landlord
// completes the $1 report-purchase flow (separate session — defers to
// the existing background-check unlock surface). This page handles
// browse + free reach-out only.

import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { apiGet, apiPost } from '../lib/api'

interface PoolEntry {
  id:                 string
  employmentStatus:  string | null
  monthlyIncome:     string | null
  city:               string | null
  state:              string | null
  zip:                string | null
  riskLevel:         string | null
  riskScore:         number | null
  createdAt:         string
  proximityRank:     number | null
  alreadyContacted:  boolean
}

// S512 #30: how close the candidate is to one of the landlord's
// properties. Lower rank = closer. Rank 4 (elsewhere) gets no badge.
const PROXIMITY: Record<number, { label: string; cls: string }> = {
  0: { label: 'Same ZIP',    cls: 'badge-green' },
  1: { label: 'Your city',   cls: 'badge-green' },
  2: { label: 'Same region', cls: 'badge-blue' },
  3: { label: 'Same state',  cls: 'badge-amber' },
}

interface MatchRequest {
  id:                 string
  status:             'pending' | 'interested' | 'not_interested' | 'report_purchased' | 'expired'
  landlordMessage:   string | null
  tenantResponse:    string | null
  requestedAt:       string
  respondedAt:       string | null
  purchasedAt:       string | null
  reportFeePaid:    boolean
  poolEntryId:      string
  employmentStatus:  string | null
  monthlyIncome:     string | null
  city:               string | null
  state:              string | null
  zip:                string | null
  riskLevel:         string | null
  riskScore:         number | null
  unitId:            string | null
  unitNumber:        string | null
  propertyName:      string | null
  tenantFirst:       string | null
  tenantLast:        string | null
  tenantEmail:       string | null
  tenantPhone:       string | null
}

interface UnitOption {
  id:            string
  unitNumber:   string
  propertyName: string
  status:        string
}

const fmt = (n: any) =>
  n != null && n !== '' ? `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}` : '—'

const RISK_BADGE: Record<string, string> = {
  low:       'badge-green',
  moderate:  'badge-amber',
  high:      'badge-red',
  very_high: 'badge-red',
}

const STATUS_BADGE: Record<MatchRequest['status'], string> = {
  pending:           'badge-amber',
  interested:        'badge-green',
  not_interested:    'badge-muted',
  report_purchased:  'badge-blue',
  expired:           'badge-muted',
}

const STATUS_LABEL: Record<MatchRequest['status'], string> = {
  pending:           'Awaiting tenant',
  interested:        'Interested — unlock to view',
  not_interested:    'Not interested',
  report_purchased:  'Report unlocked',
  expired:           'Expired',
}

export function ApplicantPoolPage() {
  const [reachOutFor, setReachOutFor] = useState<PoolEntry | null>(null)

  const { data: pool = [], isLoading: poolLoading } = useQuery<PoolEntry[]>(
    'pool-search',
    () => apiGet<PoolEntry[]>('/background/pool/search'),
  )

  const { data: matches = [], isLoading: matchesLoading } = useQuery<MatchRequest[]>(
    'pool-matches',
    () => apiGet<MatchRequest[]>('/background/pool/matches'),
  )

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">Applicant Pool</h1>
          <p className="page-subtitle">
            Pre-screened tenants opted in to GAM's pool, closest to your
            properties first. Reach out is free — the tenant chooses whether
            to share their full info. Unlock the full report ($1) only after
            they confirm interest.
          </p>
        </div>
      </div>

      <div style={{ marginBottom: 8, fontSize: '.78rem', color: 'var(--text-3)' }}>
        {poolLoading ? 'Loading…' : `${pool.length} candidate${pool.length === 1 ? '' : 's'} in the pool · sorted by proximity to your properties`}
      </div>

      <div className="card" style={{ padding: 0, marginBottom: 28, overflowX: 'auto' }}>
        <table className="data-table" style={{ minWidth: 880 }}>
          <thead>
            <tr>
              <th>Location</th>
              <th>Employment</th>
              <th>Monthly Income</th>
              <th>Risk</th>
              <th>Joined</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {poolLoading ? (
              <tr><td colSpan={6} style={{ textAlign: 'center', color: 'var(--text-3)', padding: 32 }}>Loading…</td></tr>
            ) : pool.length === 0 ? (
              <tr><td colSpan={6} style={{ textAlign: 'center', color: 'var(--text-3)', padding: 32 }}>
                No candidates match these filters.
              </td></tr>
            ) : pool.map(c => (
              <tr key={c.id}>
                <td>
                  <div style={{ fontWeight: 500, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                    {c.city || '—'}{c.state ? `, ${c.state}` : ''}
                    {c.proximityRank != null && PROXIMITY[c.proximityRank] && (
                      <span className={`badge ${PROXIMITY[c.proximityRank].cls}`} style={{ fontSize: '.62rem' }}>
                        {PROXIMITY[c.proximityRank].label}
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: '.7rem', color: 'var(--text-3)' }}>{c.zip || ''}</div>
                </td>
                <td style={{ fontSize: '.82rem', textTransform: 'capitalize' }}>
                  {c.employmentStatus?.replace(/_/g, ' ') || '—'}
                </td>
                <td className="mono">{fmt(c.monthlyIncome)}</td>
                <td>
                  <span className={`badge ${c.riskLevel ? RISK_BADGE[c.riskLevel] || 'badge-muted' : 'badge-muted'}`}>
                    {c.riskLevel || '—'}
                  </span>
                  {c.riskScore != null && (
                    <span style={{ fontSize: '.7rem', color: 'var(--text-3)', marginLeft: 6 }}>
                      ({c.riskScore})
                    </span>
                  )}
                </td>
                <td style={{ fontSize: '.78rem', color: 'var(--text-3)' }}>
                  {new Date(c.createdAt).toLocaleDateString()}
                </td>
                <td style={{ textAlign: 'right' }}>
                  {c.alreadyContacted ? (
                    <span style={{ fontSize: '.74rem', color: 'var(--text-3)', fontStyle: 'italic' }}>
                      Already contacted
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      onClick={() => setReachOutFor(c)}
                    >
                      Reach out
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="page-header" style={{ marginBottom: 12 }}>
        <div>
          <h2 className="page-title" style={{ fontSize: '1.05rem' }}>Your reach-outs</h2>
          <p className="page-subtitle" style={{ fontSize: '.78rem' }}>
            Pending replies, interested confirmations, unlocked reports.
          </p>
        </div>
      </div>

      <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
        <table className="data-table" style={{ minWidth: 880 }}>
          <thead>
            <tr>
              <th>Sent</th>
              <th>Unit offered</th>
              <th>Candidate</th>
              <th>Status</th>
              <th>Tenant reply</th>
            </tr>
          </thead>
          <tbody>
            {matchesLoading ? (
              <tr><td colSpan={5} style={{ textAlign: 'center', color: 'var(--text-3)', padding: 32 }}>Loading…</td></tr>
            ) : matches.length === 0 ? (
              <tr><td colSpan={5} style={{ textAlign: 'center', color: 'var(--text-3)', padding: 32 }}>
                You haven't reached out to anyone yet.
              </td></tr>
            ) : matches.map(m => {
              const purchased = m.status === 'report_purchased'
              return (
                <tr key={m.id}>
                  <td style={{ fontSize: '.78rem', color: 'var(--text-3)' }}>
                    {new Date(m.requestedAt).toLocaleDateString()}
                  </td>
                  <td style={{ fontSize: '.82rem' }}>
                    {m.unitNumber
                      ? <>{m.propertyName} <span className="mono" style={{ color: 'var(--text-3)' }}>· {m.unitNumber}</span></>
                      : <span style={{ color: 'var(--text-3)' }}>any vacancy</span>}
                  </td>
                  <td>
                    {purchased ? (
                      <div>
                        <div style={{ fontWeight: 500 }}>{m.tenantFirst} {m.tenantLast}</div>
                        <div style={{ fontSize: '.7rem', color: 'var(--text-3)' }}>{m.tenantEmail}</div>
                      </div>
                    ) : (
                      <div style={{ fontSize: '.82rem' }}>
                        <div>{m.city}{m.state ? `, ${m.state}` : ''}</div>
                        <div style={{ fontSize: '.7rem', color: 'var(--text-3)' }}>
                          {fmt(m.monthlyIncome)}/mo · risk {m.riskLevel || '—'}
                        </div>
                      </div>
                    )}
                  </td>
                  <td>
                    <span className={`badge ${STATUS_BADGE[m.status]}`}>
                      {STATUS_LABEL[m.status]}
                    </span>
                  </td>
                  <td style={{ fontSize: '.78rem', color: 'var(--text-2)', maxWidth: 280 }}>
                    {m.tenantResponse || (m.status === 'pending'
                      ? <span style={{ color: 'var(--text-3)' }}>—</span>
                      : '')}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {reachOutFor && (
        <ReachOutModal
          entry={reachOutFor}
          onClose={() => setReachOutFor(null)}
        />
      )}
    </div>
  )
}

function ReachOutModal({ entry, onClose }: { entry: PoolEntry; onClose: () => void }) {
  const qc = useQueryClient()
  const [unitId,  setUnitId]  = useState<string>('')
  const [message, setMessage] = useState<string>('')
  const [error,   setError]   = useState<string | null>(null)

  // Only vacant units make sense to offer. The endpoint accepts any
  // unit owned by the landlord; we filter client-side to keep the
  // dropdown short and match the reach-out's intent.
  const { data: units = [], isLoading: unitsLoading } = useQuery<UnitOption[]>(
    'units-vacant',
    () => apiGet<UnitOption[]>('/units').then(rows => rows.filter(u => u.status === 'vacant')),
  )

  const mut = useMutation(
    () => apiPost(`/background/pool/${entry.id}/reach-out`, {
      unitId:  unitId || null,
      message: message.trim() || null,
    }),
    {
      onSuccess: () => {
        qc.invalidateQueries('pool-search')
        qc.invalidateQueries('pool-matches')
        onClose()
      },
      onError: (e: any) => {
        setError(e?.response?.data?.message || e?.response?.data?.error || e?.message || 'Could not send reach-out')
      },
    },
  )

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 520, width: '95vw' }} onClick={e => e.stopPropagation()}>
        <div className="modal-title" style={{ marginBottom: 6 }}>Reach out</div>
        <div style={{ fontSize: '.78rem', color: 'var(--text-3)', marginBottom: 14, lineHeight: 1.5 }}>
          The tenant gets a notification that you have a vacancy that matches
          their profile. Their identity stays redacted until they confirm
          interest and you unlock the report ($1).
        </div>

        <div style={{ display: 'flex', gap: 12, fontSize: '.78rem', color: 'var(--text-2)', padding: '10px 12px', background: 'var(--bg-2)', borderRadius: 8, marginBottom: 14 }}>
          <div>
            <strong>{entry.city || '—'}{entry.state ? `, ${entry.state}` : ''}</strong>
            {entry.zip && <span style={{ color: 'var(--text-3)' }}> {entry.zip}</span>}
          </div>
          <div style={{ marginLeft: 'auto' }}>
            {fmt(entry.monthlyIncome)}/mo · {entry.riskLevel || '—'}
          </div>
        </div>

        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 4 }}>
            Unit offered <span style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>(optional — leave blank to invite for any vacancy)</span>
          </div>
          <select
            value={unitId}
            onChange={e => setUnitId(e.target.value)}
            className="input"
            style={{ width: '100%' }}
            disabled={unitsLoading}
          >
            <option value="">Any vacant unit / not specified</option>
            {units.map(u => (
              <option key={u.id} value={u.id}>
                {u.propertyName} — Unit {u.unitNumber}
              </option>
            ))}
          </select>
          {!unitsLoading && units.length === 0 && (
            <div style={{ fontSize: '.7rem', color: 'var(--text-3)', marginTop: 4 }}>
              You have no vacant units right now — the reach-out will be sent without a specific unit attached.
            </div>
          )}
        </div>

        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 4 }}>
            Message <span style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>(optional — keep it brief)</span>
          </div>
          <textarea
            value={message}
            onChange={e => setMessage(e.target.value)}
            rows={3}
            maxLength={500}
            placeholder="What you'd want them to know about the unit or the property."
            style={{ width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid var(--border-0)', background: 'var(--bg-2)', color: 'var(--text-0)', fontSize: '.85rem', fontFamily: 'inherit', resize: 'vertical', boxSizing: 'border-box' }}
          />
        </div>

        {error && (
          <div style={{ padding: '8px 12px', borderRadius: 6, background: 'rgba(220,76,76,.08)', border: '1px solid rgba(220,76,76,.25)', color: 'var(--red, #dc4c4c)', fontSize: '.78rem', marginBottom: 12 }}>
            {error}
          </div>
        )}

        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button
            className="btn btn-primary"
            onClick={() => { setError(null); mut.mutate() }}
            disabled={mut.isLoading}
          >
            {mut.isLoading ? 'Sending…' : 'Send reach-out'}
          </button>
        </div>
      </div>
    </div>
  )
}
