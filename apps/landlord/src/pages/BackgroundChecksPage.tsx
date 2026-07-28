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
            <thead><tr><th>Applicant</th><th>Started</th><th>Risk</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {checks.length ? checks.map((c: any) => (
                <tr key={c.id} onClick={() => setSelected(c)} style={{cursor:'pointer'}}>
                  <td style={{fontWeight:500}}>{[c.firstName, c.lastName].filter(Boolean).join(' ') || '—'}</td>
                  <td className="mono">{c.createdAt ? new Date(c.createdAt).toLocaleDateString() : '—'}</td>
                  <td>
                    {c.riskLevel
                      ? <span className={`badge ${c.riskLevel === 'low' ? 'badge-green' : c.riskLevel === 'medium' ? 'badge-amber' : 'badge-red'}`}>{c.riskLevel}{c.riskScore != null ? ` · ${c.riskScore}` : ''}</span>
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
            {field('Screening cost (billed to you)', check.landlordCharge ? `$${Number(check.landlordCharge).toFixed(2)}` : '—')}
          </div>

          {report && (
            <div style={{marginTop:8,padding:12,background:'var(--bg-3)',borderRadius:8}}>
              <div style={{fontSize:'.72rem',textTransform:'uppercase',letterSpacing:'.05em',color:'var(--text-3)',marginBottom:8}}>Report</div>
              {Object.entries(report).map(([k, v]) => v != null && (
                <div key={k} style={{display:'flex',justifyContent:'space-between',fontSize:'.82rem',padding:'3px 0'}}>
                  <span style={{color:'var(--text-2)'}}>{humanize(k)}</span>
                  <span style={{color: String(v) === 'clear' ? 'var(--green,#22c55e)' : String(v) === 'consider' ? 'var(--amber,#f59e0b)' : 'var(--text-1)',fontWeight:600}}>{humanize(String(v))}</span>
                </div>
              ))}
            </div>
          )}

          {check.status === 'denied' && (
            <div style={{marginTop:12,fontSize:'.8rem',color:'var(--text-2)'}}>This applicant was denied{check.decidedAt ? ` on ${new Date(check.decidedAt).toLocaleDateString()}` : ''}. If a screening report factored into the decision, federal law requires sending an adverse-action notice.</div>
          )}
        </div>
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose} disabled={!!busy}>Close</button>
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
