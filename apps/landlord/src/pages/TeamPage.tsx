import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { apiGet, apiPatch, apiPost } from '../lib/api'
import {
  LANDLORD_ASSIGNABLE_ROLE_LABEL,
  LandlordAssignableRole,
  BOOKKEEPER_ACCESS_LEVELS,
  PERMISSION_PRESETS,
} from '@gam/shared'

// S526: the old expandable-row permission grid (SUB_PERMISSIONS_BY_ROLE
// checkboxes + inline ScopePicker) is RETIRED — the dedicated per-user page at
// /team/:userId/permissions is the one permissions surface (catalog toggles +
// property scope + direct deposit all live there). This page is now just the
// roster: invite form, member list, pending invitations. Bookkeepers keep
// their inline access-level select (they have no catalog permissions).

interface Member {
  userId: string
  role: LandlordAssignableRole
  email: string
  firstName: string
  lastName: string
  phone: string | null
  permissions: Record<string, any>
  scope: any
  createdAt: string
  updatedAt: string
  // S168: property_manager-only — direct-deposit opt-in toggle and the
  // cached Stripe Connect readiness flags from the manager's user row.
  directDepositEnabled?: boolean
  connectChargesEnabled?: boolean
  connectPayoutsEnabled?: boolean
  connectDetailsSubmitted?: boolean
}

interface Invitation {
  id: string
  email: string
  role: LandlordAssignableRole
  status: string
  expiresAt: string
  createdAt: string
}

interface TeamPayload {
  members: Member[]
  invitations: Invitation[]
}

const ROLE_BADGE: Record<LandlordAssignableRole, string> = {
  property_manager: 'badge-blue',
  onsite_manager:   'badge-amber',
  maintenance:      'badge-muted',
  bookkeeper:       'badge-green',
}

export function TeamPage() {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const { data, isLoading } = useQuery<TeamPayload>('team', () => apiGet('/scopes/team'))

  const updateBookkeeperLevel = useMutation(
    (args: { userId: string; accessLevel: string }) =>
      apiPatch(`/scopes/bookkeeper/${args.userId}`, { accessLevel: args.accessLevel }),
    { onSuccess: () => qc.invalidateQueries('team') }
  )

  const members = data?.members || []
  const invitations = data?.invitations || []

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">Team</h1>
          <p className="page-subtitle">Staff and per-feature permissions</p>
        </div>
      </div>

      {/* S229: invite form. Posts to /scopes/:role/invite (canonical
          token-based flow, S80) — sends an email link to the invitee. The
          invite grants nothing; everything is set on the member's
          permissions page after they accept. */}
      <InviteForm onSent={() => qc.invalidateQueries('team')} />

      {isLoading ? (
        <div className="card" style={{ padding: 32, color: 'var(--text-3)', textAlign: 'center' }}>Loading…</div>
      ) : (
        <>
          <div className="card" style={{ padding: 0, marginBottom: 20, overflowX: 'auto' }}>
            <table className="data-table" style={{ minWidth: 760 }}>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Email</th>
                  <th>Role</th>
                  <th>Permissions</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {members.length === 0 ? (
                  <tr><td colSpan={5} style={{ textAlign: 'center', color: 'var(--text-3)', padding: 32 }}>No team members yet.</td></tr>
                ) : members.map(m => {
                  const isBookkeeper = m.role === 'bookkeeper'
                  const perms = (m.permissions || {}) as Record<string, boolean>
                  const enabledCount = isBookkeeper ? 0 : Object.values(perms).filter(Boolean).length
                  return (
                    <tr
                      key={m.userId}
                      style={{ cursor: isBookkeeper ? 'default' : 'pointer' }}
                      onClick={() => { if (!isBookkeeper) navigate(`/team/${m.userId}/permissions`) }}
                    >
                      <td style={{ fontWeight: 500 }}>{m.firstName} {m.lastName}</td>
                      <td style={{ fontSize: '.82rem', color: 'var(--text-3)' }}>{m.email}</td>
                      <td><span className={`badge ${ROLE_BADGE[m.role]}`}>{LANDLORD_ASSIGNABLE_ROLE_LABEL[m.role]}</span></td>
                      <td style={{ fontSize: '.82rem', color: 'var(--text-3)' }}>
                        {isBookkeeper ? (
                          <select
                            value={(m.permissions as any)?.accessLevel || 'read_only'}
                            onClick={e => e.stopPropagation()}
                            onChange={e => updateBookkeeperLevel.mutate({ userId: m.userId, accessLevel: e.target.value })}
                            disabled={updateBookkeeperLevel.isLoading}
                            style={{ background: 'var(--bg-2)', border: '1px solid var(--border-1)', borderRadius: 6, color: 'var(--text-0)', padding: '4px 8px', fontSize: '.78rem' }}>
                            {BOOKKEEPER_ACCESS_LEVELS.map(lv => <option key={lv} value={lv}>{lv}</option>)}
                          </select>
                        ) : `${enabledCount} permission${enabledCount === 1 ? '' : 's'} granted`}
                      </td>
                      <td style={{ textAlign: 'right', color: 'var(--text-3)', fontSize: '.82rem', whiteSpace: 'nowrap' }}>
                        {!isBookkeeper && (
                          <button
                            className="btn btn-ghost btn-sm"
                            style={{ fontSize: '.74rem' }}
                            onClick={(e) => { e.stopPropagation(); navigate(`/team/${m.userId}/permissions`) }}
                          >
                            Permissions →
                          </button>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          {/* Direct-deposit summary KPI: visible count of managers opted in
              but not yet ready in Stripe. Helps the landlord notice
              managers who haven't finished onboarding. */}
          {(() => {
            const pending = members.filter(m =>
              m.role === 'property_manager' &&
              m.directDepositEnabled &&
              !(m.connectPayoutsEnabled && m.connectDetailsSubmitted))
            if (pending.length === 0) return null
            return (
              <div className="card" style={{ padding: 12, marginBottom: 16, fontSize: '.82rem', color: 'var(--text-2)' }}>
                <strong style={{ color: 'var(--gold)' }}>{pending.length}</strong>{' '}
                manager{pending.length === 1 ? '' : 's'} have direct deposit enabled but
                {' '}haven't linked their bank account yet. Their fees will
                accumulate as unpaid until they finish setup.
              </div>
            )
          })()}

          {invitations.length > 0 && (
            <div className="card" style={{ padding: 0 }}>
              <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--border-1)', fontWeight: 600, fontSize: '.88rem' }}>Pending invitations</div>
              <table className="data-table">
                <thead>
                  <tr><th>Email</th><th>Role</th><th>Sent</th><th>Expires</th></tr>
                </thead>
                <tbody>
                  {invitations.map(inv => (
                    <tr key={inv.id}>
                      <td style={{ fontSize: '.82rem' }}>{inv.email}</td>
                      <td><span className={`badge ${ROLE_BADGE[inv.role] || 'badge-muted'}`}>{LANDLORD_ASSIGNABLE_ROLE_LABEL[inv.role]}</span></td>
                      <td style={{ fontSize: '.78rem', color: 'var(--text-3)' }}>{new Date(inv.createdAt).toLocaleDateString()}</td>
                      <td style={{ fontSize: '.78rem', color: 'var(--text-3)' }}>{new Date(inv.expiresAt).toLocaleDateString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  )
}

// S229: TeamPage invite form. Wraps POST /api/scopes/:roleType/invite —
// the canonical token-based flow that emails the invitee a link.
function InviteForm({ onSent }: { onSent: () => void }) {
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  // W-10 (S529): the property binding is chosen HERE and permanent from then
  // on (re-invite is the move path). W-52: a preset can ride the invite so
  // the person lands with the right access the moment they accept.
  const [propertyId, setPropertyId] = useState('')
  const [presetId, setPresetId] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const { data: properties = [] } = useQuery<any[]>('properties-for-invite', () => apiGet('/properties'))

  const reset = () => {
    setFirstName('')
    setLastName('')
    setEmail('')
    setPhone('')
    setPropertyId('')
    setPresetId('')
  }

  const mut = useMutation(
    // No role dropdown: every staff user is created generic and fully defined
    // by their permission toggles. onsite_manager is the internal backing type
    // (has a property-scoped table + is wired through auth/POS) — invisible to
    // the landlord. Property access + permissions are set on the user's
    // dedicated permissions page after they accept; the invite grants nothing.
    () => apiPost(`/scopes/onsite_manager/invite`, {
      email: email.trim(),
      firstName: firstName.trim() || undefined,
      lastName: lastName.trim() || undefined,
      phone: phone.trim() || undefined,
      scope: {
        propertyIds: [propertyId], unitIds: [], allProperties: false,
        permissions: Object.fromEntries(
          (PERMISSION_PRESETS.find(p => p.id === presetId)?.keys || []).map(k => [k, true])),
      },
    }),
    {
      onSuccess: () => {
        setError(null)
        setSuccess(`Invitation emailed to ${email.trim()}. Set their permissions once they accept.`)
        reset()
        onSent()
        setTimeout(() => setSuccess(null), 5000)
      },
      onError: (e: any) => {
        setSuccess(null)
        setError(e?.response?.data?.message || e?.response?.data?.error || e?.message || 'Could not send invitation')
      },
    },
  )

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    if (!firstName.trim() || !lastName.trim()) {
      setError('First and last name are required')
      return
    }
    if (!email.trim()) {
      setError('Email is required')
      return
    }
    if (!propertyId) {
      setError('Pick the property this person belongs to — it is permanent once they are added')
      return
    }
    mut.mutate()
  }

  const labelStyle = { fontSize: '.72rem', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase' as const, letterSpacing: '.05em', display: 'block', marginBottom: 4 }
  const inputStyle = { width: '100%', padding: '8px 12px', borderRadius: 8, border: '1px solid var(--border-0)', background: 'var(--bg-2)', fontSize: '.85rem', boxSizing: 'border-box' as const }

  return (
    <div className="card" style={{ padding: 16, marginBottom: 20 }}>
      <div style={{ fontSize: '.95rem', fontWeight: 600, marginBottom: 4 }}>Add a staff member</div>
      <div style={{ fontSize: '.75rem', color: 'var(--text-3)', marginBottom: 12, lineHeight: 1.5 }}>
        Enter their details, pick their property, and optionally start them from a permission preset — they land with that access the moment they accept. The property is <strong>permanent</strong> (to move someone later, remove and re-invite them); permissions can be adjusted anytime on their permissions page.
      </div>
      <form onSubmit={submit} style={{ display: 'grid', gap: 10 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <div>
            <label style={labelStyle}>First name</label>
            <input
              type="text"
              required
              value={firstName}
              onChange={e => setFirstName(e.target.value)}
              placeholder="Jane"
              style={inputStyle}
            />
          </div>
          <div>
            <label style={labelStyle}>Last name</label>
            <input
              type="text"
              required
              value={lastName}
              onChange={e => setLastName(e.target.value)}
              placeholder="Doe"
              style={inputStyle}
            />
          </div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 10 }}>
          <div>
            <label style={labelStyle}>Email</label>
            <input
              type="email"
              required
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="name@example.com"
              style={inputStyle}
            />
          </div>
          <div>
            <label style={labelStyle}>Phone <span style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>(optional)</span></label>
            <input
              type="tel"
              value={phone}
              onChange={e => setPhone(e.target.value)}
              placeholder="(555) 123-4567"
              style={inputStyle}
            />
          </div>
        </div>

        <div>
          <label style={labelStyle}>Property <span style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>(permanent — re-invite to move someone later)</span></label>
          <select value={propertyId} onChange={e => setPropertyId(e.target.value)} style={inputStyle} required>
            <option value="">Pick their property…</option>
            {(properties as any[]).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>

        <div>
          <label style={labelStyle}>Starting Permissions <span style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>(optional — applied when they accept)</span></label>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <button type="button" onClick={() => setPresetId('')}
              className={`btn btn-sm ${presetId === '' ? 'btn-primary' : 'btn-ghost'}`}>
              None — Configure Later
            </button>
            {PERMISSION_PRESETS.map(p => (
              <button key={p.id} type="button" title={p.description} onClick={() => setPresetId(p.id)}
                className={`btn btn-sm ${presetId === p.id ? 'btn-primary' : 'btn-ghost'}`}>
                {p.label}
              </button>
            ))}
          </div>
          {presetId && (
            <div style={{ fontSize: '.7rem', color: 'var(--text-3)', marginTop: 4 }}>
              {PERMISSION_PRESETS.find(p => p.id === presetId)?.description}
            </div>
          )}
        </div>

        {error && (
          <div style={{ padding: '8px 12px', borderRadius: 6, background: 'rgba(220,76,76,.08)', border: '1px solid rgba(220,76,76,.25)', color: 'var(--red, #dc4c4c)', fontSize: '.78rem' }}>
            {error}
          </div>
        )}
        {success && (
          <div style={{ padding: '8px 12px', borderRadius: 6, background: 'rgba(46,163,90,.08)', border: '1px solid rgba(46,163,90,.25)', color: 'var(--green, #2ea35a)', fontSize: '.78rem' }}>
            {success}
          </div>
        )}

        <div>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={mut.isLoading || !email.trim()}
          >
            {mut.isLoading ? 'Sending…' : 'Send invitation'}
          </button>
        </div>
      </form>
    </div>
  )
}
