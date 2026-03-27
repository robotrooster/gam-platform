import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { apiGet, apiPatch } from '../lib/api'
import { useAuth } from '../context/AuthContext'
import { Save, User, Building2, DollarSign, Bell, Wrench } from 'lucide-react'
import { formatCurrency } from '@gam/shared'

type Tab = 'profile'|'business'|'fees'|'maintenance'|'notifications'

export function SettingsPage() {
  const qc = useQueryClient()
  const [tab, setTab] = useState<Tab>('profile')
  const [saved, setSaved] = useState(false)
  const { data: landlord } = useQuery('landlord-me', () => apiGet('/landlords/me'))
  const { data: me } = useQuery('user-me', () => apiGet('/auth/me'))
  const [profile, setProfile] = useState({ firstName:'', lastName:'', email:'', phone:'' })
  const [business, setBusiness] = useState({ businessName:'', ein:'' })
  const [fees, setFees] = useState({ bgCheckFee:'45', bgCheckFeeMin:'25' })
  const [maint, setMaint] = useState({ maintApprovalThreshold:'500' })
  const [notifs, setNotifs] = useState({ emailMaintenance:true, emailPayments:true, emailApplications:true, smsMaintenance:false, smsPayments:false })

  useEffect(() => { if (me) setProfile({ firstName:(me as any).firstName||'', lastName:(me as any).lastName||'', email:(me as any).email||'', phone:(me as any).phone||'' }) }, [me])
  useEffect(() => { if (landlord) { setBusiness({ businessName:(landlord as any).business_name||'', ein:(landlord as any).ein||'' }); setFees({ bgCheckFee:String((landlord as any).bg_check_fee||45), bgCheckFeeMin:String((landlord as any).bg_check_fee_min||25) }); setMaint({ maintApprovalThreshold:String((landlord as any).maint_approval_threshold||500) }) } }, [landlord])

  const flash = () => { setSaved(true); setTimeout(()=>setSaved(false), 2000) }
  const saveProfile = useMutation(() => apiPatch('/auth/me', profile), { onSuccess: () => { qc.invalidateQueries('user-me'); flash() } })
  const saveBusiness = useMutation(() => apiPatch('/landlords/me', business), { onSuccess: () => { qc.invalidateQueries('landlord-me'); flash() } })
  const saveFees = useMutation(() => apiPatch('/landlords/me', { bgCheckFee: parseFloat(fees.bgCheckFee), bgCheckFeeMin: parseFloat(fees.bgCheckFeeMin) }), { onSuccess: () => { qc.invalidateQueries('landlord-me'); flash() } })
  const saveMaint = useMutation(() => apiPatch('/landlords/me', { maintApprovalThreshold: parseFloat(maint.maintApprovalThreshold) }), { onSuccess: () => { qc.invalidateQueries('landlord-me'); flash() } })

  const TABS: {id:Tab,label:string,icon:any}[] = [
    {id:'profile',label:'Profile',icon:User},
    {id:'business',label:'Business',icon:Building2},
    {id:'fees',label:'Fees',icon:DollarSign},
    {id:'maintenance',label:'Maintenance',icon:Wrench},
    {id:'notifications',label:'Notifications',icon:Bell},
  ]

  const lbl = { fontSize:'.68rem', fontWeight:600, color:'var(--text-3)', textTransform:'uppercase' as const, letterSpacing:'.06em', display:'block', marginBottom:5 }

  return (
    <div style={{ maxWidth:680 }}>
      <div className="page-header">
        <div><h1 className="page-title">Settings</h1><p className="page-subtitle">Manage your account and platform preferences.</p></div>
        {saved && <div style={{ padding:'8px 16px', background:'rgba(34,197,94,.1)', border:'1px solid rgba(34,197,94,.3)', borderRadius:8, fontSize:'.82rem', color:'var(--green)', fontWeight:600 }}>✓ Saved</div>}
      </div>
      <div style={{ display:'flex', gap:4, marginBottom:24, borderBottom:'1px solid var(--border-0)' }}>
        {TABS.map(t=>(
          <button key={t.id} onClick={()=>setTab(t.id)} style={{ display:'flex', alignItems:'center', gap:6, padding:'8px 14px', border:'none', background:'none', cursor:'pointer', fontSize:'.82rem', fontWeight:600, color:tab===t.id?'var(--gold)':'var(--text-3)', borderBottom:tab===t.id?'2px solid var(--gold)':'2px solid transparent', marginBottom:-1 }}>
            <t.icon size={14}/>{t.label}
          </button>
        ))}
      </div>

      {tab==='profile' && (
        <div className="card" style={{ padding:24 }}>
          <div style={{ fontSize:'.85rem', fontWeight:700, color:'var(--text-0)', marginBottom:16 }}>Personal Information</div>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:14, marginBottom:14 }}>
            <div><label style={lbl}>First Name</label><input className="input" value={profile.firstName} onChange={e=>setProfile(p=>({...p,firstName:e.target.value}))}/></div>
            <div><label style={lbl}>Last Name</label><input className="input" value={profile.lastName} onChange={e=>setProfile(p=>({...p,lastName:e.target.value}))}/></div>
            <div><label style={lbl}>Email</label><input className="input" type="email" value={profile.email} onChange={e=>setProfile(p=>({...p,email:e.target.value}))}/></div>
            <div><label style={lbl}>Phone</label><input className="input" type="tel" value={profile.phone} onChange={e=>setProfile(p=>({...p,phone:e.target.value}))}/></div>
          </div>
          <button className="btn btn-primary" disabled={saveProfile.isLoading} onClick={()=>saveProfile.mutate()}><Save size={14}/> Save Profile</button>
        </div>
      )}

      {tab==='business' && (
        <div className="card" style={{ padding:24 }}>
          <div style={{ fontSize:'.85rem', fontWeight:700, color:'var(--text-0)', marginBottom:16 }}>Business Information</div>
          <div style={{ display:'flex', flexDirection:'column' as const, gap:14, marginBottom:14 }}>
            <div><label style={lbl}>Business Name</label><input className="input" value={business.businessName} onChange={e=>setBusiness(b=>({...b,businessName:e.target.value}))} placeholder="Acme Properties LLC"/></div>
            <div><label style={lbl}>EIN (Tax ID)</label><input className="input" value={business.ein} onChange={e=>setBusiness(b=>({...b,ein:e.target.value}))} placeholder="XX-XXXXXXX"/></div>
            <div style={{ padding:'12px 16px', background:'var(--bg-3)', borderRadius:8, fontSize:'.78rem', color:'var(--text-3)' }}>
              <strong style={{ color:'var(--text-2)' }}>Volume Tier:</strong> {(landlord as any)?.volume_tier||'standard'} &nbsp;·&nbsp; <strong style={{ color:'var(--text-2)' }}>Management:</strong> {(landlord as any)?.management_type||'self'}
            </div>
          </div>
          <button className="btn btn-primary" disabled={saveBusiness.isLoading} onClick={()=>saveBusiness.mutate()}><Save size={14}/> Save Business Info</button>
        </div>
      )}

      {tab==='fees' && (
        <div className="card" style={{ padding:24 }}>
          <div style={{ fontSize:'.85rem', fontWeight:700, color:'var(--text-0)', marginBottom:4 }}>Background Check Fees</div>
          <p style={{ fontSize:'.78rem', color:'var(--text-3)', marginBottom:16 }}>Set what you charge tenants. The platform minimum is retained by GAM.</p>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:14, marginBottom:14 }}>
            <div><label style={lbl}>Total Fee Charged to Tenant</label><div style={{ position:'relative' }}><span style={{ position:'absolute', left:10, top:'50%', transform:'translateY(-50%)', color:'var(--text-3)' }}>$</span><input className="input" style={{ paddingLeft:22 }} type="number" value={fees.bgCheckFee} onChange={e=>setFees(f=>({...f,bgCheckFee:e.target.value}))}/></div></div>
            <div><label style={lbl}>GAM Platform Fee (min)</label><div style={{ position:'relative' }}><span style={{ position:'absolute', left:10, top:'50%', transform:'translateY(-50%)', color:'var(--text-3)' }}>$</span><input className="input" style={{ paddingLeft:22 }} type="number" value={fees.bgCheckFeeMin} onChange={e=>setFees(f=>({...f,bgCheckFeeMin:e.target.value}))}/></div></div>
          </div>
          <div style={{ padding:'12px 16px', background:'rgba(201,162,39,.06)', border:'1px solid rgba(201,162,39,.2)', borderRadius:8, fontSize:'.78rem', color:'var(--text-2)', marginBottom:14 }}>
            Your net per application: <strong style={{ color:'var(--gold)' }}>{formatCurrency((parseFloat(fees.bgCheckFee)||0)-(parseFloat(fees.bgCheckFeeMin)||0))}</strong>
          </div>
          <button className="btn btn-primary" disabled={saveFees.isLoading} onClick={()=>saveFees.mutate()}><Save size={14}/> Save Fee Settings</button>
        </div>
      )}

      {tab==='maintenance' && (
        <div className="card" style={{ padding:24 }}>
          <div style={{ fontSize:'.85rem', fontWeight:700, color:'var(--text-0)', marginBottom:4 }}>Maintenance Approval Threshold</div>
          <p style={{ fontSize:'.78rem', color:'var(--text-3)', marginBottom:16 }}>Work orders above this amount require your approval before proceeding.</p>
          <div style={{ maxWidth:240, marginBottom:14 }}>
            <label style={lbl}>Auto-Approve Limit</label>
            <div style={{ position:'relative' }}><span style={{ position:'absolute', left:10, top:'50%', transform:'translateY(-50%)', color:'var(--text-3)' }}>$</span><input className="input" style={{ paddingLeft:22 }} type="number" value={maint.maintApprovalThreshold} onChange={e=>setMaint(m=>({...m,maintApprovalThreshold:e.target.value}))}/></div>
            <div style={{ fontSize:'.72rem', color:'var(--text-3)', marginTop:6 }}>Current: {formatCurrency(parseFloat(maint.maintApprovalThreshold)||0)}</div>
          </div>
          <button className="btn btn-primary" disabled={saveMaint.isLoading} onClick={()=>saveMaint.mutate()}><Save size={14}/> Save</button>
        </div>
      )}

      {tab==='notifications' && (
        <div className="card" style={{ padding:24 }}>
          <div style={{ fontSize:'.85rem', fontWeight:700, color:'var(--text-0)', marginBottom:16 }}>Notification Preferences</div>
          {[
            {key:'emailMaintenance',label:'Email — Maintenance requests',desc:'New requests, status updates'},
            {key:'emailPayments',label:'Email — Payments',desc:'Rent collected, disbursements, late notices'},
            {key:'emailApplications',label:'Email — Applications',desc:'New background check submissions'},
            {key:'smsMaintenance',label:'SMS — Maintenance emergencies',desc:'Emergency priority only'},
            {key:'smsPayments',label:'SMS — Failed payments',desc:'ACH failures, delinquency alerts'},
          ].map(n=>(
            <label key={n.key} style={{ display:'flex', alignItems:'center', justifyContent:'space-between', padding:'12px 0', borderBottom:'1px solid var(--border-0)', cursor:'pointer' }}>
              <div><div style={{ fontWeight:600, color:'var(--text-0)', fontSize:'.83rem' }}>{n.label}</div><div style={{ fontSize:'.72rem', color:'var(--text-3)' }}>{n.desc}</div></div>
              <input type="checkbox" checked={(notifs as any)[n.key]} onChange={e=>setNotifs(v=>({...v,[n.key]:e.target.checked}))} style={{ width:18, height:18, cursor:'pointer' }}/>
            </label>
          ))}
          <button className="btn btn-primary" style={{ marginTop:16 }} onClick={flash}><Save size={14}/> Save Notifications</button>
        </div>
      )}
    </div>
  )
}
