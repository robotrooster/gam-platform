import { useEffect, useMemo, useState } from 'react'
import { apiGet, apiPost, apiPatch } from '../lib/api'
import { Modal } from '../components/Modal'
import { appConfirm } from '../components/dialogs'
import {
  BUSINESS_STAFF_ROLES, BUSINESS_STAFF_ROLE_LABEL,
  BusinessStaffRole,
  BUSINESS_STAFF_PERMISSIONS,
  BUSINESS_STAFF_PERMISSION_LABEL,
  BUSINESS_STAFF_PERMISSION_GROUP,
  BUSINESS_STAFF_PERMISSIONS_BY_ROLE,
  BusinessStaffPermission,
} from '@gam/shared'
import { Settings, RotateCcw, UserX } from 'lucide-react'

/**
 * S538 — POS-portal team management for standalone operators. Same
 * business_users backend the business portal's StaffPage drives
 * (invite / permissions / revoke); owner-only per the API's gate.
 * Kept in sync with apps/business/src/pages/StaffPage.tsx.
 */
interface StaffRow {
  id: string
  staffRole: BusinessStaffRole
  status: string
  email: string
  firstName: string; lastName: string
  permissions: BusinessStaffPermission[] | null
}
interface PendingInvite {
  id: string
  email: string
  staffRole: string
  expiresAt: string
}

export function TeamPage() {
  const [staff, setStaff] = useState<StaffRow[]>([])
  const [pending, setPending] = useState<PendingInvite[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRole, setInviteRole] = useState<BusinessStaffRole>('office')
  const [inviting, setInviting] = useState(false)
  const [editing, setEditing] = useState<StaffRow | null>(null)

  const reload = async () => {
    try {
      const data = await apiGet<{ staff: any[]; pendingInvites: PendingInvite[] }>('/business-users')
      const normalized = data.staff.map(s => ({
        ...s,
        permissions: Array.isArray(s.permissions)
          ? s.permissions.filter((p: string): p is BusinessStaffPermission =>
              (BUSINESS_STAFF_PERMISSIONS as readonly string[]).includes(p))
          : [],
      })) as StaffRow[]
      setStaff(normalized)
      setPending(data.pendingInvites)
    } catch (e: any) {
      setErr(e?.response?.data?.error?.message || e?.response?.data?.error || 'Failed to load team')
    }
  }

  useEffect(() => { reload() }, [])

  const onInvite = async (e: React.FormEvent) => {
    e.preventDefault()
    setErr(null); setInviting(true)
    try {
      await apiPost('/business-users/invite', { email: inviteEmail, staffRole: inviteRole })
      setInviteEmail('')
      await reload()
    } catch (e: any) {
      setErr(e?.response?.data?.error?.message || e?.response?.data?.error || 'Invite failed')
    } finally { setInviting(false) }
  }

  const onRevoke = async (s: StaffRow) => {
    if (!(await appConfirm(`Remove ${s.firstName} ${s.lastName} from the team? Their login stops working immediately.`, { danger: true, confirmLabel: 'Remove' }))) return
    setErr(null)
    try {
      await apiPost(`/business-users/${s.id}/revoke`, {})
      await reload()
    } catch (e: any) {
      setErr(e?.response?.data?.error?.message || e?.response?.data?.error || 'Remove failed')
    }
  }

  return (
    <div>
      <h1 style={{ fontSize: '1.4rem', marginTop: 0, marginBottom: 4 }}>Team</h1>
      <div style={{ color: 'var(--text-3)', fontSize: '.85rem', marginBottom: 24 }}>
        Invite team members and control what each one can access.
      </div>

      {err && <div style={errStyle}>{err}</div>}

      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 24 }}>
        <div>
          <h2 style={h2Style}>Active team</h2>
          {staff.length === 0 ? (
            <div style={emptyStyle}>No team members yet — send an invitation to get started.</div>
          ) : (
            <table className="data-table" style={{ width: '100%' }}>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Email</th>
                  <th>Role</th>
                  <th>Permissions</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {staff.map(s => (
                  <tr key={s.id}>
                    <td style={{ fontWeight: 500 }}>{s.firstName} {s.lastName}</td>
                    <td>{s.email}</td>
                    <td>{BUSINESS_STAFF_ROLE_LABEL[s.staffRole as BusinessStaffRole] ?? s.staffRole}</td>
                    <td><span style={{ fontSize: '.75rem', color: 'var(--text-3)' }}>{(s.permissions?.length ?? 0)} granted</span></td>
                    <td>{s.status === 'active'
                      ? <span className="badge badge-green">Active</span>
                      : <span className="badge badge-muted" style={{ textTransform: 'capitalize' }}>{s.status}</span>}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {s.status === 'active' && (
                        <>
                          <button className="btn btn-ghost btn-sm" onClick={() => setEditing(s)}>
                            <Settings size={12} /> Permissions
                          </button>
                          <button className="btn btn-ghost btn-sm" style={{ color: 'var(--red)', marginLeft: 6 }} onClick={() => onRevoke(s)}>
                            <UserX size={12} /> Remove
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {pending.length > 0 && (
            <>
              <h2 style={{ ...h2Style, marginTop: 32 }}>Pending invitations</h2>
              <table className="data-table" style={{ width: '100%' }}>
                <thead>
                  <tr>
                    <th>Email</th>
                    <th>Role</th>
                    <th>Expires</th>
                  </tr>
                </thead>
                <tbody>
                  {pending.map(p => (
                    <tr key={p.id}>
                      <td>{p.email}</td>
                      <td>{BUSINESS_STAFF_ROLE_LABEL[p.staffRole as BusinessStaffRole] ?? p.staffRole}</td>
                      <td>{new Date(p.expiresAt).toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </div>

        <div>
          <h2 style={h2Style}>Invite a team member</h2>
          <form onSubmit={onInvite} className="card" style={{ padding: 20 }}>
            <label style={labelStyle}>Email</label>
            <input className="form-input" value={inviteEmail} onChange={e => setInviteEmail(e.target.value)}
              type="email" required style={{ width: '100%' }} />

            <label style={labelStyle}>Role</label>
            <select className="form-select" value={inviteRole}
              onChange={e => setInviteRole(e.target.value as BusinessStaffRole)}
              style={{ width: '100%' }}>
              {BUSINESS_STAFF_ROLES.map(r => (
                <option key={r} value={r}>{BUSINESS_STAFF_ROLE_LABEL[r]}</option>
              ))}
            </select>

            <div style={{ marginTop: 10, fontSize: '.72rem', color: 'var(--text-3)' }}>
              They start with the default permissions for this role. You can edit later from the table.
            </div>

            <button type="submit" className="btn btn-primary" disabled={inviting}
              style={{ width: '100%', marginTop: 16 }}>
              {inviting ? 'Sending…' : 'Send invitation'}
            </button>
          </form>
        </div>
      </div>

      {editing && (
        <PermissionsModal
          staff={editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); reload() }} />
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────
//  Permissions editor modal
// ─────────────────────────────────────────────────────────────────

function PermissionsModal({
  staff, onClose, onSaved,
}: {
  staff: StaffRow
  onClose: () => void
  onSaved: () => void
}) {
  const [granted, setGranted] = useState<Set<BusinessStaffPermission>>(
    new Set(staff.permissions ?? []))
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const groups = useMemo(() => {
    const out: Record<string, BusinessStaffPermission[]> = {}
    for (const p of BUSINESS_STAFF_PERMISSIONS) {
      const g = BUSINESS_STAFF_PERMISSION_GROUP[p]
      if (!out[g]) out[g] = []
      out[g].push(p)
    }
    return out
  }, [])

  const toggle = (p: BusinessStaffPermission) => {
    setGranted(prev => {
      const next = new Set(prev)
      if (next.has(p)) next.delete(p)
      else next.add(p)
      return next
    })
  }

  const submit = async () => {
    setErr(null); setBusy(true)
    try {
      await apiPatch(`/business-users/${staff.id}`, {
        permissions: Array.from(granted),
      })
      onSaved()
    } catch (e: any) {
      setErr(e?.response?.data?.error?.message || e?.response?.data?.error || 'Save failed')
    } finally { setBusy(false) }
  }

  const resetToDefault = async () => {
    if (!(await appConfirm(`Reset ${staff.firstName}'s permissions to the ${BUSINESS_STAFF_ROLE_LABEL[staff.staffRole]} role defaults?`, { confirmLabel: 'Reset' }))) return
    setErr(null); setBusy(true)
    try {
      await apiPatch(`/business-users/${staff.id}`, { resetToRoleDefault: true })
      onSaved()
    } catch (e: any) {
      setErr(e?.response?.data?.error?.message || e?.response?.data?.error || 'Reset failed')
    } finally { setBusy(false) }
  }

  const defaultPerms = new Set(BUSINESS_STAFF_PERMISSIONS_BY_ROLE[staff.staffRole])

  return (
    <Modal
      title={`${staff.firstName} ${staff.lastName} — permissions`}
      onClose={onClose}
      width={620}
      footer={
        <>
          <button className="btn btn-ghost btn-sm" onClick={resetToDefault} disabled={busy}>
            <RotateCcw size={12} /> Reset to {BUSINESS_STAFF_ROLE_LABEL[staff.staffRole]} default
          </button>
          <div style={{ flex: 1 }} />
          <button className="btn btn-ghost btn-sm" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary btn-sm" onClick={submit} disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </>
      }>
      {err && <div style={errStyle}>{err}</div>}

      <div style={{ fontSize: '.75rem', color: 'var(--text-3)', marginBottom: 16 }}>
        Role: <strong style={{ color: 'var(--text-1)' }}>{BUSINESS_STAFF_ROLE_LABEL[staff.staffRole]}</strong>.
        Each permission shows whether it matches the role's default — green dot means default-on, gray dot means default-off.
      </div>

      <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 16 }}>
        {Object.entries(groups).map(([group, perms]) => (
          <div key={group} style={{ padding: 12, background: 'var(--bg-2)', borderRadius: 8 }}>
            <div style={{
              fontSize: '.68rem', color: 'var(--text-3)',
              textTransform: 'uppercase' as const, letterSpacing: 1,
              marginBottom: 8, fontWeight: 600,
            }}>{group}</div>
            <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 6 }}>
              {perms.map(p => {
                const isOn = granted.has(p)
                const isDefault = defaultPerms.has(p)
                return (
                  <label key={p} style={{
                    display: 'flex' as const, alignItems: 'center', gap: 10,
                    padding: '6px 8px',
                    background: isOn ? 'var(--gold-bg)' : 'transparent',
                    borderRadius: 6, cursor: 'pointer',
                    fontSize: '.82rem',
                  }}>
                    <input type="checkbox" checked={isOn}
                      onChange={() => toggle(p)} />
                    <span style={{ flex: 1, color: 'var(--text-1)' }}>
                      {BUSINESS_STAFF_PERMISSION_LABEL[p]}
                    </span>
                    <span title={isDefault ? 'Default on for this role' : 'Default off for this role'}
                      style={{
                        width: 8, height: 8, borderRadius: '50%',
                        background: isDefault ? 'var(--green, #22c55e)' : 'var(--text-3)',
                      }} />
                  </label>
                )
              })}
            </div>
          </div>
        ))}
      </div>
    </Modal>
  )
}

const h2Style: React.CSSProperties = {
  fontSize: '1rem', color: 'var(--text-0)', marginTop: 0, marginBottom: 12,
}
const labelStyle: React.CSSProperties = {
  display: 'block', fontSize: '.75rem', color: 'var(--text-3)',
  marginBottom: 5, marginTop: 12,
}
const errStyle: React.CSSProperties = {
  marginBottom: 16, padding: '10px 12px',
  background: 'rgba(220,53,69,.08)', color: 'var(--red)',
  border: '1px solid rgba(220,53,69,.2)', borderRadius: 8, fontSize: '.82rem',
}
const emptyStyle: React.CSSProperties = {
  padding: 32, textAlign: 'center' as const,
  background: 'var(--bg-2)', border: '1px solid var(--border-1)',
  borderRadius: 12, color: 'var(--text-3)', fontSize: '.85rem',
}
