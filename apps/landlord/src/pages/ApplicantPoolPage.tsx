import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { apiGet, apiPost } from '../lib/api'
import { Search, Users, Send } from 'lucide-react'
import { formatCurrency } from '@gam/shared'

export function ApplicantPoolPage() {
  const qc = useQueryClient()
  const [filters, setFilters] = useState({ minIncome:'', maxIncome:'', state:'', riskLevel:'' })
  const [selected, setSelected] = useState<any>(null)
  const [unitId, setUnitId] = useState('')
  const [message, setMessage] = useState('')
  const [searched, setSearched] = useState(false)

  const { data: units = [] } = useQuery<any[]>('units', () => apiGet('/units'))
  const { data: pool = [], isLoading, refetch } = useQuery<any[]>(
    ['pool-search', filters],
    () => {
      const params = new URLSearchParams()
      if (filters.minIncome) params.append('minIncome', filters.minIncome)
      if (filters.maxIncome) params.append('maxIncome', filters.maxIncome)
      if (filters.state) params.append('state', filters.state)
      if (filters.riskLevel) params.append('riskLevel', filters.riskLevel)
      return apiGet('/background/pool/search?' + params.toString())
    },
    { enabled: searched }
  )

  const reachOutMut = useMutation(
    (poolId: string) => apiPost('/background/pool/' + poolId + '/reach-out', { unitId: unitId||null, message: message||null }),
    { onSuccess: () => { qc.invalidateQueries(['pool-search', filters]); setSelected(null); setMessage(''); setUnitId('') } }
  )

  const RISK_COLORS: Record<string,string> = { low:'badge-green', medium:'badge-amber', high:'badge-red', very_high:'badge-red' }

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">Applicant Pool</h1>
          <p className="page-subtitle">Pre-screened applicants who consented to vacancy matching</p>
        </div>
      </div>

      <div className="card" style={{ padding:16, marginBottom:20 }}>
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr 1fr auto', gap:10, alignItems:'flex-end' }}>
          <div>
            <label style={{ fontSize:'.68rem', fontWeight:600, color:'var(--text-3)', textTransform:'uppercase' as const, letterSpacing:'.06em', display:'block', marginBottom:4 }}>Min Income</label>
            <div style={{ position:'relative' }}><span style={{ position:'absolute', left:8, top:'50%', transform:'translateY(-50%)', color:'var(--text-3)', fontSize:'.82rem' }}>$</span><input className="input" style={{ paddingLeft:18 }} type="number" placeholder="2000" value={filters.minIncome} onChange={e=>setFilters(f=>({...f,minIncome:e.target.value}))}/></div>
          </div>
          <div>
            <label style={{ fontSize:'.68rem', fontWeight:600, color:'var(--text-3)', textTransform:'uppercase' as const, letterSpacing:'.06em', display:'block', marginBottom:4 }}>Max Income</label>
            <div style={{ position:'relative' }}><span style={{ position:'absolute', left:8, top:'50%', transform:'translateY(-50%)', color:'var(--text-3)', fontSize:'.82rem' }}>$</span><input className="input" style={{ paddingLeft:18 }} type="number" placeholder="8000" value={filters.maxIncome} onChange={e=>setFilters(f=>({...f,maxIncome:e.target.value}))}/></div>
          </div>
          <div>
            <label style={{ fontSize:'.68rem', fontWeight:600, color:'var(--text-3)', textTransform:'uppercase' as const, letterSpacing:'.06em', display:'block', marginBottom:4 }}>State</label>
            <input className="input" placeholder="AZ" maxLength={2} value={filters.state} onChange={e=>setFilters(f=>({...f,state:e.target.value.toUpperCase()}))}/>
          </div>
          <div>
            <label style={{ fontSize:'.68rem', fontWeight:600, color:'var(--text-3)', textTransform:'uppercase' as const, letterSpacing:'.06em', display:'block', marginBottom:4 }}>Risk Level</label>
            <select className="input" value={filters.riskLevel} onChange={e=>setFilters(f=>({...f,riskLevel:e.target.value}))}>
              <option value="">Any</option>
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
            </select>
          </div>
          <button className="btn btn-primary" onClick={()=>{setSearched(true);setTimeout(()=>refetch(),50)}}><Search size={14}/> Search</button>
        </div>
      </div>

      <div style={{ padding:'10px 16px', background:'rgba(201,162,39,.06)', border:'1px solid rgba(201,162,39,.2)', borderRadius:10, marginBottom:16, fontSize:'.78rem', color:'var(--text-2)', lineHeight:1.6 }}>
        <strong style={{ color:'var(--gold)' }}>How it works:</strong> Send interest to an applicant for free. If they confirm interest, pay <strong>$5</strong> to unlock their full background report.
      </div>

      <div className="card" style={{ padding:0 }}>
        {!searched ? (
          <div className="empty-state" style={{ padding:48 }}><Users size={40}/><h3>Search the applicant pool</h3><p>Use filters above to find pre-screened applicants matching your vacancy.</p></div>
        ) : isLoading ? (
          <div style={{ padding:32, textAlign:'center', color:'var(--text-3)' }}>Searching...</div>
        ) : (pool as any[]).length === 0 ? (
          <div className="empty-state" style={{ padding:48 }}><Users size={40}/><h3>No results</h3><p>No applicants match your filters. Try adjusting income range or risk level.</p></div>
        ) : (
          <table className="data-table">
            <thead><tr><th>Location</th><th>Employment</th><th>Income</th><th>Risk</th><th>In Pool Since</th><th></th></tr></thead>
            <tbody>
              {(pool as any[]).map((p: any) => (
                <tr key={p.id} onMouseEnter={e=>(e.currentTarget as HTMLElement).style.background='var(--bg-2)'} onMouseLeave={e=>(e.currentTarget as HTMLElement).style.background=''}>
                  <td><div style={{ fontWeight:600, color:'var(--text-0)' }}>{p.city}, {p.state}</div><div style={{ fontSize:'.7rem', color:'var(--text-3)' }}>{p.zip}</div></td>
                  <td style={{ fontSize:'.78rem', textTransform:'capitalize' as const }}>{(p.employment_status||'—').replace('_',' ')}</td>
                  <td className="mono" style={{ fontSize:'.78rem' }}>{p.monthly_income ? formatCurrency(p.monthly_income)+'/mo' : '—'}</td>
                  <td><span className={'badge ' + (RISK_COLORS[p.risk_level]||'badge-muted')}>{p.risk_level}</span></td>
                  <td style={{ fontSize:'.72rem', color:'var(--text-3)' }}>{new Date(p.created_at).toLocaleDateString()}</td>
                  <td>{p.already_contacted ? <span style={{ fontSize:'.72rem', color:'var(--text-3)' }}>Contacted</span> : <button className="btn btn-primary btn-sm" onClick={()=>setSelected(p)}><Send size={12}/> Reach Out</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {selected && (
        <div className="modal-overlay" onClick={()=>setSelected(null)}>
          <div className="modal" style={{ maxWidth:440 }} onClick={e=>e.stopPropagation()}>
            <div className="modal-title">Send Interest</div>
            <div style={{ background:'var(--bg-3)', border:'1px solid var(--border-0)', borderRadius:10, padding:14, marginBottom:16, fontSize:'.78rem', color:'var(--text-2)', lineHeight:1.8 }}>
              <div><strong>Location:</strong> {selected.city}, {selected.state} {selected.zip}</div>
              <div><strong>Income:</strong> {selected.monthly_income ? formatCurrency(selected.monthly_income)+'/mo' : '—'}</div>
              <div><strong>Risk:</strong> {selected.risk_level}</div>
            </div>
            <div style={{ marginBottom:12 }}>
              <label style={{ fontSize:'.72rem', fontWeight:600, color:'var(--text-3)', textTransform:'uppercase' as const, letterSpacing:'.06em', display:'block', marginBottom:5 }}>Vacancy Unit (optional)</label>
              <select className="input" style={{ width:'100%' }} value={unitId} onChange={e=>setUnitId(e.target.value)}>
                <option value="">Select unit...</option>
                {(units as any[]).map((u: any) => <option key={u.id} value={u.id}>{u.property_name} — Unit {u.unit_number} (${u.rent_amount}/mo)</option>)}
              </select>
            </div>
            <div style={{ marginBottom:16 }}>
              <label style={{ fontSize:'.72rem', fontWeight:600, color:'var(--text-3)', textTransform:'uppercase' as const, letterSpacing:'.06em', display:'block', marginBottom:5 }}>Message (optional)</label>
              <textarea value={message} onChange={e=>setMessage(e.target.value)} rows={3} placeholder="Hi, we have a vacancy that may be a good fit..." style={{ width:'100%', padding:'8px 12px', background:'var(--bg-3)', border:'1px solid var(--border-0)', borderRadius:8, color:'var(--text-0)', fontSize:'.82rem', resize:'none' as const, fontFamily:'inherit', boxSizing:'border-box' as const }}/>
            </div>
            <div style={{ padding:'10px 14px', background:'rgba(34,197,94,.06)', border:'1px solid rgba(34,197,94,.2)', borderRadius:8, fontSize:'.75rem', color:'var(--text-2)', marginBottom:16 }}>
              ✓ <strong>Free</strong> to send interest. Pay <strong>$5</strong> only if tenant confirms and you unlock their report.
            </div>
            <div className="modal-footer">
              <button className="btn btn-ghost" onClick={()=>setSelected(null)}>Cancel</button>
              <button className="btn btn-primary" disabled={reachOutMut.isLoading} onClick={()=>reachOutMut.mutate(selected.id)}>
                {reachOutMut.isLoading ? <span className="spinner"/> : <><Send size={14}/> Send Interest</>}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
