/**
 * S652 — ONE WORK-TRADE WINDOW, TWO PORTALS.
 *
 * Nic: "this is the same window that I want the tenants to see. Their
 * agreement, their jobs, all this stuff... The landlord and the tenant should
 * be seeing the same screens, but from their different portals."
 *
 * So there is exactly one component, imported by both apps. `side` only adds
 * the landlord's controls (approve / deny, trusted, skills, duties, end); the
 * tenant sees every figure the landlord sees except the dollar value of a
 * shortfall, which the server already withholds from the tenant (S643).
 *
 * Words (Nic): hours turned in and not yet reviewed are "Logged" — never
 * "pending", which read as already in trouble. Approved and Denied are the only
 * final states. Only approved hours reduce the bill; hours still logged when the
 * month closes count as not worked.
 */
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { X, Check, Clock, ShieldCheck, Eye } from 'lucide-react'
import {
  WORK_TRADE_SKILLS, WORK_TRADE_SKILL_LABEL, WORK_TRADE_LOG_STATUS_LABEL,
  WORK_TRADE_COVERABLE_LABEL,
} from '@gam/shared'

export type PanelApi = {
  get: (url: string) => Promise<any>
  post: (url: string, body?: any) => Promise<any>
  patch: (url: string, body?: any) => Promise<any>
}

const card: React.CSSProperties = { padding: 14, marginBottom: 12 }
const label: React.CSSProperties = { fontSize: '.64rem', fontWeight: 700, letterSpacing: '.07em', textTransform: 'uppercase', color: 'var(--text-3)', marginBottom: 6 }
const fmtH = (n: any) => `${Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })} hrs`
const fmtDate = (d: string | null | undefined) => d ? new Date(d.length === 10 ? d + 'T12:00:00' : d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '—'

function Figure({ name, value, accent }: { name: string; value: string; accent?: boolean }) {
  return (
    <div style={{ flex: '1 1 110px', minWidth: 0 }}>
      <div style={label}>{name}</div>
      <div style={{ fontFamily: 'monospace', fontWeight: 700, fontSize: '1rem', color: accent ? 'var(--gold)' : 'var(--text-0)' }}>{value}</div>
    </div>
  )
}

export function WorkTradePanel({ agreementId, side, api, onClose, notify }: {
  agreementId: string
  side: 'landlord' | 'tenant'
  api: PanelApi
  onClose?: () => void
  notify?: (msg: string, kind?: 'error') => void
}) {
  const qc = useQueryClient()
  const key = ['wt-panel', agreementId]
  const { data, isLoading } = useQuery<any>(key, () => api.get(`/work-trade/${agreementId}`))
  const { data: standing } = useQuery<any>(['wt-standing', agreementId],
    () => api.get(`/work-trade/${agreementId}/standing`).catch(() => null))
  const refresh = () => { qc.invalidateQueries(key); qc.invalidateQueries(['wt-standing', agreementId]); qc.invalidateQueries('work-trade') }
  const say = (m: string, kind?: 'error') => notify?.(m, kind)

  const isLandlord = side === 'landlord'
  const a = data?.agreement
  const logs: any[] = data?.logs ?? []
  const stats = data?.stats
  const record = data?.record

  const [duties, setDuties] = useState<string | null>(null)
  const [denying, setDenying] = useState<{ id: string; reason: string } | null>(null)
  const [logging, setLogging] = useState(false)
  const [form, setForm] = useState({ workDate: new Date().toISOString().slice(0, 10), hours: '', description: '' })
  const [ending, setEnding] = useState(false)

  const patch = useMutation((body: any) => api.patch(`/work-trade/${agreementId}`, body),
    { onSuccess: () => { refresh(); setDuties(null) }, onError: (e: any) => say(e?.message || 'Could not save that', 'error') })
  const review = useMutation(({ id, action, reason }: any) => api.patch(`/work-trade/logs/${id}`, { action, rejectionReason: reason }),
    { onSuccess: () => { refresh(); setDenying(null) }, onError: (e: any) => say(e?.message || 'Could not save that', 'error') })
  const logHours = useMutation(() => api.post(`/work-trade/${agreementId}/logs`, {
      workDate: form.workDate, hours: Number(form.hours), description: form.description.trim() }),
    { onSuccess: () => { refresh(); setLogging(false); setForm({ workDate: new Date().toISOString().slice(0, 10), hours: '', description: '' }); say('Hours logged') },
      onError: (e: any) => say(e?.message || 'Could not log those hours', 'error') })

  if (isLoading || !a) return <div className="card" style={{ ...card, color: 'var(--text-3)' }}>Loading…</div>

  const asleep = a.status === 'paused'
  const statusText = a.status === 'active' ? 'Active' : asleep ? 'Asleep for the season' : 'Ended'
  const tracks = a.tracksHours !== false
  const loggedHours = logs.filter(l => l.status === 'pending').reduce((s, l) => s + Number(l.hours), 0)
  const covers: string[] = a.coveredCharges?.length ? a.coveredCharges : Object.keys(WORK_TRADE_COVERABLE_LABEL)
  const skills: string[] = a.skills ?? []
  const canLog = a.status === 'active' && tracks

  return (
    <div>
      {/* ── who, where, and how it stands ── */}
      <div className="card" style={card}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: '1.02rem', color: 'var(--text-0)' }}>
              {[a.tenantFirst, a.tenantLast].filter(Boolean).join(' ') || 'Work trade agreement'}
            </div>
            <div style={{ fontSize: '.78rem', color: 'var(--text-3)' }}>Unit {a.unitNumber} · {a.propertyName}</div>
          </div>
          <span className="badge" style={{ fontSize: '.66rem' }}>{statusText}</span>
          <span className="badge" style={{ fontSize: '.66rem', color: a.trusted ? 'var(--gold)' : undefined }}>
            {a.trusted ? <><ShieldCheck size={11} style={{ verticalAlign: '-1px' }} /> Trusted</> : <><Eye size={11} style={{ verticalAlign: '-1px' }} /> Monitored</>}
          </span>
          {onClose && <button className="btn btn-ghost btn-sm" onClick={onClose} title="Close"><X size={14} /></button>}
        </div>
        {asleep && <div style={{ marginTop: 8, fontSize: '.78rem', color: 'var(--text-2)' }}>
          Their spot is hibernating, so nothing is owed and nothing is billed until they are back.</div>}
      </div>

      {/* ── this month ── */}
      {tracks ? (
        <div className="card" style={card}>
          <div style={label}>This month</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14 }}>
            <Figure name="Approved" value={`${fmtH(stats?.hoursApprovedThisMonth)} of ${fmtH(stats?.target)}`} accent />
            <Figure name="Logged, not yet reviewed" value={fmtH(loggedHours)} />
            {standing && <Figure name="Carried over" value={fmtH(standing.carriedHours)} />}
            {standing && <Figure name="To get straight" value={fmtH(standing.catchUpHours)} />}
            <Figure name="Bill covered" value={`${stats?.creditPct ?? 0}%`} />
          </div>
          <div style={{ fontSize: '.74rem', color: 'var(--text-3)', marginTop: 10, lineHeight: 1.5 }}>
            Hours are reviewed by <b style={{ color: 'var(--text-1)' }}>{fmtDate(stats?.reviewBy)}</b>, the last business day of the month.
            Only approved hours count toward the bill; hours still logged then count as not worked.
            {a.trusted ? ' Trusted: hours count as soon as they are logged.' : ''}
          </div>
          {isLandlord && standing?.carriedValue != null && Number(standing.carriedValue) > 0 && (
            <div style={{ fontSize: '.74rem', color: 'var(--text-2)', marginTop: 6 }}>
              Carried hours would bill ${Number(standing.carriedValue).toFixed(2)} if the agreement ended today.</div>
          )}
        </div>
      ) : (
        <div className="card" style={{ ...card, fontSize: '.82rem', color: 'var(--text-2)' }}>
          No hours are tracked on this agreement. The charges it covers are simply not billed.
        </div>
      )}

      {/* ── what they do ── */}
      <div className="card" style={card}>
        <div style={label}>Duties</div>
        {isLandlord && duties !== null ? (
          <>
            <textarea className="input" rows={4} style={{ width: '100%', resize: 'vertical' }} value={duties} onChange={e => setDuties(e.target.value)} />
            <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
              <button className="btn btn-primary btn-sm" disabled={patch.isLoading} onClick={() => patch.mutate({ duties: duties.trim() || null })}>Save</button>
              <button className="btn btn-ghost btn-sm" onClick={() => setDuties(null)}>Cancel</button>
            </div>
          </>
        ) : (
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
            <div style={{ flex: 1, fontSize: '.84rem', color: a.duties ? 'var(--text-1)' : 'var(--text-3)', whiteSpace: 'pre-wrap', lineHeight: 1.55 }}>
              {a.duties || 'No duties written down yet.'}</div>
            {isLandlord && <button className="btn btn-primary btn-sm" onClick={() => setDuties(a.duties ?? '')}>Edit</button>}
          </div>
        )}

        <div style={{ ...label, marginTop: 14 }}>Skilled work they take on</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {(isLandlord ? WORK_TRADE_SKILLS : skills).map((s: any) => {
            const on = skills.includes(s)
            return isLandlord ? (
              <button key={s} className={`btn btn-sm ${on ? 'btn-primary' : 'btn-ghost'}`} disabled={patch.isLoading}
                onClick={() => patch.mutate({ skills: on ? skills.filter(x => x !== s) : [...skills, s] })}>
                {on && <Check size={11} />} {(WORK_TRADE_SKILL_LABEL as any)[s]}
              </button>
            ) : <span key={s} className="badge">{(WORK_TRADE_SKILL_LABEL as any)[s]}</span>
          })}
          {!isLandlord && skills.length === 0 && <span style={{ fontSize: '.8rem', color: 'var(--text-3)' }}>General work: grounds, cleaning, and odd jobs.</span>}
        </div>

        <div style={{ ...label, marginTop: 14 }}>Covers</div>
        <div style={{ fontSize: '.82rem', color: 'var(--text-1)' }}>
          {covers.map(c => (WORK_TRADE_COVERABLE_LABEL as any)[c] ?? c).join(', ')}</div>

        {isLandlord && (
          <div style={{ marginTop: 14, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <div style={label}>Trust</div>
            <button className={`btn btn-sm ${a.trusted ? 'btn-primary' : 'btn-ghost'}`} disabled={patch.isLoading} onClick={() => !a.trusted && patch.mutate({ trusted: true })}>Trusted</button>
            <button className={`btn btn-sm ${!a.trusted ? 'btn-primary' : 'btn-ghost'}`} disabled={patch.isLoading} onClick={() => a.trusted && patch.mutate({ trusted: false })}>Monitored</button>
            <span style={{ fontSize: '.72rem', color: 'var(--text-3)' }}>
              {a.trusted ? 'Their hours count when logged, and they can confirm finished jobs.' : 'Their hours wait for your review.'}</span>
          </div>
        )}
      </div>

      {/* ── their record ── */}
      {tracks && record && record.submitted > 0 && (
        <div className="card" style={card}>
          <div style={label}>Record</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14 }}>
            <Figure name="Times turned in" value={String(record.submitted)} />
            <Figure name="Approved" value={record.approvedPct == null ? '—' : `${record.approved} (${record.approvedPct}%)`} />
            <Figure name="Denied" value={record.deniedPct == null ? '—' : `${record.denied} (${record.deniedPct}%)`} accent={Number(record.deniedPct) >= 33} />
            <Figure name="Hours denied" value={record.hoursDeniedPct == null ? '—' : `${fmtH(record.hoursDenied)} (${record.hoursDeniedPct}%)`} />
          </div>
        </div>
      )}

      {/* ── hours ── */}
      {tracks && (
        <div className="card" style={card}>
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: 8 }}>
            <div style={{ ...label, marginBottom: 0, flex: 1 }}>Hours</div>
            {canLog && !logging && <button className="btn btn-primary btn-sm" onClick={() => setLogging(true)}><Clock size={12} /> Log hours</button>}
          </div>
          {logging && (
            <div style={{ display: 'grid', gridTemplateColumns: '140px 90px 1fr', gap: 8, marginBottom: 10 }}>
              <input className="input" type="date" value={form.workDate} onChange={e => setForm(f => ({ ...f, workDate: e.target.value }))} />
              <input className="input" type="number" step="0.25" min="0.25" placeholder="Hours" value={form.hours} onChange={e => setForm(f => ({ ...f, hours: e.target.value }))} />
              <input className="input" placeholder="What was done" value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} />
              <div style={{ gridColumn: '1 / -1', display: 'flex', gap: 6 }}>
                <button className="btn btn-primary btn-sm" disabled={logHours.isLoading || !(Number(form.hours) > 0) || form.description.trim().length < 3} onClick={() => logHours.mutate()}>Save</button>
                <button className="btn btn-ghost btn-sm" onClick={() => setLogging(false)}>Cancel</button>
              </div>
            </div>
          )}
          {logs.length === 0 && <div style={{ fontSize: '.8rem', color: 'var(--text-3)' }}>No hours turned in yet.</div>}
          {logs.map(l => (
            <div key={l.id} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '8px 0', borderTop: '1px solid var(--border-0, var(--b1))' }}>
              <div style={{ width: 92, fontSize: '.76rem', color: 'var(--text-2)', flexShrink: 0 }}>{fmtDate(l.workDate)}</div>
              <div style={{ width: 62, fontFamily: 'monospace', fontWeight: 700, fontSize: '.82rem', color: 'var(--text-0)', flexShrink: 0 }}>{Number(l.hours)} h</div>
              <div style={{ flex: 1, minWidth: 0, fontSize: '.8rem', color: 'var(--text-1)' }}>
                {l.description}
                {l.status === 'rejected' && l.rejectionReason && <div style={{ fontSize: '.72rem', color: 'var(--text-3)', marginTop: 2 }}>Denied: {l.rejectionReason}</div>}
                {denying && denying.id === l.id && (
                  <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                    <input className="input" style={{ flex: 1 }} placeholder="Why (they will see this)" value={denying.reason} onChange={e => setDenying({ id: l.id, reason: e.target.value })} />
                    <button className="btn btn-primary btn-sm" disabled={review.isLoading} onClick={() => review.mutate({ id: l.id, action: 'reject', reason: denying.reason.trim() || undefined })}>Deny</button>
                    <button className="btn btn-ghost btn-sm" onClick={() => setDenying(null)}>Cancel</button>
                  </div>
                )}
              </div>
              <span className="badge" style={{ fontSize: '.64rem', flexShrink: 0,
                color: l.status === 'approved' ? 'var(--green, #3fb97f)' : l.status === 'rejected' ? 'var(--red, #dc4c4c)' : 'var(--text-2)' }}>
                {WORK_TRADE_LOG_STATUS_LABEL[l.status] ?? l.status}</span>
              {isLandlord && denying?.id !== l.id && (
                <span style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                  {l.status !== 'approved' && <button className="btn btn-primary btn-sm" disabled={review.isLoading} onClick={() => review.mutate({ id: l.id, action: 'approve' })}>Approve</button>}
                  {l.status !== 'rejected' && <button className="btn btn-primary btn-sm" onClick={() => setDenying({ id: l.id, reason: '' })}>Deny</button>}
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      {/* ── end it (landlord) ── */}
      {isLandlord && a.status !== 'ended' && (
        <div style={{ marginTop: 4 }}>
          {!ending ? (
            <button className="btn btn-ghost btn-sm" onClick={() => setEnding(true)}>End this agreement</button>
          ) : (
            <div className="card" style={{ ...card, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={{ flex: 1, fontSize: '.8rem', color: 'var(--text-1)' }}>
                End it now? Any hours still owed are billed immediately, and their Work Trade tab closes.</span>
              <button className="btn btn-primary btn-sm" disabled={patch.isLoading} onClick={() => patch.mutate({ status: 'ended', endDate: new Date().toISOString().slice(0, 10) })}>End agreement</button>
              <button className="btn btn-ghost btn-sm" onClick={() => setEnding(false)}>Cancel</button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
