import { useEffect, useMemo, useState } from 'react'
import { apiGet, apiPost, apiPatch } from '../lib/api'
import { Modal } from '../components/Modal'
import {
  BUSINESS_STAFF_ROLES, BUSINESS_STAFF_ROLE_LABEL,
  BusinessStaffRole,
  BUSINESS_STAFF_PERMISSIONS,
  BUSINESS_STAFF_PERMISSION_LABEL,
  BUSINESS_STAFF_PERMISSION_GROUP,
  BUSINESS_STAFF_PERMISSIONS_BY_ROLE,
  BusinessStaffPermission,
} from '@gam/shared'
import { Settings, RotateCcw } from 'lucide-react'

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

export function StaffPage() {
  const [staff, setStaff] = useState<StaffRow[]>([])
  const [pending, setPending] = useState<PendingInvite[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRole, setInviteRole] = useState<BusinessStaffRole>('dispatcher')
  const [inviting, setInviting] = useState(false)
  const [editing, setEditing] = useState<StaffRow | null>(null)

  const reload = async () => {
    try {
      const data = await apiGet<{ staff: any[]; pendingInvites: PendingInvite[] }>('/business-users')
      // permissions arrives as jsonb — could be array or legacy {} object.
      // Normalize to array of catalog keys.
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
      setErr(e?.response?.data?.error || 'Failed to load staff')
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
      setErr(e?.response?.data?.error || 'Invite failed')
    } finally { setInviting(false) }
  }

  return (
    <div>
      <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 28, marginTop: 0 }}>
        Staff
      </h1>
      <div style={{ color: 'var(--text-2)', fontSize: 14, marginBottom: 24 }}>
        Invite team members and control what each one can access.
      </div>

      {err && <div style={errStyle}>{err}</div>}

      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 24 }}>
        <div>
          <h2 style={h2Style}>Active staff</h2>
          {staff.length === 0 ? (
            <div style={emptyStyle}>No staff yet.</div>
          ) : (
            <table style={tableStyle}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border-1)' }}>
                  <th style={thStyle}>Name</th>
                  <th style={thStyle}>Email</th>
                  <th style={thStyle}>Role</th>
                  <th style={thStyle}>Permissions</th>
                  <th style={thStyle}>Status</th>
                  <th style={thStyle}></th>
                </tr>
              </thead>
              <tbody>
                {staff.map(s => (
                  <tr key={s.id} style={{ borderBottom: '1px solid var(--border-0)' }}>
                    <td style={tdStyle}>{s.firstName} {s.lastName}</td>
                    <td style={tdStyle}>{s.email}</td>
                    <td style={{ ...tdStyle, textTransform: 'capitalize' as const }}>
                      {BUSINESS_STAFF_ROLE_LABEL[s.staffRole as BusinessStaffRole] ?? s.staffRole}
                    </td>
                    <td style={tdStyle}>
                      <span style={{ fontSize: 12, color: 'var(--text-2)' }}>
                        {(s.permissions?.length ?? 0)} granted
                      </span>
                    </td>
                    <td style={{ ...tdStyle, fontSize: 12 }}>
                      <span style={{
                        padding: '2px 8px', borderRadius: 4,
                        border: `1px solid ${s.status === 'active' ? 'var(--green, #22c55e)' : 'var(--text-3)'}`,
                        color: s.status === 'active' ? 'var(--green, #22c55e)' : 'var(--text-3)',
                        fontSize: 11, textTransform: 'uppercase' as const, letterSpacing: 0.5,
                      }}>{s.status}</span>
                    </td>
                    <td style={tdStyle}>
                      {s.status === 'active' && (
                        <button onClick={() => setEditing(s)}
                          style={ghostBtn}>
                          <Settings size={12} /> Permissions
                        </button>
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
              <table style={tableStyle}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--border-1)' }}>
                    <th style={thStyle}>Email</th>
                    <th style={thStyle}>Role</th>
                    <th style={thStyle}>Expires</th>
                  </tr>
                </thead>
                <tbody>
                  {pending.map(p => (
                    <tr key={p.id} style={{ borderBottom: '1px solid var(--border-0)' }}>
                      <td style={tdStyle}>{p.email}</td>
                      <td style={{ ...tdStyle, textTransform: 'capitalize' as const }}>
                        {BUSINESS_STAFF_ROLE_LABEL[p.staffRole as BusinessStaffRole] ?? p.staffRole}
                      </td>
                      <td style={tdStyle}>{new Date(p.expiresAt).toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </div>

        <div>
          <h2 style={h2Style}>Invite a staff member</h2>
          <form onSubmit={onInvite} style={{
            padding: 20, background: 'var(--bg-1)',
            border: '1px solid var(--border-0)', borderRadius: 12,
          }}>
            <label style={labelStyle}>Email</label>
            <input value={inviteEmail} onChange={e => setInviteEmail(e.target.value)}
              type="email" required style={inputStyle} />

            <label style={labelStyle}>Role</label>
            <select value={inviteRole}
              onChange={e => setInviteRole(e.target.value as BusinessStaffRole)}
              style={inputStyle}>
              {BUSINESS_STAFF_ROLES.map(r => (
                <option key={r} value={r}>{BUSINESS_STAFF_ROLE_LABEL[r]}</option>
              ))}
            </select>

            <div style={{ marginTop: 10, fontSize: 11, color: 'var(--text-3)' }}>
              They start with the default permissions for this role. You can edit later from the table.
            </div>

            <button type="submit" disabled={inviting}
              style={{ ...btnStyle, opacity: inviting ? 0.6 : 1 }}>
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

  // Group permissions by their UI group for display.
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
      setErr(e?.response?.data?.error || 'Save failed')
    } finally { setBusy(false) }
  }

  const resetToDefault = async () => {
    if (!window.confirm(`Reset ${staff.firstName}'s permissions to the ${BUSINESS_STAFF_ROLE_LABEL[staff.staffRole]} role defaults?`)) return
    setErr(null); setBusy(true)
    try {
      await apiPatch(`/business-users/${staff.id}`, { resetToRoleDefault: true })
      onSaved()
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Reset failed')
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
          <button onClick={resetToDefault} disabled={busy} style={ghostBtn}>
            <RotateCcw size={12} /> Reset to {BUSINESS_STAFF_ROLE_LABEL[staff.staffRole]} default
          </button>
          <div style={{ flex: 1 }} />
          <button onClick={onClose} style={ghostBtn}>Cancel</button>
          <button onClick={submit} disabled={busy} style={primaryBtnStyle}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </>
      }>
      {err && <div style={errStyle}>{err}</div>}

      <div style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 16 }}>
        Role: <strong style={{ color: 'var(--text-1)' }}>{BUSINESS_STAFF_ROLE_LABEL[staff.staffRole]}</strong>.
        Each permission shows whether it matches the role's default — green dot means default-on, gray dot means default-off.
      </div>

      <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 16 }}>
        {Object.entries(groups).map(([group, perms]) => (
          <div key={group} style={{
            padding: 12, background: 'var(--bg-2)', borderRadius: 8,
          }}>
            <div style={{
              fontSize: 11, color: 'var(--text-3)',
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
                    background: isOn ? 'rgba(212,175,55,.08)' : 'transparent',
                    borderRadius: 6, cursor: 'pointer',
                    fontSize: 13,
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
  fontFamily: 'var(--font-body)', fontSize: 18, color: 'var(--text-0)',
  marginTop: 0, marginBottom: 12,
}
const tableStyle: React.CSSProperties = {
  width: '100%', borderCollapse: 'collapse',
  background: 'var(--bg-1)', border: '1px solid var(--border-0)',
  borderRadius: 12, overflow: 'hidden',
}
const thStyle: React.CSSProperties = {
  textAlign: 'left' as const, padding: '12px 16px',
  fontSize: 12, color: 'var(--text-2)',
  textTransform: 'uppercase' as const, letterSpacing: 1, background: 'var(--bg-2)',
}
const tdStyle: React.CSSProperties = {
  padding: '14px 16px', fontSize: 14, color: 'var(--text-1)',
}
const labelStyle: React.CSSProperties = {
  display: 'block' as const, fontSize: 12, color: 'var(--text-2)',
  marginBottom: 6, marginTop: 12,
}
const inputStyle: React.CSSProperties = {
  width: '100%', padding: '10px 12px',
  background: 'var(--bg-2)', color: 'var(--text-0)',
  border: '1px solid var(--border-1)', borderRadius: 8,
  fontSize: 14, boxSizing: 'border-box' as const,
}
const btnStyle: React.CSSProperties = {
  width: '100%', padding: '12px',
  background: 'var(--gold)', color: 'var(--bg-0)',
  border: 'none', borderRadius: 8,
  fontSize: 14, fontWeight: 600, marginTop: 20, cursor: 'pointer',
}
const primaryBtnStyle: React.CSSProperties = {
  padding: '8px 14px', background: 'var(--gold)', color: 'var(--bg-0)',
  border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer',
  display: 'inline-flex' as const, alignItems: 'center', gap: 6,
}
const ghostBtn: React.CSSProperties = {
  padding: '8px 14px', background: 'transparent', color: 'var(--text-1)',
  border: '1px solid var(--border-1)', borderRadius: 8, fontSize: 13, fontWeight: 500, cursor: 'pointer',
  display: 'inline-flex' as const, alignItems: 'center', gap: 6,
}
const errStyle: React.CSSProperties = {
  marginBottom: 16, padding: '10px 12px',
  background: 'var(--red-bg)', color: 'var(--red)',
  border: '1px solid var(--red-dim)', borderRadius: 8, fontSize: 13,
}
const emptyStyle: React.CSSProperties = {
  padding: 32, textAlign: 'center' as const,
  background: 'var(--bg-1)', border: '1px solid var(--border-0)',
  borderRadius: 12, color: 'var(--text-2)', fontSize: 14,
}
