import { useState } from 'react'
import { useQuery } from 'react-query'
import { humanize } from '@gam/shared'
import { apiGet, apiPatch, apiPost } from '../lib/api'
import { toast } from '../components/dialogs'

// S527 W-6: the real applicant list is GET /background (not /background-checks).
// S561: rows are now clickable → a review modal with Approve / Deny. On Deny,
// the landlord composes and sends their OWN adverse-action notice (GAM authors
// no legal content); GAM returns the credit-bureau contact facts + the
// landlord's saved template to help, and delivers/records what they send.
const STATUS_MAP: Record<string, string> = {
  approved: 'badge-green', denied: 'badge-red', pending: 'badge-amber',
  awaiting_applicant: 'badge-amber', submitted: 'badge-blue',
  processing: 'badge-blue', complete: 'badge-green',
  failed: 'badge-red', cancelled: 'badge-muted', expired: 'badge-muted',
}
// Statuses the API's /decision route will accept a decision for.
const DECIDABLE = new Set(['complete', 'submitted', 'processing'])

type Cra = { name: string; address: string; phone: string; website: string | null }

export function BackgroundChecksPage() {
  const { data: checks = [], isLoading, refetch } = useQuery<any[]>('background-checks', () => apiGet('/background'))
  const [selected, setSelected] = useState<any | null>(null)
  const [denyFlow, setDenyFlow] = useState<{ checkId: string; cra: Cra | null; savedTemplate: string | null } | null>(null)

  return (
    <div>
      <div className="page-header">
        <div><h1 className="page-title">Background Checks</h1><p className="page-subtitle">Applicant screening results</p></div>
      </div>
      <div className="card" style={{padding:0,overflowX:'auto'}}>
        {isLoading ? <div style={{padding:32,color:'var(--text-3)',textAlign:'center'}}>Loading…</div> : (
          <table className="data-table" style={{minWidth:780}}>
            {/* S639 (Nic): "is that low risk vetted by Checkr?" No — and the
                column said "Risk" as though it were. riskLevel is GAM's own
                INTAKE score, computed from what the applicant typed on the form
                (stated income, employment, how fast they filled it in) before
                Checkr is contacted at all. Anastacio read "low" here while
                Checkr's verdict on him was CONSIDER. Two different questions,
                and the screening answer is the one a tenancy turns on, so it
                gets the column and the intake score is named for what it is. */}
            <thead><tr><th>Applicant</th><th>Started</th><th>Screening</th><th>Intake score</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {checks.length ? checks.map((c: any) => (
                <tr key={c.id} onClick={() => setSelected(c)} style={{cursor:'pointer'}}>
                  <td style={{fontWeight:500}}>{[c.firstName, c.lastName].filter(Boolean).join(' ') || '—'}</td>
                  <td className="mono">{c.createdAt ? new Date(c.createdAt).toLocaleDateString() : '—'}</td>
                  <td>
                    {(() => {
                      // Checkr's verdict — the one that matters for a tenancy decision.
                      const v = (c.reportSummary && typeof c.reportSummary === 'object')
                        ? (c.reportSummary as any).result : null
                      return <span className={`badge ${v === 'clear' ? 'badge-green' : v === 'consider' ? 'badge-amber' : 'badge-muted'}`}>
                        {v === 'clear' ? 'Clear' : v === 'consider' ? 'Consider' : 'Not back yet'}
                      </span>
                    })()}
                  </td>
                  <td>
                    {c.riskLevel
                      ? <span className={`badge ${c.riskLevel === 'low' ? 'badge-green' : c.riskLevel === 'medium' ? 'badge-amber' : 'badge-red'}`} title="GAM's intake plausibility score from the application form — NOT the background check result">{c.riskLevel}{c.riskScore != null ? ` · ${c.riskScore}` : ''}</span>
                      : <span style={{color:'var(--text-3)'}}>—</span>}
                  </td>
                  <td><span className={`badge ${STATUS_MAP[c.status] || 'badge-muted'}`}>{humanize(c.status) || '—'}</span></td>
                  <td style={{textAlign:'right',color:'var(--text-3)',fontSize:'.8rem'}}>Review →</td>
                </tr>
              )) : (
                <tr><td colSpan={5} style={{textAlign:'center',color:'var(--text-3)',padding:32}}>No background checks yet.</td></tr>
              )}
            </tbody>
          </table>
        )}
      </div>

      {selected && (
        <ReviewModal
          check={selected}
          onClose={() => setSelected(null)}
          onDecided={(denied) => {
            refetch()
            if (denied) {
              // Deny → open the adverse-action compose modal with the facts
              // the decision response handed back.
              setDenyFlow(denied)
            }
            setSelected(null)
          }}
        />
      )}

      {denyFlow && (
        <AdverseActionModal
          flow={denyFlow}
          onClose={() => setDenyFlow(null)}
          onSent={() => { setDenyFlow(null); refetch() }}
        />
      )}
    </div>
  )
}

// ========== Applicant review + decision ==========
function ReviewModal({ check, onClose, onDecided }: {
  check: any
  onClose: () => void
  onDecided: (denyFlow: { checkId: string; cra: Cra | null; savedTemplate: string | null } | null) => void
}) {
  const [busy, setBusy] = useState<'' | 'approved' | 'denied'>('')
  const decidable = DECIDABLE.has(check.status)

  // S639: an approval used to end at "approved" with nothing to click. The
  // application already carries the space, the move-in date and the term, so
  // the next step is one button — it files the screening as an application and
  // hands it to the same drafter the listings door uses.
  const [drafting, setDrafting] = useState(false)
  const [pickedUnit, setPickedUnit] = useState('')
  // A walk-up who scanned the park's QR code named no space — that is the point
  // of the code. The park IS known, so the choice is between ITS vacant units
  // and nothing else: unit numbers repeat across parks, and a cross-property
  // list here would let one wrong click file a lease at another property.
  const needsUnit = check.status === 'approved' && !check.unitId
  const { data: vacants = [] } = useQuery<any[]>(
    ['vacant-units', check.propertyId],
    () => apiGet(`/units?propertyId=${check.propertyId}`),
    { enabled: !!(needsUnit && check.propertyId) },
  )
  const choosable = (vacants as any[]).filter(u => u.status === 'vacant')

  const draftLease = async () => {
    setDrafting(true)
    try {
      const res: any = await apiPost(`/background/${check.id}/draft-lease`,
        pickedUnit ? { unitId: pickedUnit } : {})
      const leaseId = res?.leaseId || res?.data?.leaseId
      toast('Draft lease created — review the terms, then send it for signing.')
      onClose()
      if (leaseId) window.location.href = `/leases?open=${leaseId}`
    } catch (e: any) {
      toast.error(e?.response?.data?.error || 'Could not draft a lease.')
      setDrafting(false)
    }
  }

  const decide = async (decision: 'approved' | 'denied') => {
    setBusy(decision)
    try {
      const res: any = await apiPatch(`/background/${check.id}/decision`, { decision })
      if (decision === 'approved') {
        toast('Applicant approved.')
        onDecided(null)
      } else {
        toast('Applicant denied. Send them an adverse-action notice.')
        onDecided({
          checkId: check.id,
          cra: res?.adverseAction?.craInfo ?? null,
          savedTemplate: res?.adverseAction?.savedTemplate ?? null,
        })
      }
    } catch (e: any) {
      toast.error(e?.response?.data?.error || 'Could not record the decision.')
      setBusy('')
    }
  }

  const field = (label: string, value: any) => (
    <div style={{marginBottom:10}}>
      <div style={{fontSize:'.68rem',textTransform:'uppercase',letterSpacing:'.05em',color:'var(--text-3)',marginBottom:2}}>{label}</div>
      <div style={{fontSize:'.88rem',color:'var(--text-1)'}}>{value || '—'}</div>
    </div>
  )

  const report = check.reportSummary && typeof check.reportSummary === 'object' ? check.reportSummary : null

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{maxWidth:640}} onClick={e => e.stopPropagation()}>
        <div className="modal-title">{[check.firstName, check.lastName].filter(Boolean).join(' ') || 'Applicant'} — screening review</div>
        <div style={{padding:16,maxHeight:'62vh',overflowY:'auto'}}>
          {/* Identity + basics only. Employment/income/prior-landlord were
              self-reported intake fields (not Checkr data) — dropped per the
              keep-it-simple rule. Real deciding factors come from the Checkr
              report block below. */}
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:'0 24px'}}>
            {field('Status', humanize(check.status))}
            {field('Property / Unit', [check.propertyName, check.unitNumber && `Unit ${check.unitNumber}`].filter(Boolean).join(' · '))}
            {field('Email', check.email)}
            {field('Phone', check.phone)}
            {field('Applied', check.createdAt ? new Date(check.createdAt).toLocaleDateString() : null)}
            {/* S639 (Nic): "I don't know how much he's wanting to have the spot
                for... I don't wanna do back and forth with, hey, they told me
                something, and then I forgot because I was busy." Asked on the
                application now, so the answer is sitting here when he decides. */}
            {field('Wants to move in', check.desiredMoveIn ? new Date(check.desiredMoveIn + 'T00:00:00').toLocaleDateString() : null)}
            {field('Term wanted', check.desiredMonthToMonth ? 'Month to month'
              : check.desiredTermMonths ? `${check.desiredTermMonths} months` : null)}
          </div>

          {/* ── S639 (Nic): "how do I see the actual data in the report? Is the
              landlord gonna have to go to the Checkr settings?" ─────────────

              They could not see it. This block looped the summary's TOP level,
              so it printed order_id, provider and report_id — identifiers of no
              use to anybody — while the findings themselves sat one level down
              inside `products` and rendered as nothing at all. Anastacio
              Erreguin's report came back CONSIDER on the credit file and clear
              on everything else, and none of that reached the screen.

              Per-product, plainly, with the overall verdict first. */}
          {report && (
            <div style={{marginTop:8,padding:12,background:'var(--bg-3)',borderRadius:8}}>
              <div style={{fontSize:'.72rem',textTransform:'uppercase',letterSpacing:'.05em',color:'var(--text-3)',marginBottom:8}}>
                Background report · Checkr
              </div>
              {(() => {
                // report_summary is on camelize's JSONB_PASSTHROUGH_KEYS list, so
                // Checkr's own response shape survives verbatim — these inner keys
                // are deliberately snake_case and camelCase reads return undefined.
                // S639: the API camelizes with lib/caseConversion, which has NO
                // passthrough list — it descends into jsonb, so Checkr's own
                // snake_case keys arrive camelCased and are read that way.
                // (packages/shared/camelize DOES have a passthrough list; it is a
                // different, client-side camelizer. I read that one, marked the
                // wire-contract guard a false positive, and shipped reads that
                // returned undefined — the exact bug the guard exists to catch.)
                const r: any = report
                const verdict = typeof r.result === 'string' ? r.result : null
                const products: Record<string, any> = (r.products && typeof r.products === 'object') ? r.products : {}
                const details: Record<string, any> = (r.details && typeof r.details === 'object') ? r.details : {}
                // S639: the figures that explain a status — a credit score of 720
                // reading "consider" makes no sense until you can see the 720.
                const detailFor = (k: string): string | null => {
                  const d = details[k]
                  if (!d || typeof d !== 'object') return null
                  const bits: string[] = []
                  if (d.creditScore != null) bits.push(`score ${d.creditScore}`)
                  if (d.recordsCount != null) bits.push(`${d.recordsCount} record${Number(d.recordsCount) === 1 ? '' : 's'}`)
                  const fileStatus = d.creditFileStatus
                  if (typeof fileStatus === 'string' && fileStatus !== 'available') bits.push(humanize(fileStatus))
                  return bits.length ? bits.join(' · ') : null
                }
                const reportId: string | null = r.reportId ? String(r.reportId) : null
                const fetchedAt: string | null = r.fetchedAt ? String(r.fetchedAt) : null
                const tone = (v: string) => v === 'clear' ? 'var(--green,#22c55e)'
                  : v === 'consider' ? 'var(--amber,#f59e0b)' : 'var(--text-1)'
                return (
                  <>
                    {verdict && (
                      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',
                                   paddingBottom:8,marginBottom:8,borderBottom:'1px solid var(--border-0)'}}>
                        <span style={{color:'var(--text-1)',fontWeight:700}}>Overall</span>
                        <span style={{color:tone(verdict),fontWeight:800,fontSize:'.95rem'}}>
                          {verdict === 'clear' ? 'Clear' : verdict === 'consider' ? 'Consider — review before deciding' : humanize(verdict)}
                        </span>
                      </div>
                    )}
                    {Object.keys(products).length === 0 ? (
                      <div style={{fontSize:'.82rem',color:'var(--text-3)'}}>
                        No per-check results returned yet.
                      </div>
                    ) : Object.entries(products).map(([k, v]) => {
                      const extra = detailFor(k)
                      return (
                        <div key={k} style={{display:'flex',justifyContent:'space-between',fontSize:'.85rem',padding:'4px 0',gap:12}}>
                          <span style={{color:'var(--text-2)'}}>{humanize(k)}</span>
                          <span style={{textAlign:'right'}}>
                            <span style={{color:tone(String(v)),fontWeight:600}}>{humanize(String(v))}</span>
                            {extra && <span style={{color:'var(--text-3)',fontWeight:500}}> · {extra}</span>}
                          </span>
                        </div>
                      )
                    })}
                    {verdict === 'consider' && (
                      <div style={{marginTop:10,fontSize:'.78rem',color:'var(--text-2)',lineHeight:1.5}}>
                        A “consider” is not a decline, and not a judgement that a number is
                        bad — it means the result did not automatically clear the criteria set
                        on the Checkr account, so Checkr is handing you the decision. Read the
                        figures beside each line before deciding. If you do decline on one, the
                        applicant is entitled to an adverse action notice naming the agency and
                        their right to dispute; use the Adverse Action button rather than
                        declining silently.
                      </div>
                    )}
                    {reportId && (
                      <div style={{marginTop:10,fontSize:'.72rem',color:'var(--text-3)'}}>
                        Checkr report {reportId}
                        {fetchedAt ? ` · pulled ${new Date(fetchedAt).toLocaleString()}` : ''}
                      </div>
                    )}
                  </>
                )
              })()}
            </div>
          )}

          {check.status === 'denied' && (
            <div style={{marginTop:12,fontSize:'.8rem',color:'var(--text-2)'}}>This applicant was denied{check.decidedAt ? ` on ${new Date(check.decidedAt).toLocaleDateString()}` : ''}. If a screening report factored into the decision, federal law requires sending an adverse-action notice.</div>
          )}
        </div>
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose} disabled={!!busy}>Close</button>
          {check.status === 'approved' && (
            <>
              {needsUnit && (
                <select className="input" style={{maxWidth:220}} value={pickedUnit} onChange={e => setPickedUnit(e.target.value)}>
                  <option value="">Which space?</option>
                  {choosable.map(u => (
                    <option key={u.id} value={u.id}>
                      {u.unitNumber}{u.rentAmount ? ` · $${Number(u.rentAmount).toLocaleString()}/mo` : ''}
                    </option>
                  ))}
                </select>
              )}
              <button className="btn btn-primary" onClick={draftLease} disabled={drafting || (needsUnit && !pickedUnit)}>
                {drafting ? 'Drafting…' : 'Draft lease'}
              </button>
            </>
          )}
          {decidable && (
            <>
              <button className="btn" style={{background:'var(--danger,#dc2626)',color:'#fff',borderColor:'var(--danger,#dc2626)'}} onClick={() => decide('denied')} disabled={!!busy}>
                {busy === 'denied' ? 'Denying…' : 'Deny'}
              </button>
              <button className="btn btn-primary" onClick={() => decide('approved')} disabled={!!busy}>
                {busy === 'approved' ? 'Approving…' : 'Approve'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// ========== Adverse-action compose + send ==========
function AdverseActionModal({ flow, onClose, onSent }: {
  flow: { checkId: string; cra: Cra | null; savedTemplate: string | null }
  onClose: () => void
  onSent: () => void
}) {
  const [text, setText] = useState(flow.savedTemplate || '')
  const [saveTpl, setSaveTpl] = useState(false)
  const [busy, setBusy] = useState(false)

  const insertCra = () => {
    const c = flow.cra
    if (!c) return
    const block = `Consumer reporting agency that provided the report:\n  ${c.name}\n  ${c.address}\n  ${c.phone}${c.website ? `\n  ${c.website}` : ''}\n`
    setText(t => (t.trim() ? `${t.trimEnd()}\n\n${block}` : block))
  }

  const send = async () => {
    if (!text.trim()) { toast.error('Write the notice first, or choose to handle it yourself.'); return }
    setBusy(true)
    try {
      await apiPost(`/background/${flow.checkId}/adverse-action`, { text, saveAsTemplate: saveTpl })
      toast('Adverse-action notice sent to the applicant.')
      onSent()
    } catch (e: any) {
      toast.error(e?.response?.data?.error || 'Could not send the notice.')
      setBusy(false)
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{maxWidth:600}} onClick={e => e.stopPropagation()}>
        <div className="modal-title">Send adverse-action notice</div>
        <div style={{padding:16}}>
          <div style={{fontSize:'.82rem',color:'var(--text-2)',lineHeight:1.5,marginBottom:12}}>
            You denied this applicant. If a screening report factored into the decision, federal law (FCRA) requires sending them an adverse-action notice. Write it below — this is your notice; GAM only delivers it and keeps a copy. Consult your own counsel on what it must contain.
          </div>
          <textarea
            value={text}
            onChange={e => setText(e.target.value)}
            rows={10}
            placeholder="Write the adverse-action notice to the applicant…"
            style={{width:'100%',padding:'10px 12px',border:'1px solid var(--border)',borderRadius:8,background:'var(--bg-3)',color:'var(--text-0)',fontSize:'.85rem',fontFamily:'inherit',resize:'vertical',boxSizing:'border-box'}}
          />
          <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginTop:10,gap:12,flexWrap:'wrap'}}>
            <button className="btn btn-ghost btn-sm" onClick={insertCra} disabled={!flow.cra} title={flow.cra ? '' : 'No reporting-agency info on file'}>
              Insert credit-bureau contact
            </button>
            <label style={{display:'flex',alignItems:'center',gap:6,fontSize:'.8rem',color:'var(--text-2)',cursor:'pointer'}}>
              <input type="checkbox" checked={saveTpl} onChange={e => setSaveTpl(e.target.checked)} />
              Save as my reusable template
            </label>
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose} disabled={busy}>I'll handle this myself</button>
          <button className="btn btn-primary" onClick={send} disabled={busy}>{busy ? 'Sending…' : 'Send notice'}</button>
        </div>
      </div>
    </div>
  )
}
