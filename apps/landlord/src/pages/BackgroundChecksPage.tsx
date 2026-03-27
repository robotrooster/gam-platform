import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { apiGet, apiPatch } from '../lib/api'
import { Shield, Check, X, Eye, AlertTriangle } from 'lucide-react'
import { formatCurrency } from '@gam/shared'

export function BackgroundChecksPage() {
  const qc = useQueryClient()
  const [selected, setSelected] = useState(null)
  const [decision, setDecision] = useState(null)
  const [notes, setNotes] = useState('')
  const { data: checks = [], isLoading } = useQuery('background-checks', () => apiGet('/background'))
  const decideMut = useMutation(
    (d) => apiPatch('/background/' + d.id + '/decision', { decision: d.decision, notes: d.notes }),
    { onSuccess: () => { qc.invalidateQueries('background-checks'); setSelected(null); setDecision(null); setNotes('') } }
  )
  const STATUS = { submitted:'badge-amber', approved:'badge-green', denied:'badge-red' }
  const pending = checks.filter(c => c.status === 'submitted')
  return (
    <div>
      <div className="page-header">
        <div><h1 className="page-title">Background Checks</h1><p className="page-subtitle">{pending.length} pending review</p></div>
      </div>
      {pending.length > 0 && (
        <div className="alert" style={{ background:'rgba(255,184,32,.06)', border:'1px solid rgba(255,184,32,.25)', marginBottom:20 }}>
          <AlertTriangle size={16} style={{ color:'var(--amber)' }} />
          <div><strong>{pending.length} application{pending.length>1?'s':''} waiting for review.</strong> Tenants cannot access their portal until approved.</div>
        </div>
      )}
      <div className="card" style={{ padding:0 }}>
        {isLoading ? <div style={{ padding:32, textAlign:'center', color:'var(--text-3)' }}>Loading...</div> :
         checks.length === 0 ? <div className="empty-state" style={{ padding:48 }}><Shield size={40}/><h3>No applications yet</h3><p>Applications appear here when tenants submit them.</p></div> : (
          <table className="data-table">
            <thead><tr><th>Applicant</th><th>Unit</th><th>Submitted</th><th>Employment</th><th>Income</th><th>Risk</th><th>Status</th><th></th></tr></thead>
            <tbody>{checks.map(c => (
              <tr key={c.id} onClick={() => { setSelected(c); setDecision(null); setNotes('') }} style={{ cursor:'pointer' }} onMouseEnter={e=>(e.currentTarget as HTMLElement).style.background='var(--bg-2)'} onMouseLeave={e=>(e.currentTarget as HTMLElement).style.background=''}>
                <td><div style={{ fontWeight:600, color:'var(--text-0)' }}>{c.first_name} {c.last_name}</div><div style={{ fontSize:'.7rem', color:'var(--text-3)' }}>{c.email}</div></td>
                <td style={{ fontSize:'.78rem' }}>{c.unit_number ? c.property_name + ' · Unit ' + c.unit_number : '—'}</td>
                <td style={{ fontSize:'.75rem', color:'var(--text-3)' }}>{new Date(c.created_at).toLocaleDateString()}</td>
                <td style={{ fontSize:'.75rem', textTransform:'capitalize' }}>{(c.employment_status||'—').replace('_',' ')}</td>
                <td className="mono" style={{ fontSize:'.78rem' }}>{c.monthly_income ? formatCurrency(c.monthly_income)+'/mo' : '—'}</td>
                <td>
                    {c.risk_level && (
                      <span style={{ display:'inline-flex', alignItems:'center', gap:4, padding:'2px 8px', borderRadius:20, fontSize:'.68rem', fontWeight:700, background: c.risk_level==='low'?'rgba(34,197,94,.12)': c.risk_level==='medium'?'rgba(245,158,11,.12)': c.risk_level==='high'?'rgba(239,68,68,.12)':'rgba(139,0,0,.2)', color: c.risk_level==='low'?'var(--green)': c.risk_level==='medium'?'var(--amber)': c.risk_level==='high'?'var(--red)':'#ff4444' }}>
                        {c.risk_level==='low'?'🟢':c.risk_level==='medium'?'🟡':c.risk_level==='high'?'🔴':'🚨'} {c.risk_level} {c.risk_score!=null?'('+c.risk_score+')':''}
                      </span>
                    )}
                  </td>
                  <td><span className={'badge ' + (STATUS[c.status]||'badge-muted')}>{c.status}</span></td>
                <td style={{ textAlign:'right' as const }}><Eye size={12} style={{ color:'var(--text-3)' }}/></td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>
      {selected && (
        <div className="modal-overlay" onClick={() => setSelected(null)}>
          <div className="modal" style={{ maxWidth:'min(95vw, 1100px)', width:'95vw' }} onClick={e => e.stopPropagation()}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:16, flexShrink:0 }}>
              <div className="modal-title" style={{ marginBottom:0 }}>Review — {selected.first_name} {selected.last_name}</div>
              <button className="btn btn-ghost btn-sm" onClick={() => setSelected(null)}><X size={14}/></button>
            </div>
            <div style={{ overflowY:'auto', flex:1, paddingRight:4 }}>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:8, marginBottom:16 }}>
              {[['DOB', selected.date_of_birth ? new Date(selected.date_of_birth).toLocaleDateString() : '—'],
                ['SSN', selected.ssn_last4 ? '•••-••-'+selected.ssn_last4+' ✓ Format verified' : '—'],
                ['Address', selected.street1+', '+selected.city+', '+selected.state+' '+selected.zip],
                ['Employment', (selected.employment_status||'—').replace('_',' ')],
                ['Employer', selected.employer_name||'—'],
                ['Income', selected.monthly_income ? formatCurrency(selected.monthly_income)+'/mo' : '—'],
                ['Prev. Landlord', selected.prev_landlord_name||'—'],
                ['Prev. Landlord Phone', selected.prev_landlord_phone||'—'],
              ].map(([label, val]) => (
                <div key={label} style={{ background:'var(--bg-3)', borderRadius:8, padding:'8px 12px' }}>
                  <div style={{ fontSize:'.65rem', color:'var(--text-3)', textTransform:'uppercase', letterSpacing:'.06em', marginBottom:3 }}>{label}</div>
                  <div style={{ fontSize:'.82rem', color:'var(--text-0)' }}>{val}</div>
                </div>
              ))}
            </div>
            <div style={{ display:'flex', gap:8, marginBottom:16 }}>
              {[['Credit Check Consent', selected.consent_credit], ['Criminal Check Consent', selected.consent_criminal]].map(([label, val]) => (
                <div key={label} style={{ flex:1, padding:'8px 12px', borderRadius:8, background:val?'rgba(30,219,122,.08)':'var(--bg-3)', border:'1px solid '+(val?'rgba(30,219,122,.25)':'var(--border-0)'), fontSize:'.75rem', color:val?'var(--green)':'var(--text-3)' }}>
                  {val?'✓':'✗'} {label}
                </div>
              ))}
            </div>
            {/* Documents row */}
            {(selected.id_document_url || (selected.income_document_urls && (Array.isArray(selected.income_document_urls)?selected.income_document_urls:JSON.parse(selected.income_document_urls||'[]')).length > 0)) && (
              <div style={{ marginBottom:12 }}>
                <div style={{ fontSize:'.72rem', fontWeight:700, color:'var(--text-3)', textTransform:'uppercase', letterSpacing:'.06em', marginBottom:8 }}>Documents</div>
                <div style={{ display:'flex', gap:8, flexWrap:'wrap' }}>
                  {selected.id_document_url && (
                    <button className="btn btn-ghost btn-sm" onClick={async()=>{
                      const token = localStorage.getItem('gam_token')
                      const res = await fetch('http://localhost:4000'+selected.id_document_url, {headers:{Authorization:'Bearer '+token}})
                      const blob = await res.blob()
                      window.open(URL.createObjectURL(blob), '_blank')
                    }}><Eye size={12}/> Government ID</button>
                  )}
                  {(Array.isArray(selected.income_document_urls)?selected.income_document_urls:JSON.parse(selected.income_document_urls||'[]')).map((url: string, i: number) => (
                    <button key={i} className="btn btn-ghost btn-sm" onClick={async()=>{
                      const token = localStorage.getItem('gam_token')
                      const res = await fetch('http://localhost:4000'+url, {headers:{Authorization:'Bearer '+token}})
                      const blob = await res.blob()
                      window.open(URL.createObjectURL(blob), '_blank')
                    }}><Eye size={12}/> Income Doc {i+1}</button>
                  ))}
                </div>
              </div>
            )}
            
            {/* Risk Score */}
            {(() => {
              const flags = Array.isArray(selected.risk_flags) ? selected.risk_flags : JSON.parse(selected.risk_flags||'[]')
              const identity = flags.filter((f: string) => ['first_name','last_name','ssn','email','age','under_18','disposable','suspicious'].some(k=>f.includes(k)))
              const financial = flags.filter((f: string) => ['income','rent','employed','unemployed','student'].some(k=>f.includes(k)))
              const behavioral = flags.filter((f: string) => ['completed','ip','fast'].some(k=>f.includes(k)))
              const duplicate = flags.filter((f: string) => ['mismatch','denial','duplicate'].some(k=>f.includes(k)))
              const riskColor = selected.risk_level==='low'?'var(--green)':selected.risk_level==='medium'?'var(--amber)':selected.risk_level==='high'?'var(--red)':'#ff4444'
              const riskBg = selected.risk_level==='low'?'rgba(34,197,94,.08)':selected.risk_level==='medium'?'rgba(245,158,11,.08)':selected.risk_level==='high'?'rgba(239,68,68,.08)':'rgba(139,0,0,.12)'
              const FlagChip = ({f}: {f:string}) => <span style={{ padding:'2px 8px', borderRadius:5, background:'rgba(239,68,68,.08)', border:'1px solid rgba(239,68,68,.2)', fontSize:'.67rem', color:'var(--red)', fontFamily:'monospace', display:'inline-block', margin:'2px' }}>⚑ {f.replace(/_/g,' ')}</span>
              const Section = ({title, items, color}: {title:string,items:string[],color:string}) => items.length===0?null:(
                <div style={{ display:'flex', alignItems:'flex-start', gap:8, marginBottom:6, flexWrap:'wrap' }}>
                  <span style={{ fontSize:'.63rem', fontWeight:700, color, textTransform:'uppercase', letterSpacing:'.07em', whiteSpace:'nowrap', marginTop:3, minWidth:70 }}>{title}</span>
                  <div style={{ display:'flex', flexWrap:'wrap', gap:4, flex:1 }}>{items.map((f: string)=><FlagChip key={f} f={f}/>)}</div>
                </div>
              )
              return (
                <div style={{ marginBottom:16 }}>
                  <div style={{ fontSize:'.72rem', fontWeight:700, color:'var(--text-3)', textTransform:'uppercase', letterSpacing:'.06em', marginBottom:8 }}>Risk Assessment</div>
                  <div style={{ display:'flex', alignItems:'center', gap:10, padding:'8px 14px', borderRadius:10, background:riskBg, border:'1px solid '+riskColor+'44', marginBottom:12 }}>
                    <span style={{ fontSize:'1.2rem' }}>{selected.risk_level==='low'?'🟢':selected.risk_level==='medium'?'🟡':selected.risk_level==='high'?'🔴':'🚨'}</span>
                    <div>
                      <div style={{ fontWeight:700, color:riskColor, fontSize:'.85rem' }}>{selected.risk_level?.toUpperCase()} RISK</div>
                      <div style={{ fontSize:'.72rem', color:'var(--text-3)' }}>Score: {selected.risk_score}/100 · {flags.length} flag{flags.length!==1?'s':''} detected</div>
                    </div>
                  </div>
                  {flags.length === 0
                    ? <div style={{ fontSize:'.75rem', color:'var(--green)' }}>✓ No risk flags detected</div>
                    : <div style={{ display:'flex', flexWrap:'wrap', gap:4 }}>
                        {identity.map((f: string)=><FlagChip key={f} f={f}/>)}
                        {financial.map((f: string)=><span key={f} style={{ padding:'2px 8px', borderRadius:5, background:'rgba(245,158,11,.08)', border:'1px solid rgba(245,158,11,.2)', fontSize:'.67rem', color:'var(--amber)', fontFamily:'monospace', display:'inline-block' }}>⚑ {f.replace(/_/g,' ')}</span>)}
                        {behavioral.map((f: string)=><span key={f} style={{ padding:'2px 8px', borderRadius:5, background:'rgba(74,86,104,.08)', border:'1px solid var(--border-0)', fontSize:'.67rem', color:'var(--text-2)', fontFamily:'monospace', display:'inline-block' }}>⚑ {f.replace(/_/g,' ')}</span>)}
                        {duplicate.map((f: string)=><FlagChip key={f} f={f}/>)}
                      </div>
                  }
                </div>
              )
            })()}
            {selected.status === 'submitted' && (
              <div>
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8, marginBottom:12 }}>
                  {[['approved','Approve',Check,'var(--green)'],['denied','Deny',X,'var(--red)']].map(([val, label, Icon, color]) => (
                    <div key={val} onClick={() => setDecision(val)} style={{ padding:'12px', borderRadius:10, cursor:'pointer', textAlign:'center', border:'2px solid '+(decision===val?color:'var(--border-0)'), background:decision===val?color+'22':'var(--bg-2)' }}>
                      <Icon size={20} style={{ color, display:'block', margin:'0 auto 6px' }}/>
                      <div style={{ fontSize:'.82rem', fontWeight:700, color:decision===val?color:'var(--text-2)' }}>{label}</div>
                    </div>
                  ))}
                </div>
<textarea value={notes} onChange={e => setNotes(e.target.value)} rows={1} placeholder="Notes required for approve or deny..." style={{ width:'100%', padding:'8px 12px', background:'var(--bg-3)', border:'1px solid var(--border-0)', borderRadius:8, color:'var(--text-0)', fontSize:'.82rem', resize:'none' as const, fontFamily:'inherit', boxSizing:'border-box' as const, marginBottom:12 }}/>
              </div>
            )}
            {selected.status !== 'submitted' && <div style={{ padding:'10px 14px', background:'var(--bg-3)', borderRadius:8 }}>Decision: <strong style={{ color:selected.status==='approved'?'var(--green)':'var(--red)' }}>{selected.status}</strong>{selected.decision_notes && <div style={{ color:'var(--text-3)', marginTop:4, fontSize:'.8rem' }}>{selected.decision_notes}</div>}</div>}
            </div>
            <div className="modal-footer" style={{ flexShrink:0, borderTop:'1px solid var(--border-0)', marginTop:12, paddingTop:12 }}>
              <button className="btn btn-ghost" onClick={() => setSelected(null)}>Close</button>
              {selected.status === 'submitted' && decision && (
                <button className={'btn '+(decision==='approved'?'btn-primary':'')} style={decision==='denied'?{background:'var(--red)',color:'white',border:'none',padding:'8px 18px',borderRadius:8,cursor:'pointer',fontWeight:700}:{}} disabled={decideMut.isLoading||!notes.trim()} onClick={() => decideMut.mutate({ id:selected.id, decision, notes })}>
                  {decideMut.isLoading?'Processing...':decision==='approved'?<><Check size={14}/> Approve</>:<><X size={14}/> Deny</>}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}