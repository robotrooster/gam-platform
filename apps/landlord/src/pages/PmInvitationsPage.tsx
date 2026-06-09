// S157+ — landlord-side view of PM-property-invitation handshake.
//
// Two directions:
//   - owner_to_pm  : landlord (owner) invites a PM company to manage a
//     property. Landlord sends + can revoke; PM staff accepts/rejects
//     from the pm-company portal.
//   - pm_to_owner  : PM company invites landlord to let them manage.
//     Landlord accepts/rejects here.
//
// Single endpoint family at /api/landlords/me/pm-property-invitations.
//
// NOTE: this file was reconstructed in S329 after a sed regression
// 0-byte'd the original. Wire format is camelCase per the post-S321
// PM migration; backend response keys come through the S312 camelize
// interceptor.

import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { apiGet, apiPost } from '../lib/api'

type InviteStatus = 'pending' | 'accepted' | 'rejected' | 'expired' | 'revoked'
type InviteDirection = 'owner_to_pm' | 'pm_to_owner'

interface Invite {
  id:                    string
  direction:             InviteDirection
  pmCompanyId:           string
  propertyId:            string
  invitedEmail:          string
  proposedScope:         'manage' | 'view'
  proposedFeePlanId:     string | null
  status:                InviteStatus
  expiresAt:             string
  acceptedAt:            string | null
  rejectedAt:            string | null
  rejectedReason:        string | null
  revokedAt:             string | null
  replacedPmCompanyId:   string | null
  createdAt:             string
  pmCompanyName:         string
  propertyName:          string
  feePlanName:           string | null
  feePlanType:           string | null
}

interface Property { id: string; name: string }
interface FeePlan  { id: string; name: string; feeType: string; status: string }

const STATUS_TINT: Record<InviteStatus, string> = {
  pending:  'rgba(201,162,39,.16)',
  accepted: 'rgba(38,167,90,.16)',
  rejected: 'rgba(220,76,76,.16)',
  expired:  'rgba(160,160,160,.16)',
  revoked:  'rgba(160,160,160,.16)',
}
const STATUS_LABEL: Record<InviteStatus, string> = {
  pending:  'Pending',
  accepted: 'Accepted',
  rejected: 'Rejected',
  expired:  'Expired',
  revoked:  'Revoked',
}

const fmtDate = (s: string | null) => s ? new Date(s).toLocaleDateString() : '—'

export function PmInvitationsPage() {
  const qc = useQueryClient()
  const [sending, setSending] = useState(false)
  const [msg, setMsg] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null)

  const invQ = useQuery<Invite[]>(
    'pm-property-invitations',
    () => apiGet<Invite[]>('/landlords/me/pm-property-invitations'),
  )
  const propQ = useQuery<Property[]>(
    'landlord-properties',
    () => apiGet<Property[]>('/properties'),
  )

  const acceptMut = useMutation(
    ({ id, replace }: { id: string; replace: boolean }) =>
      apiPost(`/landlords/me/pm-property-invitations/${id}/accept`, { replace }),
    {
      onSuccess: () => { qc.invalidateQueries('pm-property-invitations'); setMsg({ tone: 'ok', text: 'Invitation accepted.' }) },
      onError:   (e: any) => setMsg({ tone: 'err', text: e?.response?.data?.error || 'Accept failed' }),
    },
  )
  const rejectMut = useMutation(
    ({ id, reason }: { id: string; reason: string }) =>
      apiPost(`/landlords/me/pm-property-invitations/${id}/reject`, { reason }),
    {
      onSuccess: () => { qc.invalidateQueries('pm-property-invitations'); setMsg({ tone: 'ok', text: 'Invitation rejected.' }) },
      onError:   (e: any) => setMsg({ tone: 'err', text: e?.response?.data?.error || 'Reject failed' }),
    },
  )

  const invites = invQ.data ?? []
  const incomingPending = invites.filter(i => i.direction === 'pm_to_owner' && i.status === 'pending')
  const outgoingPending = invites.filter(i => i.direction === 'owner_to_pm' && i.status === 'pending')
  const resolved        = invites.filter(i => i.status !== 'pending')

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">PM company invitations</h1>
          <p className="page-subtitle">Owner ↔ PM-company property-management handshake</p>
        </div>
        <button className="btn btn-primary" onClick={() => setSending(true)}>+ Send invitation</button>
      </div>

      {msg && (
        <div className="alert" style={{
          marginBottom: 14, padding: '10px 14px', borderRadius: 7, fontSize: '.82rem',
          background: msg.tone === 'ok' ? 'rgba(34,197,94,.08)' : 'rgba(239,68,68,.08)',
          color:      msg.tone === 'ok' ? 'var(--green)' : 'var(--red)',
          border: `1px solid ${msg.tone === 'ok' ? 'rgba(34,197,94,.3)' : 'rgba(239,68,68,.3)'}`,
        }}>{msg.text}</div>
      )}

      <Section title={`Incoming — PM invited you (${incomingPending.length})`}>
        {incomingPending.length === 0 ? (
          <div className="empty-state" style={{ padding: 24, fontSize: '.85rem', color: 'var(--text-3)' }}>
            No pending invitations from PM companies.
          </div>
        ) : incomingPending.map(inv => (
          <div key={inv.id} className="card" style={{ marginBottom: 10, padding: 14, background: STATUS_TINT[inv.status] }}>
            <div style={{ fontWeight: 600, marginBottom: 6 }}>
              {inv.pmCompanyName} wants to <strong>{inv.proposedScope}</strong> {inv.propertyName}
            </div>
            <div style={{ fontSize: '.78rem', color: 'var(--text-3)', marginBottom: 8 }}>
              {inv.feePlanName ? <>Fee plan: <strong>{inv.feePlanName}</strong> ({inv.feePlanType})</> : 'View-only — no fee plan'}
              {' · '}Sent {fmtDate(inv.createdAt)} · Expires {fmtDate(inv.expiresAt)}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                className="btn btn-primary btn-sm"
                disabled={acceptMut.isLoading}
                onClick={() => acceptMut.mutate({ id: inv.id, replace: !!inv.replacedPmCompanyId })}>
                {acceptMut.isLoading ? 'Accepting…' : 'Accept'}
              </button>
              <button
                className="btn btn-danger btn-sm"
                disabled={rejectMut.isLoading}
                onClick={() => {
                  const reason = prompt('Reject this invitation? (Optional reason)') ?? ''
                  rejectMut.mutate({ id: inv.id, reason })
                }}>
                Reject
              </button>
            </div>
          </div>
        ))}
      </Section>

      <Section title={`Outgoing — you invited a PM (${outgoingPending.length})`}>
        {outgoingPending.length === 0 ? (
          <div className="empty-state" style={{ padding: 24, fontSize: '.85rem', color: 'var(--text-3)' }}>
            No outgoing invitations awaiting response.
          </div>
        ) : outgoingPending.map(inv => (
          <div key={inv.id} className="card" style={{ marginBottom: 10, padding: 14, background: STATUS_TINT[inv.status] }}>
            <div style={{ fontWeight: 600, marginBottom: 6 }}>
              {inv.invitedEmail} → {inv.pmCompanyName} to <strong>{inv.proposedScope}</strong> {inv.propertyName}
            </div>
            <div style={{ fontSize: '.78rem', color: 'var(--text-3)' }}>
              {inv.feePlanName ? <>Fee plan: <strong>{inv.feePlanName}</strong> ({inv.feePlanType})</> : 'View-only — no fee plan'}
              {' · '}Sent {fmtDate(inv.createdAt)} · Expires {fmtDate(inv.expiresAt)}
            </div>
          </div>
        ))}
      </Section>

      <Section title={`History (${resolved.length})`}>
        {resolved.length === 0 ? (
          <div className="empty-state" style={{ padding: 24, fontSize: '.85rem', color: 'var(--text-3)' }}>
            No resolved invitations yet.
          </div>
        ) : (
          <table className="data-table" style={{ width: '100%' }}>
            <thead><tr>
              <th>When</th><th>Direction</th><th>PM Company</th><th>Property</th><th>Scope</th><th>Status</th><th>Notes</th>
            </tr></thead>
            <tbody>
              {resolved.map(inv => (
                <tr key={inv.id}>
                  <td>{fmtDate(inv.createdAt)}</td>
                  <td style={{ fontSize: '.78rem' }}>{inv.direction === 'owner_to_pm' ? 'You → PM' : 'PM → You'}</td>
                  <td>{inv.pmCompanyName}</td>
                  <td>{inv.propertyName}</td>
                  <td>{inv.proposedScope}</td>
                  <td><span className="badge" style={{ background: STATUS_TINT[inv.status] }}>{STATUS_LABEL[inv.status]}</span></td>
                  <td style={{ fontSize: '.75rem', color: 'var(--text-3)' }}>{inv.rejectedReason ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      {sending && (
        <SendInviteModal
          properties={propQ.data ?? []}
          onClose={() => setSending(false)}
          onSent={() => { qc.invalidateQueries('pm-property-invitations'); setSending(false); setMsg({ tone: 'ok', text: 'Invitation sent.' }) }}
        />
      )}
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 22 }}>
      <h3 style={{ fontSize: '.95rem', fontWeight: 700, marginBottom: 10, color: 'var(--text-1)' }}>{title}</h3>
      {children}
    </div>
  )
}

function SendInviteModal({
  properties, onClose, onSent,
}: { properties: Property[]; onClose: () => void; onSent: () => void }) {
  const [pmCompanyId, setPmCompanyId] = useState('')
  const [propertyId, setPropertyId] = useState('')
  const [invitedEmail, setInvitedEmail] = useState('')
  const [proposedScope, setProposedScope] = useState<'manage' | 'view'>('manage')
  const [feePlanId, setFeePlanId] = useState('')
  const [error, setError] = useState<string | null>(null)

  // Fee plans for the typed-in pm company. Requires pm-staff role on
  // the backend; landlord can't query it cross-tenant. Manual feePlanId
  // entry is the practical path until a landlord-side enumeration
  // route lands.
  const feePlansQ = useQuery<FeePlan[]>(
    ['pm-fee-plans', pmCompanyId],
    () => apiGet<FeePlan[]>(`/pm/companies/${pmCompanyId}/fee-plans`),
    { enabled: !!pmCompanyId && proposedScope === 'manage', retry: false },
  )

  const sendMut = useMutation(
    () => apiPost('/landlords/me/pm-property-invitations', {
      pmCompanyId,
      propertyId,
      invitedEmail,
      proposedScope,
      proposedFeePlanId: feePlanId || null,
    }),
    {
      onSuccess: () => onSent(),
      onError:   (e: any) => setError(e?.response?.data?.error || 'Send failed'),
    },
  )

  const canSend = !!pmCompanyId && !!propertyId && !!invitedEmail
    && (proposedScope === 'view' || !!feePlanId)

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 540 }} onClick={e => e.stopPropagation()}>
        <div className="modal-title">Send PM-company invitation</div>
        <p style={{ fontSize: '.82rem', color: 'var(--text-3)', marginBottom: 16 }}>
          Invite a PM company you've already onboarded with to manage one of your properties. Get the PM company ID + (for manage scope) fee plan ID from them directly.
        </p>

        {error && <div className="alert alert-danger" style={{ marginBottom: 12 }}>{error}</div>}

        <Field label="PM company ID (UUID)">
          <input className="input" value={pmCompanyId} onChange={e => setPmCompanyId(e.target.value)} placeholder="00000000-0000-0000-0000-…" style={{ width: '100%' }} />
        </Field>

        <Field label="Property">
          <select className="input" value={propertyId} onChange={e => setPropertyId(e.target.value)} style={{ width: '100%' }}>
            <option value="">— pick a property —</option>
            {properties.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </Field>

        <Field label="Invitee email">
          <input className="input" type="email" value={invitedEmail} onChange={e => setInvitedEmail(e.target.value)} placeholder="owner@example.com" style={{ width: '100%' }} />
        </Field>

        <Field label="Scope">
          <select className="input" value={proposedScope} onChange={e => setProposedScope(e.target.value as 'manage' | 'view')} style={{ width: '100%' }}>
            <option value="manage">Manage — PM takes operational control + fee cut</option>
            <option value="view">View — PM gets read-only access</option>
          </select>
        </Field>

        {proposedScope === 'manage' && (
          <Field label="Fee plan">
            {feePlansQ.data && feePlansQ.data.length > 0 ? (
              <select className="input" value={feePlanId} onChange={e => setFeePlanId(e.target.value)} style={{ width: '100%' }}>
                <option value="">— pick a fee plan —</option>
                {feePlansQ.data.map(p => (
                  <option key={p.id} value={p.id}>{p.name} ({p.feeType})</option>
                ))}
              </select>
            ) : (
              <input className="input" value={feePlanId} onChange={e => setFeePlanId(e.target.value)} placeholder="fee-plan UUID from the PM" style={{ width: '100%' }} />
            )}
          </Field>
        )}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={!canSend || sendMut.isLoading} onClick={() => sendMut.mutate()}>
            {sendMut.isLoading ? 'Sending…' : 'Send'}
          </button>
        </div>
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <label style={{ display: 'block', fontSize: '.72rem', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 5 }}>
        {label}
      </label>
      {children}
    </div>
  )
}
