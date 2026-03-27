import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { apiGet, apiPost, apiPatch, apiDelete } from '../lib/api'
import { ROLE_LABELS, ROLE_PERMISSIONS } from '@gam/shared'
import { Plus, Shield, Trash2, Mail, Building2, CheckCircle, Clock, X } from 'lucide-react'

const ROLE_OPTIONS = [
  { value: 'property_manager', label: 'Property Manager', desc: 'Manages portfolio, tenants, leases, payments' },
  { value: 'onsite_manager',   label: 'On-Site Manager',  desc: 'POS, unit access, maintenance requests' },
  { value: 'maintenance',      label: 'Maintenance',      desc: 'Work orders only — no financial data' },
]

const ROLE_COLORS: Record<string, string> = {
  property_manager: 'badge-blue',
  onsite_manager:   'badge-amber',
  maintenance:      'badge-muted',
}

export function TeamPage() {
  const qc = useQueryClient()
  const [showInvite, setShowInvite] = useState(false)
  const [form, setForm] = useState({
    email: '', firstName: '', lastName: '', role: 'onsite_manager', propertyIds: [] as string[],
    permissions: { pos:true, pos_charge:true, maintenance_view:true, maintenance_create:false, maintenance_update:false, units_view:true, tenants_view:false, financials_view:false, documents_view:false, leases_view:false }
  })

  const { data: members = [], isLoading } = useQuery<any[]>('team', () => apiGet('/team'))
  const { data: properties = [] } = useQuery<any[]>('team-props', () => apiGet('/team/properties'))

  const inviteMut = useMutation(
    (data: any) => apiPost('/team', data),
    {
      onSuccess: () => {
        qc.invalidateQueries('team')
        setShowInvite(false)
        setForm({ email: '', firstName: '', lastName: '', role: 'onsite_manager', propertyIds: [] })
      }
    }
  )

  const updateMut = useMutation(
    ({ id, ...data }: any) => apiPatch(`/team/${id}`, data),
    { onSuccess: () => qc.invalidateQueries('team') }
  )

  const deleteMut = useMutation(
    (id: string) => apiDelete(`/team/${id}`),
    { onSuccess: () => qc.invalidateQueries('team') }
  )

  const ROLE_DEFAULTS: Record<string,any> = {
    property_manager: { pos:true, pos_charge:true, maintenance_view:true, maintenance_create:true, maintenance_update:true, units_view:true, tenants_view:true, financials_view:false, documents_view:true, leases_view:true },
    onsite_manager:   { pos:true, pos_charge:true, maintenance_view:true, maintenance_create:false, maintenance_update:false, units_view:true, tenants_view:false, financials_view:false, documents_view:false, leases_view:false },
    maintenance:      { pos:false, pos_charge:false, maintenance_view:true, maintenance_create:false, maintenance_update:true, units_view:false, tenants_view:false, financials_view:false, documents_view:false, leases_view:false },
  }
  const setRole = (role: string) => setForm(f => ({ ...f, role, permissions: { ...f.permissions, ...ROLE_DEFAULTS[role] } }))
  const togglePerm = (key: string) => setForm(f => ({ ...f, permissions: { ...f.permissions, [key]: !(f.permissions as any)[key] } }))

  const toggleProperty = (propId: string) => {
    setForm(f => ({
      ...f,
      propertyIds: f.propertyIds.includes(propId)
        ? f.propertyIds.filter(p => p !== propId)
        : [...f.propertyIds, propId]
    }))
  }

  const handleInvite = () => {
    if (!form.email || !form.role) return
    inviteMut.mutate(form)
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">Team</h1>
          <p className="page-subtitle">{(members as any[]).length} member{(members as any[]).length !== 1 ? 's' : ''} · Roles control what each person can see and do</p>
        </div>
        <button className="btn btn-primary" onClick={() => setShowInvite(true)}>
          <Plus size={15} /> Invite Team Member
        </button>
      </div>

      {/* Role legend */}
      <div className="card" style={{ marginBottom: 20, padding: 16 }}>
        <div className="card-title" style={{ marginBottom: 12 }}>Role Permissions</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 12 }}>
          {ROLE_OPTIONS.map(r => (
            <div key={r.value} style={{ padding: '10px 12px', background: 'var(--bg-3)', borderRadius: 8, border: '1px solid var(--border-0)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                <Shield size={12} style={{ color: 'var(--gold)' }} />
                <span style={{ fontSize: '.78rem', fontWeight: 700, color: 'var(--text-0)' }}>{r.label}</span>
              </div>
              <div style={{ fontSize: '.7rem', color: 'var(--text-3)', lineHeight: 1.5 }}>{r.desc}</div>
              <div style={{ marginTop: 6, display: 'flex', flexWrap: 'wrap', gap: 3 }}>
                {(ROLE_PERMISSIONS[r.value as keyof typeof ROLE_PERMISSIONS] || []).map((p: string) => (
                  <span key={p} style={{ fontSize: '.6rem', padding: '1px 6px', borderRadius: 10, background: 'var(--bg-4)', color: 'var(--text-3)', border: '1px solid var(--border-0)' }}>{p}</span>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Team members list */}
      {isLoading ? (
        <div className="card"><div style={{ color: 'var(--text-3)', textAlign: 'center', padding: 32 }}>Loading team…</div></div>
      ) : (members as any[]).length === 0 ? (
        <div className="empty-state">
          <Shield size={48} />
          <h3>No team members yet</h3>
          <p>Invite on-site managers, maintenance staff, or property managers to give them access to your portfolio.</p>
          <button className="btn btn-primary" onClick={() => setShowInvite(true)}><Plus size={14} /> Invite First Member</button>
        </div>
      ) : (
        <div className="card" style={{ padding: 0 }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>Member</th>
                <th>Role</th>
                <th>Properties</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {(members as any[]).map((m: any) => (
                <tr key={m.id}>
                  <td>
                    <div style={{ fontWeight: 600, color: 'var(--text-0)', fontSize: '.82rem' }}>
                      {m.first_name} {m.last_name}
                    </div>
                    <div style={{ fontSize: '.68rem', color: 'var(--text-3)', display: 'flex', alignItems: 'center', gap: 4 }}>
                      <Mail size={10} />{m.invite_email}
                    </div>
                  </td>
                  <td>
                    <span className={`badge ${ROLE_COLORS[m.role] || 'badge-muted'}`}>
                      {ROLE_LABELS[m.role] || m.role}
                    </span>
                  </td>
                  <td>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
                      {m.properties && m.properties.length > 0
                        ? m.properties.map((p: any) => (
                          <span key={p.id} style={{ fontSize: '.65rem', padding: '2px 6px', borderRadius: 10, background: 'var(--bg-3)', color: 'var(--text-2)', border: '1px solid var(--border-0)', display: 'flex', alignItems: 'center', gap: 3 }}>
                            <Building2 size={8} />{p.name}
                          </span>
                        ))
                        : <span style={{ fontSize: '.72rem', color: 'var(--text-3)' }}>All properties</span>
                      }
                    </div>
                  </td>
                  <td>
                    {m.status === 'active'
                      ? <span className="badge badge-green"><CheckCircle size={10} /> Active</span>
                      : m.status === 'pending'
                        ? <span className="badge badge-amber"><Clock size={10} /> Invite Pending</span>
                        : <span className="badge badge-muted">Inactive</span>
                    }
                  </td>
                  <td>
                    <div className="flex gap-8">
                      <select
                        value={m.role}
                        onChange={e => updateMut.mutate({ id: m.id, role: e.target.value })}
                        style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '.72rem', color: 'var(--text-2)', padding: 0 }}
                      >
                        {ROLE_OPTIONS.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
                      </select>
                      <button
                        className="btn btn-danger btn-sm"
                        onClick={() => { if (confirm(`Remove ${m.first_name} from your team?`)) deleteMut.mutate(m.id) }}
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Invite modal */}
      {showInvite && (
        <div className="modal-overlay" onClick={() => setShowInvite(false)}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 480 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
              <div className="modal-title" style={{ marginBottom: 0 }}>Invite Team Member</div>
              <button className="btn btn-ghost btn-sm" onClick={() => setShowInvite(false)} style={{ padding: 6 }}><X size={15} /></button>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 14 }}>
              <div>
                <label style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.06em', display: 'block', marginBottom: 5 }}>First Name</label>
                <input
                  className="input"
                  placeholder="Jane"
                  value={form.firstName}
                  onChange={e => setForm(f => ({ ...f, firstName: e.target.value }))}
                />
              </div>
              <div>
                <label style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.06em', display: 'block', marginBottom: 5 }}>Last Name</label>
                <input
                  className="input"
                  placeholder="Smith"
                  value={form.lastName}
                  onChange={e => setForm(f => ({ ...f, lastName: e.target.value }))}
                />
              </div>
            </div>

            <div style={{ marginBottom: 14 }}>
              <label style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.06em', display: 'block', marginBottom: 5 }}>Email Address</label>
              <input
                className="input"
                type="email"
                placeholder="jane@example.com"
                value={form.email}
                onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
                style={{ width: '100%' }}
              />
            </div>

            <div style={{ marginBottom: 14 }}>
              <label style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.06em', display: 'block', marginBottom: 8 }}>Role</label>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {ROLE_OPTIONS.map(r => (
                  <label key={r.value} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 12px', borderRadius: 8, border: `1px solid ${form.role === r.value ? 'var(--gold)' : 'var(--border-0)'}`, background: form.role === r.value ? 'rgba(201,162,39,.06)' : 'var(--bg-3)', cursor: 'pointer' }}>
                    <input type="radio" name="role" value={r.value} checked={form.role === r.value} onChange={e => setRole(e.target.value)} style={{ marginTop: 2 }} />
                    <div>
                      <div style={{ fontSize: '.8rem', fontWeight: 600, color: 'var(--text-0)' }}>{r.label}</div>
                      <div style={{ fontSize: '.7rem', color: 'var(--text-3)', marginTop: 1 }}>{r.desc}</div>
                    </div>
                  </label>
                ))}
              </div>
            </div>

            <div style={{ marginBottom: 14 }}>
              <label style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase' as const, letterSpacing: '.06em', display: 'block', marginBottom: 8 }}>Permissions</label>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                {[
                  { key:'pos',               label:'🛒 Point of Sale',       desc:'Access POS terminal' },
                  { key:'pos_charge',         label:'⚡ Charge Accounts',     desc:'Post to tenant accounts' },
                  { key:'maintenance_view',   label:'🔧 View Maintenance',    desc:'See work orders' },
                  { key:'maintenance_update', label:'✏️ Update Maintenance',  desc:'Change status, add notes' },
                  { key:'maintenance_create', label:'➕ Create Maintenance',  desc:'Submit new requests' },
                  { key:'units_view',         label:'🚪 View Units',          desc:'See unit details' },
                  { key:'tenants_view',       label:'👤 View Tenants',        desc:'See tenant info' },
                  { key:'financials_view',    label:'💰 View Financials',     desc:'See rent and payments' },
                  { key:'documents_view',     label:'📄 View Documents',      desc:'Access documents' },
                  { key:'leases_view',        label:'📋 View Leases',         desc:'Access leases' },
                ].map(p => {
                  const on = (form.permissions as any)[p.key]
                  return (
                    <div key={p.key} onClick={() => togglePerm(p.key)} style={{ display:'flex', alignItems:'center', gap:8, padding:'8px 10px', borderRadius:8, border:`1px solid ${on ? 'rgba(201,162,39,.3)' : 'var(--border-0)'}`, background: on ? 'rgba(201,162,39,.06)' : 'var(--bg-2)', cursor:'pointer', transition:'all .12s' }}>
                      <div style={{ width:16, height:16, borderRadius:4, border:`2px solid ${on ? 'var(--gold)' : 'var(--border-0)'}`, background: on ? 'var(--gold)' : 'transparent', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
                        {on && <span style={{ color:'var(--bg-0)', fontSize:'.6rem', fontWeight:900 }}>✓</span>}
                      </div>
                      <div>
                        <div style={{ fontSize:'.72rem', fontWeight:600, color: on ? 'var(--text-0)' : 'var(--text-3)' }}>{p.label}</div>
                        <div style={{ fontSize:'.62rem', color:'var(--text-3)' }}>{p.desc}</div>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>

            {(properties as any[]).length > 0 && (
              <div style={{ marginBottom: 16 }}>
                <label style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.06em', display: 'block', marginBottom: 8 }}>
                  Property Access <span style={{ color: 'var(--text-3)', fontWeight: 400, textTransform: 'none' }}>(leave empty for all)</span>
                </label>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {(properties as any[]).map((p: any) => (
                    <label key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', borderRadius: 7, border: '1px solid var(--border-0)', background: 'var(--bg-3)', cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={form.propertyIds.includes(p.id)}
                        onChange={() => toggleProperty(p.id)}
                      />
                      <Building2 size={13} style={{ color: 'var(--text-3)' }} />
                      <span style={{ fontSize: '.8rem', color: 'var(--text-0)' }}>{p.name}</span>
                      <span style={{ fontSize: '.7rem', color: 'var(--text-3)', marginLeft: 'auto' }}>{p.city}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}

            <div className="modal-footer">
              <button className="btn btn-ghost" onClick={() => setShowInvite(false)}>Cancel</button>
              <button
                className="btn btn-primary"
                disabled={!form.email || !form.role || inviteMut.isLoading}
                onClick={handleInvite}
              >
                {inviteMut.isLoading ? <span className="spinner" /> : <><Mail size={14} /> Send Invite</>}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
