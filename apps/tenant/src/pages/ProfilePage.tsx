import { useState, useEffect, useRef } from 'react'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { User, Bell, Lock, Check, AlertCircle, Palette } from 'lucide-react'

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
  const [tab, setTab]     = useState<'profile'|'notifications'|'security'|'customize'>('profile')
  const [saved, setSaved] = useState('')
  const [bio, setBio]           = useState('')
  const [accent, setAccent]     = useState('#c9a227')
  const [fontStyle, setFontStyle] = useState('default')
  const [avatarUrl, setAvatarUrl] = useState<string|null>(null)
  const [avatarUploading, setAvatarUploading] = useState(false)
  const avatarRef = useRef<HTMLInputElement>(null)
  const [firstName, setFirstName] = useState('')
  const [lastName,  setLastName]  = useState('')
  const [phone,     setPhone]     = useState('')
  const [email,     setEmail]     = useState('')
  const [pwCurrent, setPwCurrent] = useState('')
  const [pwNew,     setPwNew]     = useState('')
  const [pwConfirm, setPwConfirm] = useState('')
  const [pwError,   setPwError]   = useState('')
  const [showEmailWarn, setShowEmailWarn] = useState(false)

  const { data: me } = useQuery('tenant-me-profile', () => get<any>('/tenants/me'))
  const { data: notifPrefs = [] } = useQuery<any[]>('notif-prefs-tenant', () => get('/notifications/preferences'))

  useEffect(() => {
    if (me) {
      setFirstName(me.firstName || '')
      setLastName(me.lastName || '')
      setPhone(me.phone || '')
      setEmail(me.email || '')
      setBio(me.bio || '')
      setAccent(me.themeAccent || '#c9a227')
      setFontStyle(me.fontStyle || 'default')
      setAvatarUrl(me.avatarUrl || null)
    }
  }, [me])

  const saveMut = useMutation(
    () => patchReq('/tenants/profile', { phone, email, bio, themeAccent: accent, fontStyle }),
    { onSuccess: () => {
      qc.invalidateQueries('tenant-me-profile')
      qc.invalidateQueries('tenant-me-theme')
      if (tab === 'customize') { setSaved('profile'); setTimeout(() => window.location.reload(), 500) }
      setSaved('profile')
      setTimeout(() => setSaved(''), 2500)
      if (email !== me?.email) {
        setTimeout(() => {
          localStorage.removeItem('gam_tenant_token')
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
    return channel === 'email' ? p.emailEnabled : channel === 'sms' ? p.smsEnabled : p.inAppEnabled
  }

  const togglePref = (type: string, channel: string, val: boolean) => {
    const p = (notifPrefs as any[]).find((x: any) => x.type === type) || {}
    prefMut.mutate({ type, email_enabled: p.emailEnabled ?? true, sms_enabled: p.smsEnabled ?? false, in_app_enabled: p.inAppEnabled ?? true, [channel]: val })
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
          { id:'customize',     icon:'🎨', label:'Customize' },
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
            <button className="btn btn-primary" onClick={() => email !== me?.email ? setShowEmailWarn(true) : saveMut.mutate()} disabled={saveMut.isLoading}>
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

      {tab === 'customize' && (
        <div style={{ maxWidth:480 }}>
          {/* Avatar */}
          <div style={{ marginBottom:28 }}>
            <div style={{ fontSize:'.72rem', fontWeight:700, color:'var(--t3)', textTransform:'uppercase', letterSpacing:'.07em', marginBottom:12 }}>Profile Photo</div>
            <div style={{ display:'flex', alignItems:'center', gap:16 }}>
              <div style={{ width:72, height:72, borderRadius:'50%', background:'var(--bg3)', border:'2px solid var(--b1)', overflow:'hidden', flexShrink:0, display:'flex', alignItems:'center', justifyContent:'center' }}>
                {avatarUrl
                  ? <img src={API_URL + avatarUrl} alt="avatar" style={{ width:'100%', height:'100%', objectFit:'cover' }} />
                  : <User size={28} style={{ color:'var(--t3)' }} />
                }
              </div>
              <div>
                <button className="btn btn-g" onClick={() => avatarRef.current?.click()} disabled={avatarUploading} style={{ marginBottom:6 }}>
                  {avatarUploading ? 'Uploading...' : 'Upload Photo'}
                </button>
                <div style={{ fontSize:'.7rem', color:'var(--t3)' }}>JPEG, PNG, WEBP · Max 5MB</div>
                <input ref={avatarRef} type="file" accept="image/jpeg,image/png,image/webp" style={{ display:'none' }} onChange={async e => {
                  const f = e.target.files?.[0]; if (!f) return
                  setAvatarUploading(true)
                  const fd = new FormData(); fd.append('file', f)
                  const r = await fetch(API_URL + '/api/tenants/avatar', { method:'POST', headers:{ Authorization:'Bearer '+localStorage.getItem('gam_tenant_token') }, body:fd }).then(r=>r.json())
                  if (r.success) { setAvatarUrl(r.data.url); qc.invalidateQueries('tenant-me-profile') }
                  setAvatarUploading(false)
                }} />
              </div>
            </div>
          </div>

          {/* Bio */}
          <div style={{ marginBottom:24 }}>
            <div style={{ fontSize:'.72rem', fontWeight:700, color:'var(--t3)', textTransform:'uppercase', letterSpacing:'.07em', marginBottom:8 }}>Bio <span style={{ color:'var(--t3)', fontWeight:400, textTransform:'none' }}>(visible to landlords)</span></div>
            <textarea value={bio} onChange={e => setBio(e.target.value)} rows={3} maxLength={300} placeholder="Tell landlords a little about yourself..." style={{ width:'100%', padding:'10px 12px', background:'var(--bg3)', border:'1px solid var(--b1)', borderRadius:8, color:'var(--t0)', fontSize:'.85rem', resize:'none', fontFamily:'inherit', boxSizing:'border-box' }} />
            <div style={{ fontSize:'.68rem', color:'var(--t3)', marginTop:4, textAlign:'right' }}>{bio.length}/300</div>
          </div>

          {/* Accent Color */}
          <div style={{ marginBottom:24 }}>
            <div style={{ fontSize:'.72rem', fontWeight:700, color:'var(--t3)', textTransform:'uppercase', letterSpacing:'.07em', marginBottom:12 }}>Accent Color</div>
            <div style={{ display:'flex', gap:10, flexWrap:'wrap' }}>
              {['#c9a227','#3b82f6','#22c55e','#ef4444','#a855f7','#f59e0b','#06b6d4','#ec4899','#ffffff'].map(c => (
                <button key={c} onClick={() => setAccent(c)} style={{ width:32, height:32, borderRadius:'50%', background:c, border: accent===c ? '3px solid var(--t0)' : '3px solid transparent', outline: accent===c ? '2px solid '+c : 'none', cursor:'pointer', transition:'all .15s' }} />
              ))}
              <input type="color" value={accent} onChange={e => setAccent(e.target.value)} style={{ width:32, height:32, borderRadius:'50%', border:'3px solid var(--b1)', cursor:'pointer', padding:2, background:'var(--bg3)' }} title="Custom color" />
            </div>
            <div style={{ marginTop:10, padding:'8px 12px', background:accent+'14', border:'1px solid '+accent+'44', borderRadius:8, fontSize:'.78rem', color:accent, fontWeight:600 }}>
              Preview: your accent color
            </div>
          </div>

          {/* Font Style */}
          <div style={{ marginBottom:28 }}>
            <div style={{ fontSize:'.72rem', fontWeight:700, color:'var(--t3)', textTransform:'uppercase', letterSpacing:'.07em', marginBottom:12 }}>Font Style</div>
            <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
              {[
                { key:'default',     label:'Modern Sans',  preview:'Clean and contemporary' },
                { key:'terminator',  label:'Terminator',   preview:'Bold sci-fi impact' },
                { key:'matrix',      label:'Matrix',       preview:'Digital monospace code' },
                { key:'bladerunner', label:'Blade Runner', preview:'Futuristic neo-noir' },
                { key:'teamfury',    label:'Mad Max',      preview:'Post-apocalyptic edge' },
              ].map(f => (
                <button key={f.key} onClick={() => setFontStyle(f.key)} style={{ padding:'10px 14px', borderRadius:8, border:'1px solid '+(fontStyle===f.key?accent:'var(--b1)'), background:fontStyle===f.key?accent+'14':'var(--bg3)', cursor:'pointer', textAlign:'left', transition:'all .15s' }}>
                  <div style={{ fontWeight:600, color:fontStyle===f.key?accent:'var(--t0)', fontSize:'.85rem' }}>{f.label}</div>
                  <div style={{ fontSize:'.72rem', color:'var(--t3)', marginTop:2 }}>{f.preview}</div>
                </button>
              ))}
            </div>
          </div>

          <div style={{ display:'flex', alignItems:'center', gap:10 }}>
            <button className="btn btn-primary" disabled={saveMut.isLoading} onClick={() => saveMut.mutate()}>
              {saveMut.isLoading ? <span className="spinner" /> : 'Save Preferences'}
            </button>
            {saved === 'profile' && <span style={{ fontSize:'.78rem', color:'var(--green)', display:'flex', alignItems:'center', gap:4 }}><Check size={12} /> Saved</span>}
          </div>
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
      {/* Email change warning modal */}
      {showEmailWarn && (
        <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,.75)', display:'flex', alignItems:'center', justifyContent:'center', zIndex:200, padding:20, backdropFilter:'blur(4px)' }}>
          <div style={{ background:'var(--bg-2)', border:'1px solid var(--border-0)', borderRadius:16, padding:28, width:'100%', maxWidth:420, boxShadow:'0 8px 32px rgba(0,0,0,.5)' }}>
            <div style={{ width:44, height:44, borderRadius:'50%', background:'rgba(245,158,11,.1)', border:'2px solid var(--amber)', display:'flex', alignItems:'center', justifyContent:'center', margin:'0 auto 16px' }}>
              <AlertCircle size={22} style={{ color:'var(--amber)' }} />
            </div>
            <div style={{ fontFamily:'var(--font-display)', fontSize:'1.05rem', fontWeight:800, color:'var(--text-0)', textAlign:'center', marginBottom:10 }}>Changing your email address</div>
            <div style={{ fontSize:'.82rem', color:'var(--text-2)', lineHeight:1.7, marginBottom:8, textAlign:'center' }}>
              Your email is your login. Changing it to <strong style={{ color:'var(--text-0)' }}>{email}</strong> will immediately lock you out of this session.
            </div>
            <div style={{ padding:'10px 14px', background:'rgba(245,158,11,.06)', border:'1px solid rgba(245,158,11,.2)', borderRadius:8, fontSize:'.78rem', color:'var(--amber)', marginBottom:20, lineHeight:1.6 }}>
              ⚠ You must have access to <strong>{email}</strong> before continuing. Without access to that inbox you will be locked out permanently.
            </div>
            <div style={{ display:'flex', gap:10 }}>
              <button onClick={() => setShowEmailWarn(false)} style={{ flex:1, padding:'10px', borderRadius:8, border:'1px solid var(--border-0)', background:'var(--bg-3)', color:'var(--text-1)', cursor:'pointer', fontWeight:600, fontSize:'.82rem' }}>
                Cancel
              </button>
              <button onClick={() => { setShowEmailWarn(false); saveMut.mutate() }} style={{ flex:1, padding:'10px', borderRadius:8, border:'none', background:'var(--amber)', color:'var(--bg-0)', cursor:'pointer', fontWeight:700, fontSize:'.82rem' }}>
                Yes, update email
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
