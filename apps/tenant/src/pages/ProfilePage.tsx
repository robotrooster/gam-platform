import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { User, Bell, Lock, Check, AlertCircle } from 'lucide-react'

import axios from 'axios'
const API_URL = (import.meta as any).env?.VITE_API_URL || 'http://localhost:4000'
const api = axios.create({ baseURL: `${API_URL}/api` })
api.interceptors.request.use(c => { const t = localStorage.getItem('gam_tenant_token'); if(t) c.headers.Authorization=`Bearer ${t}`; return c })
function get<T>(path: string): Promise<T> { return api.get(path).then(r => r.data?.data ?? r.data) }
function patchReq(path: string, body: any) { return api.patch(path, body).then(r => r.data) }

const NOTIF_TYPES = [
  { type:'payment_failed',              label:'Payment Failed',         desc:'When your rent payment fails' },
  { type:'maintenance_updated',         label:'Maintenance Updates',    desc:'Status changes on your requests' },
  { type:'lease_expiring_60',           label:'Lease Expiry (60 days)', desc:'60-day renewal reminder' },
  { type:'lease_expiring_30',           label:'Lease Expiry (30 days)', desc:'30-day urgent reminder' },
  { type:'lease_renewal_survey',        label:'Renewal Survey',         desc:'When landlord requests renewal intent' },
  { type:'bulk_message',                label:'Landlord Messages',      desc:'Announcements from your landlord' },
  { type:'maintenance_building_notice', label:'Building Notices',       desc:'Maintenance affecting multiple units' },
]

export function ProfilePage() {
  const qc = useQueryClient()
  const [tab, setTab]     = useState<'profile'|'notifications'|'security'>('profile')
  const [saved, setSaved] = useState('')
  const [firstName, setFirstName] = useState('')
  const [lastName,  setLastName]  = useState('')
  const [phone,     setPhone]     = useState('')
  const [email,     setEmail]     = useState('')
  const [pwCurrent, setPwCurrent] = useState('')
  const [pwNew,     setPwNew]     = useState('')
  const [pwConfirm, setPwConfirm] = useState('')
  const [pwError,   setPwError]   = useState('')

  const { data: me } = useQuery('tenant-me-profile', () => get<any>('/tenants/me'))
  const { data: notifPrefs = [] } = useQuery<any[]>('notif-prefs-tenant', () => get('/notifications/preferences'))

  useEffect(() => {
    if (me) {
      setFirstName(me.first_name || '')
      setLastName(me.last_name || '')
      setPhone(me.phone || '')
      setEmail(me.email || '')
    }
  }, [me])

  const saveMut = useMutation(
    () => patchReq('/tenants/profile', { phone, email }),
    { onSuccess: () => {
      qc.invalidateQueries('tenant-me-profile')
      setSaved('profile')
      setTimeout(() => setSaved(''), 2500)
      // If email changed, force re-login with new credentials
      if (email !== me?.email) {
        setTimeout(() => {
          localStorage.removeItem('gam_tenant_token')
          alert('Email updated. Please log in again with your new email address.')
          window.location.href = '/login'
        }, 1500)
      }
    } }
  )

  const prefMut = useMutation(
    (data: any) => patchReq('/notifications/preferences', data),
    { onSuccess: () => { qc.invalidateQueries('notif-prefs-tenant'); setSaved('pref'); setTimeout(() => setSaved(''), 2000) } }
  )

  const pwMut = useMutation(
    () => patchReq('/tenants/password', { currentPassword: pwCurrent, newPassword: pwNew }),
    { onSuccess: () => { setPwCurrent(''); setPwNew(''); setPwConfirm(''); setSaved('pw'); setTimeout(() => setSaved(''), 2500) },
      onError: () => setPwError('Incorrect current password') }
  )

  const getPref = (type: string, channel: 'email'|'sms'|'in_app') => {
    const p = (notifPrefs as any[]).find((x: any) => x.type === type)
    if (!p) return channel !== 'sms'
    return channel === 'email' ? p.email_enabled : channel === 'sms' ? p.sms_enabled : p.in_app_enabled
  }

  const togglePref = (type: string, channel: string, val: boolean) => {
    const p = (notifPrefs as any[]).find((x: any) => x.type === type) || {}
    prefMut.mutate({ type, email_enabled: p.email_enabled ?? true, sms_enabled: p.sms_enabled ?? false, in_app_enabled: p.in_app_enabled ?? true, [channel]: val })
  }

  const s = (label: string, color = 'var(--text-3)') => ({
    fontSize:'.72rem' as const, fontWeight:600 as const, color, textTransform:'uppercase' as const, letterSpacing:'.06em' as const, display:'block' as const, marginBottom:5
  })

  return (
    <div>
      <div style={{ marginBottom:24 }}>
        <h1 style={{ fontFamily:'var(--font-display)', fontSize:'1.4rem', fontWeight:800, color:'var(--text-0)', marginBottom:4 }}>My Account</h1>
        <p style={{ fontSize:'.82rem', color:'var(--text-3)' }}>Manage your profile and preferences</p>
      </div>

      <div style={{ display:'flex', gap:6, marginBottom:24, borderBottom:'1px solid var(--border-0)', paddingBottom:12 }}>
        {[
          { id:'profile',       icon:'👤', label:'Profile' },
          { id:'notifications', icon:'🔔', label:'Notifications' },
          { id:'security',      icon:'🔒', label:'Security' },
        ].map(t => (
          <button key={t.id} onClick={() => setTab(t.id as any)}
            style={{ padding:'7px 14px', borderRadius:8, border:'none', cursor:'pointer', fontSize:'.78rem', fontWeight:600, background: tab===t.id ? 'var(--gold)' : 'var(--bg-2)', color: tab===t.id ? 'var(--bg-0)' : 'var(--text-3)' }}>
            {t.icon} {t.label}
          </button>
        ))}
      </div>

      {tab === 'profile' && (
        <div style={{ maxWidth:440 }}>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12, marginBottom:12 }}>
            <div>
              <label style={s('First Name')}>First Name</label>
              <div style={{ padding:'9px 12px', background:'var(--bg-3)', border:'1px solid var(--border-0)', borderRadius:8, fontSize:'.85rem', color:'var(--text-2)' }}>{firstName || '—'}</div>
            </div>
            <div>
              <label style={s('Last Name')}>Last Name</label>
              <div style={{ padding:'9px 12px', background:'var(--bg-3)', border:'1px solid var(--border-0)', borderRadius:8, fontSize:'.85rem', color:'var(--text-2)' }}>{lastName || '—'}</div>
            </div>
          </div>
          <div style={{ fontSize:'.68rem', color:'var(--text-3)', marginBottom:14, padding:'6px 10px', background:'rgba(201,162,39,.06)', border:'1px solid rgba(201,162,39,.15)', borderRadius:6 }}>
            🔒 Legal name is locked after registration. Contact your landlord if a correction is needed.
          </div>
          <div style={{ marginBottom:12 }}>
            <label style={s('Email')}>Email</label>
            <input className="input" type="email" value={email} onChange={e => setEmail(e.target.value)} style={{ width:'100%' }} />
          </div>
          <div style={{ marginBottom:20 }}>
            <label style={s('Phone')}>Phone <span style={{ fontWeight:400, textTransform:'none', fontSize:'.68rem' }}>(for SMS alerts)</span></label>
            <input className="input" type="tel" value={phone} onChange={e => setPhone(e.target.value)} placeholder="(555) 000-0000" style={{ width:'100%' }} />
          </div>
          <div style={{ display:'flex', alignItems:'center', gap:10 }}>
            <button className="btn btn-primary" onClick={() => saveMut.mutate()} disabled={saveMut.isLoading}>
              {saveMut.isLoading ? <span className="spinner" /> : 'Save Changes'}
            </button>
            {saved==='profile' && <span style={{ fontSize:'.78rem', color:'var(--green)', display:'flex', alignItems:'center', gap:4 }}><Check size={12} /> Saved</span>}
          </div>
        </div>
      )}

      {tab === 'notifications' && (
        <div>
          <div style={{ fontSize:'.78rem', color:'var(--text-3)', marginBottom:16 }}>Choose how you receive each type of notification.</div>
          <div style={{ background:'var(--bg-2)', border:'1px solid var(--border-0)', borderRadius:10, overflow:'hidden' }}>
            <div style={{ display:'grid', gridTemplateColumns:'1fr auto auto auto', gap:0 }}>
              <div style={{ padding:'10px 16px', fontSize:'.68rem', fontWeight:700, color:'var(--text-3)', textTransform:'uppercase', letterSpacing:'.06em', borderBottom:'1px solid var(--border-0)' }}>Notification</div>
              {['In-App','Email','SMS'].map(h => (
                <div key={h} style={{ padding:'10px 16px', fontSize:'.68rem', fontWeight:700, color:'var(--text-3)', textTransform:'uppercase', letterSpacing:'.06em', borderBottom:'1px solid var(--border-0)', textAlign:'center' }}>{h}</div>
              ))}
              {NOTIF_TYPES.map((n, i) => (
                <>
                  <div key={n.type+'l'} style={{ padding:'12px 16px', borderBottom: i<NOTIF_TYPES.length-1?'1px solid var(--border-0)':'none' }}>
                    <div style={{ fontSize:'.82rem', fontWeight:600, color:'var(--text-0)' }}>{n.label}</div>
                    <div style={{ fontSize:'.68rem', color:'var(--text-3)' }}>{n.desc}</div>
                  </div>
                  {(['in_app','email','sms'] as const).map(ch => (
                    <div key={n.type+ch} style={{ padding:'12px 16px', textAlign:'center', borderBottom: i<NOTIF_TYPES.length-1?'1px solid var(--border-0)':'none', display:'flex', alignItems:'center', justifyContent:'center' }}>
                      {ch === 'in_app'
                        ? <span title="In-app notifications are always on" style={{ color:'var(--green)', fontSize:'.85rem' }}>✓</span>
                        : <input type="checkbox" checked={getPref(n.type, ch)} onChange={e => togglePref(n.type, `${ch}_enabled`, e.target.checked)} style={{ width:16, height:16, cursor:'pointer' }} />
                      }
                    </div>
                  ))}
                </>
              ))}
            </div>
          </div>
          {saved==='pref' && <div style={{ marginTop:10, fontSize:'.78rem', color:'var(--green)', display:'flex', alignItems:'center', gap:4 }}><Check size={12} /> Preferences saved</div>}
        </div>
      )}

      {tab === 'security' && (
        <div style={{ maxWidth:380 }}>
          {[
            { label:'Current Password', val:pwCurrent, set:setPwCurrent, type:'password' },
            { label:'New Password', val:pwNew, set:setPwNew, type:'password' },
            { label:'Confirm New Password', val:pwConfirm, set:setPwConfirm, type:'password' },
          ].map(f => (
            <div key={f.label} style={{ marginBottom:14 }}>
              <label style={s(f.label)}>{f.label}</label>
              <input className="input" type={f.type} value={f.val} onChange={e => { f.set(e.target.value); setPwError('') }} style={{ width:'100%' }} />
            </div>
          ))}
          {pwError && <div style={{ color:'var(--red)', fontSize:'.75rem', marginBottom:10, display:'flex', alignItems:'center', gap:6 }}><AlertCircle size={12} /> {pwError}</div>}
          {pwNew && pwConfirm && pwNew !== pwConfirm && <div style={{ color:'var(--red)', fontSize:'.75rem', marginBottom:10 }}>Passwords do not match</div>}
          <div style={{ display:'flex', alignItems:'center', gap:10 }}>
            <button className="btn btn-primary" disabled={!pwCurrent || !pwNew || pwNew !== pwConfirm || pwMut.isLoading} onClick={() => pwMut.mutate()}>
              {pwMut.isLoading ? <span className="spinner" /> : 'Update Password'}
            </button>
            {saved==='pw' && <span style={{ fontSize:'.78rem', color:'var(--green)', display:'flex', alignItems:'center', gap:4 }}><Check size={12} /> Updated</span>}
          </div>
        </div>
      )}
    </div>
  )
}
