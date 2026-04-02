import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { apiGet, apiPost } from '../lib/api'
import { Building2, Users, DollarSign, TrendingUp, Plus, X, Check, Copy, ExternalLink } from 'lucide-react'
const fmt = (n: any) => n != null ? `$${Number(n).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2})}` : '—'

function SetupModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient()
  const [form, setForm] = useState({ name:'', contactName:'', email:'', phone:'', website:'' })
  const [plans, setPlans] = useState([{ name:'Standard', feeType:'percent', percentRate:'10', flatAmount:'' }])
  const [step, setStep] = useState(0)
  const [company, setCompany] = useState<any>(null)

  const createMut = useMutation(
    () => apiPost('/pm/companies', form),
    { onSuccess: (res: any) => { setCompany(res.data); setStep(1) } }
  )

  const savePlansMut = useMutation(
    async () => {
      for (const plan of plans) {
        await apiPost(`/pm/companies/${company.id}/plans`, {
          name: plan.name, feeType: plan.feeType,
          percentRate: plan.percentRate ? parseFloat(plan.percentRate) : null,
          flatAmount: plan.flatAmount ? parseFloat(plan.flatAmount) : null,
        })
      }
    },
    { onSuccess: () => { qc.invalidateQueries('pm-dashboard'); onClose() } }
  )

  const addPlan = () => setPlans(p => [...p, { name:'', feeType:'percent', percentRate:'', flatAmount:'' }])
  const setPlan = (i: number, k: string, v: string) => setPlans(p => p.map((x, idx) => idx === i ? {...x, [k]: v} : x))

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth:520 }} onClick={e => e.stopPropagation()}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:20 }}>
          <div className="modal-title" style={{ marginBottom:0 }}>
            {step === 0 ? 'Set Up PM Company' : 'Create Fee Plans'}
          </div>
          <button className="btn btn-ghost btn-sm" onClick={onClose} style={{ padding:6 }}><X size={15} /></button>
        </div>

        {step === 0 && (
          <>
            {[
              { label:'Company Name *', key:'name', placeholder:'Smith Property Management' },
              { label:'Contact Name',   key:'contactName', placeholder:'Jane Smith' },
              { label:'Email',          key:'email', placeholder:'info@smithpm.com' },
              { label:'Phone',          key:'phone', placeholder:'(555) 000-0000' },
              { label:'Website',        key:'website', placeholder:'https://smithpm.com' },
            ].map(f => (
              <div key={f.key} style={{ marginBottom:12 }}>
                <label style={{ fontSize:'.72rem', fontWeight:600, color:'var(--text-3)', textTransform:'uppercase' as const, letterSpacing:'.06em', display:'block', marginBottom:5 }}>{f.label}</label>
                <input className="input" placeholder={f.placeholder} value={(form as any)[f.key]} onChange={e => setForm(x => ({...x, [f.key]: e.target.value}))} style={{ width:'100%' }} />
              </div>
            ))}
            <div className="modal-footer">
              <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
              <button className="btn btn-primary" disabled={!form.name || createMut.isLoading} onClick={() => createMut.mutate()}>
                {createMut.isLoading ? <span className="spinner" /> : 'Create Company →'}
              </button>
            </div>
          </>
        )}

        {step === 1 && company && (
          <>
            <div style={{ background:'rgba(30,219,122,.06)', border:'1px solid rgba(30,219,122,.2)', borderRadius:10, padding:'12px 14px', marginBottom:20 }}>
              <div style={{ fontSize:'.82rem', fontWeight:700, color:'var(--green)', marginBottom:4 }}>✓ Company Created — {company.name}</div>
              <div style={{ fontSize:'.72rem', color:'var(--text-3)', marginBottom:8 }}>Share this access code with landlords to connect:</div>
              <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                <div style={{ fontFamily:'var(--font-mono)', fontSize:'1.2rem', fontWeight:800, color:'var(--gold)', background:'var(--bg-3)', padding:'6px 14px', borderRadius:8, letterSpacing:'.12em' }}>{company.access_code}</div>
                <button className="btn btn-ghost btn-sm" onClick={() => navigator.clipboard.writeText(company.access_code)}><Copy size={13} /></button>
              </div>
            </div>

            <div style={{ marginBottom:12 }}>
              <div style={{ fontSize:'.72rem', fontWeight:600, color:'var(--text-3)', textTransform:'uppercase' as const, letterSpacing:'.06em', marginBottom:10 }}>Fee Plans</div>
              {plans.map((plan, i) => (
                <div key={i} style={{ background:'var(--bg-2)', border:'1px solid var(--border-0)', borderRadius:10, padding:12, marginBottom:10 }}>
                  <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10, marginBottom:10 }}>
                    <div>
                      <label style={{ fontSize:'.68rem', color:'var(--text-3)', display:'block', marginBottom:4 }}>Plan Name</label>
                      <input className="input" placeholder="e.g. Standard 10%" value={plan.name} onChange={e => setPlan(i,'name',e.target.value)} style={{ width:'100%' }} />
                    </div>
                    <div>
                      <label style={{ fontSize:'.68rem', color:'var(--text-3)', display:'block', marginBottom:4 }}>Fee Type</label>
                      <select className="input" style={{ width:'100%' }} value={plan.feeType} onChange={e => setPlan(i,'feeType',e.target.value)}>
                        <option value="percent">% of Rent</option>
                        <option value="flat">Flat per Unit/mo</option>
                        <option value="hybrid">Hybrid (% + Flat)</option>
                      </select>
                    </div>
                  </div>
                  <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10 }}>
                    {(plan.feeType === 'percent' || plan.feeType === 'hybrid') && (
                      <div>
                        <label style={{ fontSize:'.68rem', color:'var(--text-3)', display:'block', marginBottom:4 }}>% Rate</label>
                        <div style={{ position:'relative' }}>
                          <input className="input" type="number" step="0.5" placeholder="10" value={plan.percentRate} onChange={e => setPlan(i,'percentRate',e.target.value)} style={{ width:'100%', paddingRight:20 }} />
                          <span style={{ position:'absolute', right:9, top:'50%', transform:'translateY(-50%)', color:'var(--text-3)', fontSize:'.78rem' }}>%</span>
                        </div>
                      </div>
                    )}
                    {(plan.feeType === 'flat' || plan.feeType === 'hybrid') && (
                      <div>
                        <label style={{ fontSize:'.68rem', color:'var(--text-3)', display:'block', marginBottom:4 }}>Flat Amount/unit</label>
                        <div style={{ position:'relative' }}>
                          <span style={{ position:'absolute', left:9, top:'50%', transform:'translateY(-50%)', color:'var(--text-3)', fontSize:'.78rem' }}>$</span>
                          <input className="input" type="number" step="5" placeholder="0" value={plan.flatAmount} onChange={e => setPlan(i,'flatAmount',e.target.value)} style={{ width:'100%', paddingLeft:18 }} />
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              ))}
              <button className="btn btn-ghost btn-sm" onClick={addPlan}><Plus size={12} /> Add Another Plan</button>
            </div>

            <div className="modal-footer">
              <button className="btn btn-ghost" onClick={onClose}>Skip for now</button>
              <button className="btn btn-primary" disabled={savePlansMut.isLoading} onClick={() => savePlansMut.mutate()}>
                {savePlansMut.isLoading ? <span className="spinner" /> : <><Check size={14} /> Save & Finish</>}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function ConnectModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient()
  const [code, setCode] = useState('')
  const [company, setCompany] = useState<any>(null)
  const [plans, setPlans] = useState<any[]>([])
  const [selectedPlan, setSelectedPlan] = useState('')
  const [step, setStep] = useState(0)

  const lookupMut = useMutation(
    () => apiGet<any>(`/pm/companies/by-code/${code}`),
    { onSuccess: async (res: any) => {
      setCompany(res)
      const planRes = await apiGet<any[]>(`/pm/companies/${res.id}/plans`)
      setPlans(planRes as any[])
      setStep(1)
    }}
  )

  const connectMut = useMutation(
    () => apiPost('/pm/connect', { accessCode: code, feePlanId: selectedPlan || null }),
    { onSuccess: () => { qc.invalidateQueries('pm-fees'); onClose() } }
  )

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth:440 }} onClick={e => e.stopPropagation()}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:20 }}>
          <div className="modal-title" style={{ marginBottom:0 }}>Connect to PM Company</div>
          <button className="btn btn-ghost btn-sm" onClick={onClose} style={{ padding:6 }}><X size={15} /></button>
        </div>

        {step === 0 && (
          <>
            <div style={{ marginBottom:16 }}>
              <label style={{ fontSize:'.72rem', fontWeight:600, color:'var(--text-3)', textTransform:'uppercase' as const, letterSpacing:'.06em', display:'block', marginBottom:5 }}>PM Company Access Code</label>
              <input className="input" placeholder="e.g. A3F9" value={code} onChange={e => setCode(e.target.value.toUpperCase())} style={{ width:'100%', fontFamily:'var(--font-mono)', fontSize:'1.2rem', letterSpacing:'.1em' }} autoFocus />
              <div style={{ fontSize:'.68rem', color:'var(--text-3)', marginTop:4 }}>Get this code from your property manager.</div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
              <button className="btn btn-primary" disabled={!code || lookupMut.isLoading} onClick={() => lookupMut.mutate()}>
                {lookupMut.isLoading ? <span className="spinner" /> : 'Look Up →'}
              </button>
            </div>
          </>
        )}

        {step === 1 && company && (
          <>
            <div style={{ background:'var(--bg-2)', border:'1px solid var(--border-0)', borderRadius:10, padding:14, marginBottom:16 }}>
              <div style={{ fontSize:'.88rem', fontWeight:700, color:'var(--text-0)', marginBottom:4 }}>{company.name}</div>
              {company.email && <div style={{ fontSize:'.72rem', color:'var(--text-3)' }}>📧 {company.email}</div>}
              {company.website && <div style={{ fontSize:'.72rem', color:'var(--text-3)' }}>🌐 {company.website}</div>}
            </div>

            {plans.length > 0 && (
              <div style={{ marginBottom:16 }}>
                <label style={{ fontSize:'.72rem', fontWeight:600, color:'var(--text-3)', textTransform:'uppercase' as const, letterSpacing:'.06em', display:'block', marginBottom:8 }}>Select Fee Plan</label>
                <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
                  {plans.map((plan: any) => (
                    <div key={plan.id} onClick={() => setSelectedPlan(plan.id)} style={{ padding:'10px 12px', borderRadius:8, cursor:'pointer', border:`1px solid ${selectedPlan===plan.id?'var(--gold)':'var(--border-0)'}`, background:selectedPlan===plan.id?'rgba(201,162,39,.06)':'var(--bg-2)', transition:'all .12s' }}>
                      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
                        <span style={{ fontSize:'.82rem', fontWeight:600, color:'var(--text-0)' }}>{plan.name}</span>
                        <span style={{ fontFamily:'var(--font-mono)', fontSize:'.78rem', color:'var(--gold)' }}>
                          {plan.fee_type==='percent' ? `${plan.percent_rate}% of rent` :
                           plan.fee_type==='flat' ? `$${plan.flat_amount}/unit/mo` :
                           `${plan.percent_rate}% + $${plan.flat_amount}/unit`}
                        </span>
                      </div>
                      {plan.description && <div style={{ fontSize:'.68rem', color:'var(--text-3)', marginTop:2 }}>{plan.description}</div>}
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="modal-footer">
              <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
              <button className="btn btn-primary" disabled={connectMut.isLoading} onClick={() => connectMut.mutate()}>
                {connectMut.isLoading ? <span className="spinner" /> : <><Check size={14} /> Connect Portfolio</>}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

export function PMDashboardPage() {
  const [showSetup, setShowSetup] = useState(false)
  const [showConnect, setShowConnect] = useState(false)

  const { data: dashboard, isLoading, error } = useQuery('pm-dashboard', () => apiGet<any>('/pm/dashboard'), { retry: false })
  const { data: pmFees } = useQuery('pm-fees', () => apiGet<any>('/pm/landlord-fees'))

  const notSetup = (error as any)?.response?.status === 404

  if (isLoading) return <div style={{ color:'var(--text-3)', padding:32 }}>Loading…</div>

  if (notSetup) return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">Property Management</h1>
          <p className="page-subtitle">Set up your PM company or connect to an existing one</p>
        </div>
      </div>
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16, maxWidth:600 }}>
        <div className="card" style={{ textAlign:'center', padding:32, cursor:'pointer' }} onClick={() => setShowSetup(true)}>
          <div style={{ fontSize:2.5+'rem', marginBottom:12 }}>🏢</div>
          <div style={{ fontFamily:'var(--font-display)', fontSize:'1rem', fontWeight:800, color:'var(--text-0)', marginBottom:8 }}>I am a PM Company</div>
          <div style={{ fontSize:'.78rem', color:'var(--text-3)', marginBottom:16 }}>Set up your property management company profile and fee plans</div>
          <button className="btn btn-primary" style={{ width:'100%', justifyContent:'center' }}>Set Up PM Company</button>
        </div>
        <div className="card" style={{ textAlign:'center', padding:32, cursor:'pointer' }} onClick={() => setShowConnect(true)}>
          <div style={{ fontSize:2.5+'rem', marginBottom:12 }}>🔗</div>
          <div style={{ fontFamily:'var(--font-display)', fontSize:'1rem', fontWeight:800, color:'var(--text-0)', marginBottom:8 }}>I Use a PM Company</div>
          <div style={{ fontSize:'.78rem', color:'var(--text-3)', marginBottom:16 }}>Connect your portfolio to your property manager using their access code</div>
          <button className="btn btn-ghost" style={{ width:'100%', justifyContent:'center' }}>Enter Access Code</button>
        </div>
      </div>
      {showSetup && <SetupModal onClose={() => setShowSetup(false)} />}
      {showConnect && <ConnectModal onClose={() => setShowConnect(false)} />}
    </div>
  )

  if (!dashboard) return null

  const { company, landlords = [], summary } = dashboard

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">{company.name}</h1>
          <p className="page-subtitle">PM Dashboard · Access Code: <span style={{ fontFamily:'var(--font-mono)', color:'var(--gold)', fontWeight:700, letterSpacing:'.1em' }}>{company.access_code}</span></p>
        </div>
        <div style={{ display:'flex', gap:8 }}>
          <button className="btn btn-ghost" onClick={() => navigator.clipboard.writeText(company.access_code)}>
            <Copy size={14} /> Copy Code
          </button>
          <a href={`/pm/report/${company.report_token}`} target="_blank" rel="noreferrer" className="btn btn-ghost">
            <ExternalLink size={14} /> Shareable Report
          </a>
        </div>
      </div>

      {/* Summary stats */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(5,1fr)', gap:12, marginBottom:24 }}>
        {[
          { label:'Clients',        val: summary.clientCount,                          color:'var(--text-0)' },
          { label:'Total Units',    val: summary.totalUnits,                           color:'var(--text-0)' },
          { label:'Occupied',       val: `${summary.totalOccupied} / ${summary.totalUnits}`, color:'var(--green)' },
          { label:'Occupancy',      val: `${summary.occupancyRate}%`,                  color: summary.occupancyRate >= 80 ? 'var(--green)' : 'var(--amber)' },
          { label:'PM Revenue/mo',  val: fmt(summary.totalPMRevenue),       color:'var(--gold)' },
        ].map(s => (
          <div key={s.label} className="card" style={{ padding:'14px 16px' }}>
            <div style={{ fontSize:'.62rem', fontWeight:700, color:'var(--text-3)', textTransform:'uppercase' as const, letterSpacing:'.08em', marginBottom:6 }}>{s.label}</div>
            <div style={{ fontFamily:'var(--font-mono)', fontSize:'1rem', fontWeight:700, color:s.color }}>{s.val}</div>
          </div>
        ))}
      </div>

      {/* Client table */}
      <div className="card" style={{ padding:0 }}>
        <table className="data-table">
          <thead>
            <tr>
              <th>Owner</th><th>Properties</th><th>Units</th><th>Occupancy</th>
              <th>Collected Rent</th><th>Max Potential</th><th>PM Fee Plan</th><th>PM Revenue/mo</th>
            </tr>
          </thead>
          <tbody>
            {landlords.length === 0 && (
              <tr><td colSpan={8} style={{ textAlign:'center', color:'var(--text-3)', padding:32 }}>No clients connected yet. Share your access code: <strong>{company.access_code}</strong></td></tr>
            )}
            {landlords.map((l: any) => {
              const occ = l.unit_count > 0 ? Math.round((l.occupied_count / l.unit_count) * 100) : 0
              return (
                <tr key={l.id}>
                  <td>
                    <div style={{ fontWeight:600, color:'var(--text-0)', fontSize:'.82rem' }}>{l.first_name} {l.last_name}</div>
                    <div style={{ fontSize:'.68rem', color:'var(--text-3)' }}>{l.email}</div>
                  </td>
                  <td className="mono">{l.property_count}</td>
                  <td className="mono">{l.unit_count}</td>
                  <td>
                    <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                      <div style={{ flex:1, height:4, background:'var(--bg-3)', borderRadius:2, overflow:'hidden', minWidth:60 }}>
                        <div style={{ height:'100%', width:`${occ}%`, background: occ >= 80 ? 'var(--green)' : 'var(--amber)', borderRadius:2 }} />
                      </div>
                      <span style={{ fontSize:'.72rem', color: occ >= 80 ? 'var(--green)' : 'var(--amber)', minWidth:30 }}>{occ}%</span>
                    </div>
                  </td>
                  <td className="mono">{fmt(l.collected_rent)}</td>
                  <td className="mono" style={{ color:'var(--text-3)' }}>{fmt(l.max_rent)}</td>
                  <td style={{ fontSize:'.75rem' }}>
                    {l.plan_name ? (
                      <div>
                        <div style={{ fontWeight:600 }}>{l.plan_name}</div>
                        <div style={{ color:'var(--text-3)' }}>
                          {l.fee_type==='percent' ? `${l.percent_rate}%` :
                           l.fee_type==='flat' ? `$${l.flat_amount}/unit` :
                           `${l.percent_rate}% + $${l.flat_amount}`}
                        </div>
                      </div>
                    ) : '—'}
                  </td>
                  <td className="mono" style={{ color:'var(--gold)', fontWeight:700 }}>{fmt(l.pmFee)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {showSetup && <SetupModal onClose={() => setShowSetup(false)} />}
      {showConnect && <ConnectModal onClose={() => setShowConnect(false)} />}
    </div>
  )
}
