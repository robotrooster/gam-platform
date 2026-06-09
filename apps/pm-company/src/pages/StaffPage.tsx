import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { useAuth } from '../context/AuthContext'
import { apiGet, apiPost, apiDelete } from '../lib/api'
import { Plus, X } from 'lucide-react'

interface Staff {
  id: string
  userId: string
  role: 'owner' | 'manager' | 'staff'
  status: string
  joinedAt: string | null
  email: string
  firstName: string
  lastName: string
}

interface StaffInvite {
  id: string
  email: string
  role: string
  status: string
  expiresAt: string
  createdAt: string
}

function InviteModal({ pmCompanyId, onClose }: { pmCompanyId: string; onClose: () => void }) {
  const qc = useQueryClient()
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<'owner' | 'manager' | 'staff'>('staff')

  const sendMut = useMutation(
    () => apiPost(`/pm/companies/${pmCompanyId}/invitations`, { email, role }),
    { onSuccess: () => { qc.invalidateQueries(['staff-invites', pmCompanyId]); onClose() } },
  )

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 420 }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <div className="modal-title" style={{ marginBottom: 0 }}>Invite Staff</div>
          <button className="btn btn-ghost btn-sm" onClick={onClose}><X size={15} /></button>
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={lbl}>Email</label>
          <input type="email" className="input" value={email} onChange={e => setEmail(e.target.value)} style={{ width: '100%' }} />
        </div>
        <div style={{ marginBottom: 12 }}>
          <label style={lbl}>Role</label>
          <select className="input" value={role} onChange={e => setRole(e.target.value as any)} style={{ width: '100%' }}>
            <option value="staff">Staff</option>
            <option value="manager">Manager</option>
            <option value="owner">Owner</option>
          </select>
        </div>

        {sendMut.isError && (
          <div style={{ padding: 8, background: 'rgba(220,76,76,.1)', borderRadius: 6, fontSize: '.74rem', color: 'var(--red, #dc4c4c)', marginBottom: 12 }}>
            {(sendMut.error as any)?.response?.data?.error?.message || 'Send failed.'}
          </div>
        )}

        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={!email || sendMut.isLoading} onClick={() => sendMut.mutate()}>
            {sendMut.isLoading ? 'Sending…' : 'Send Invite'}
          </button>
        </div>
      </div>
    </div>
  )
}

export function StaffPage() {
  const { activePmCompany } = useAuth()
  const cid = activePmCompany?.id
  const qc = useQueryClient()
  const [showInvite, setShowInvite] = useState(false)

  const staffQ = useQuery<Staff[]>(
    ['staff', cid],
    () => apiGet<Staff[]>(`/pm/companies/${cid}/staff`),
    { enabled: !!cid },
  )
  const invitesQ = useQuery<StaffInvite[]>(
    ['staff-invites', cid],
    () => apiGet<StaffInvite[]>(`/pm/companies/${cid}/invitations`),
    { enabled: !!cid },
  )

  const revokeMut = useMutation(
    (invId: string) => apiDelete(`/pm/companies/${cid}/invitations/${invId}`),
    { onSuccess: () => qc.invalidateQueries(['staff-invites', cid]) },
  )

  return (
    <div style={{ padding: 24 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: '1.4rem', color: 'var(--text-0)' }}>Staff</h1>
          <div style={{ fontSize: '.78rem', color: 'var(--text-3)', marginTop: 4 }}>
            Members of {activePmCompany?.name ?? 'your company'}.
          </div>
        </div>
        <button className="btn btn-primary" onClick={() => setShowInvite(true)}>
          <Plus size={14} style={{ marginRight: 6 }} /> Invite Staff
        </button>
      </div>

      <div className="card" style={{ padding: 0, overflow: 'hidden', marginBottom: 16 }}>
        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border-0)', fontWeight: 600, color: 'var(--text-0)' }}>
          Members ({(staffQ.data ?? []).length})
        </div>
        {staffQ.isLoading ? (
          <div style={{ padding: 16, color: 'var(--text-3)' }}>Loading…</div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: 'var(--bg-2)' }}>
                <Th>Name</Th><Th>Email</Th><Th>Role</Th><Th>Status</Th><Th>Joined</Th>
              </tr>
            </thead>
            <tbody>
              {(staffQ.data ?? []).map(s => (
                <tr key={s.id} style={{ borderTop: '1px solid var(--border-0)' }}>
                  <Td><strong>{s.firstName} {s.lastName}</strong></Td>
                  <Td>{s.email}</Td>
                  <Td>{s.role}</Td>
                  <Td>{s.status}</Td>
                  <Td>{s.joinedAt ? new Date(s.joinedAt).toLocaleDateString() : '—'}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border-0)', fontWeight: 600, color: 'var(--text-0)' }}>
          Pending Invitations ({(invitesQ.data ?? []).filter(i => i.status === 'pending').length})
        </div>
        {(invitesQ.data ?? []).filter(i => i.status === 'pending').length === 0 ? (
          <div style={{ padding: 16, color: 'var(--text-3)', fontSize: '.84rem' }}>None.</div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: 'var(--bg-2)' }}>
                <Th>Email</Th><Th>Role</Th><Th>Sent</Th><Th>Expires</Th><Th>{' '}</Th>
              </tr>
            </thead>
            <tbody>
              {(invitesQ.data ?? []).filter(i => i.status === 'pending').map(i => (
                <tr key={i.id} style={{ borderTop: '1px solid var(--border-0)' }}>
                  <Td>{i.email}</Td>
                  <Td>{i.role}</Td>
                  <Td>{new Date(i.createdAt).toLocaleDateString()}</Td>
                  <Td>{new Date(i.expiresAt).toLocaleString()}</Td>
                  <Td>
                    <button className="btn btn-ghost btn-sm"
                            disabled={revokeMut.isLoading}
                            onClick={() => { if (window.confirm('Revoke this invitation?')) revokeMut.mutate(i.id) }}>
                      Revoke
                    </button>
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {showInvite && cid && <InviteModal pmCompanyId={cid} onClose={() => setShowInvite(false)} />}
    </div>
  )
}

const lbl: React.CSSProperties = {
  fontSize: '.72rem', fontWeight: 600, color: 'var(--text-3)',
  textTransform: 'uppercase', letterSpacing: '.06em',
  display: 'block', marginBottom: 5,
}
const Th = ({ children }: { children: React.ReactNode }) => (
  <th style={{ padding: '10px 14px', textAlign: 'left', fontSize: '.7rem', textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--text-3)', fontWeight: 600 }}>{children}</th>
)
const Td = ({ children }: { children: React.ReactNode }) => (
  <td style={{ padding: '12px 14px', fontSize: '.84rem', color: 'var(--text-1)' }}>{children}</td>
)
