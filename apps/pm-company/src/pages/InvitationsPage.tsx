/**
 * PM-side property-link invitations.
 *
 * Mirror of the landlord PmInvitationsPage at apps/landlord/src/pages/PmInvitationsPage.tsx.
 *
 * Incoming  = owner_to_pm — owner invited this PM to manage a property; PM accepts/rejects.
 * Outgoing  = pm_to_owner — this PM invited an owner; PM can revoke.
 *
 * Conflict-on-accept: when accept returns 409 with "currently managed by
 * another PM," confirm and replay with replace=true.
 */

import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { useAuth } from '../context/AuthContext'
import { apiGet, apiPost, apiDelete } from '../lib/api'
import { Plus, X, Inbox, Send, Check, XCircle, RotateCcw } from 'lucide-react'

type Direction = 'owner_to_pm' | 'pm_to_owner'
type InviteStatus = 'pending' | 'accepted' | 'rejected' | 'expired' | 'revoked'

interface Invite {
  id: string
  direction: Direction
  propertyId: string
  landlordId: string
  invitedEmail: string
  proposedScope: 'manage' | 'view'
  proposedFeePlanId: string | null
  status: InviteStatus
  expiresAt: string
  acceptedAt: string | null
  rejectedAt: string | null
  rejectedReason: string | null
  revokedAt: string | null
  replacedPmCompanyId: string | null
  createdAt: string
  propertyName: string
  feePlanName: string | null
  feePlanType: string | null
}

interface FeePlan { id: string; name: string; feeType: string; status: string }

const STATUS_TINT: Record<InviteStatus, string> = {
  pending:  'rgba(201,162,39,.16)',
  accepted: 'rgba(38,167,90,.16)',
  rejected: 'rgba(220,76,76,.16)',
  expired:  'rgba(160,160,160,.16)',
  revoked:  'rgba(160,160,160,.16)',
}
const STATUS_TEXT: Record<InviteStatus, string> = {
  pending:  'var(--gold)',
  accepted: 'var(--green, #2ea35a)',
  rejected: 'var(--red, #dc4c4c)',
  expired:  'var(--text-3)',
  revoked:  'var(--text-3)',
}

const fmtDate = (s: string | null) => s ? new Date(s).toLocaleString() : '—'

function StatusBadge({ status }: { status: InviteStatus }) {
  return (
    <span style={{
      padding: '2px 8px', borderRadius: 12, fontSize: '.68rem',
      fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.04em',
      background: STATUS_TINT[status], color: STATUS_TEXT[status],
    }}>{status}</span>
  )
}

function SendInviteModal({ pmCompanyId, onClose }: { pmCompanyId: string; onClose: () => void }) {
  const qc = useQueryClient()
  const [propertyId, setPropertyId] = useState('')
  const [landlordId, setLandlordId] = useState('')
  const [invitedEmail, setInvitedEmail] = useState('')
  const [proposedScope, setProposedScope] = useState<'manage' | 'view'>('manage')
  const [feePlanId, setFeePlanId] = useState<string>('')

  const feePlansQ = useQuery<FeePlan[]>(
    ['fee-plans', pmCompanyId],
    () => apiGet<FeePlan[]>(`/pm/companies/${pmCompanyId}/fee-plans`),
  )

  const sendMut = useMutation(
    () => apiPost(`/pm/companies/${pmCompanyId}/property-invitations`, {
      propertyId: propertyId,
      landlordId: landlordId,
      invitedEmail: invitedEmail,
      proposedScope: proposedScope,
      proposedFeePlanId: feePlanId || null,
    }),
    { onSuccess: () => { qc.invalidateQueries(['pm-invitations', pmCompanyId]); onClose() } },
  )

  const canSend = !!propertyId && !!landlordId && !!invitedEmail
    && (proposedScope === 'view' || !!feePlanId)

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 540 }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <div className="modal-title" style={{ marginBottom: 0 }}>Invite Owner</div>
          <button className="btn btn-ghost btn-sm" onClick={onClose}><X size={15} /></button>
        </div>

        <div style={{ fontSize: '.78rem', color: 'var(--text-3)', marginBottom: 12, lineHeight: 1.5 }}>
          You&apos;ll send the owner a tokenized email link. They accept from
          their landlord portal — accepting links the property to your
          company and (for &quot;manage&quot; scope) routes rent through GAM at the
          fee plan you propose.
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={lbl}>Property ID</label>
          <input className="input" value={propertyId} onChange={e => setPropertyId(e.target.value.trim())}
                 placeholder="UUID provided by the owner" style={{ width: '100%' }} />
        </div>
        <div style={{ marginBottom: 12 }}>
          <label style={lbl}>Landlord ID</label>
          <input className="input" value={landlordId} onChange={e => setLandlordId(e.target.value.trim())}
                 placeholder="UUID of the property's landlord" style={{ width: '100%' }} />
        </div>
        <div style={{ marginBottom: 12 }}>
          <label style={lbl}>Owner Email</label>
          <input type="email" className="input" value={invitedEmail} onChange={e => setInvitedEmail(e.target.value.trim())}
                 placeholder="owner@example.com" style={{ width: '100%' }} />
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={lbl}>Scope</label>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" className="btn" onClick={() => setProposedScope('manage')}
                    style={{ flex: 1, border: `1px solid ${proposedScope === 'manage' ? 'var(--gold)' : 'var(--border-0)'}`, color: proposedScope === 'manage' ? 'var(--gold)' : 'var(--text-2)' }}>
              Full management
            </button>
            <button type="button" className="btn" onClick={() => setProposedScope('view')}
                    style={{ flex: 1, border: `1px solid ${proposedScope === 'view' ? 'var(--gold)' : 'var(--border-0)'}`, color: proposedScope === 'view' ? 'var(--gold)' : 'var(--text-2)' }}>
              View only
            </button>
          </div>
          <div style={{ fontSize: '.68rem', color: 'var(--text-3)', marginTop: 4 }}>
            {proposedScope === 'manage'
              ? 'Routes rent through GAM with the fee plan you select.'
              : 'Owner sees the property in GAM but money flow stays off-platform.'}
          </div>
        </div>

        {proposedScope === 'manage' && (
          <div style={{ marginBottom: 12 }}>
            <label style={lbl}>Fee Plan</label>
            <select className="input" value={feePlanId} onChange={e => setFeePlanId(e.target.value)} style={{ width: '100%' }}>
              <option value="">— select —</option>
              {feePlansQ.data?.filter(p => p.status === 'active').map(p => (
                <option key={p.id} value={p.id}>{p.name} ({p.feeType})</option>
              ))}
            </select>
          </div>
        )}

        {sendMut.isError && (
          <div style={{ padding: 8, background: 'rgba(220,76,76,.1)', borderRadius: 6, fontSize: '.74rem', color: 'var(--red, #dc4c4c)', marginBottom: 12 }}>
            {(sendMut.error as any)?.response?.data?.error?.message || 'Send failed.'}
          </div>
        )}

        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={!canSend || sendMut.isLoading} onClick={() => sendMut.mutate()}>
            {sendMut.isLoading ? 'Sending…' : 'Send Invitation'}
          </button>
        </div>
      </div>
    </div>
  )
}

export function InvitationsPage() {
  const { activePmCompany } = useAuth()
  const cid = activePmCompany?.id
  const qc = useQueryClient()
  const [showSend, setShowSend] = useState(false)

  const invitesQ = useQuery<Invite[]>(
    ['pm-invitations', cid],
    () => apiGet<Invite[]>(`/pm/companies/${cid}/property-invitations`),
    { enabled: !!cid },
  )

  // S161: company readiness state — accept-button gating depends on it.
  const companyQ = useQuery<{ connectPayoutsEnabled: boolean; connectDetailsSubmitted: boolean }>(
    ['pm-company', cid],
    () => apiGet<{ connectPayoutsEnabled: boolean; connectDetailsSubmitted: boolean }>(`/pm/companies/${cid}`),
    { enabled: !!cid },
  )
  const bankingReady = !!companyQ.data?.connectPayoutsEnabled && !!companyQ.data?.connectDetailsSubmitted

  const acceptMut = useMutation(
    async (vars: { id: string; replace: boolean }) =>
      apiPost(`/pm/companies/${cid}/property-invitations/${vars.id}/accept`, { replace: vars.replace }),
    { onSuccess: () => qc.invalidateQueries(['pm-invitations', cid]) },
  )
  const rejectMut = useMutation(
    async (vars: { id: string; reason: string | null }) =>
      apiPost(`/pm/companies/${cid}/property-invitations/${vars.id}/reject`, { reason: vars.reason }),
    { onSuccess: () => qc.invalidateQueries(['pm-invitations', cid]) },
  )
  const revokeMut = useMutation(
    async (id: string) => apiDelete(`/pm/companies/${cid}/property-invitations/${id}`),
    { onSuccess: () => qc.invalidateQueries(['pm-invitations', cid]) },
  )

  const handleAccept = async (id: string) => {
    try { await acceptMut.mutateAsync({ id, replace: false }) }
    catch (e: any) {
      const status = e?.response?.status
      const msg: string = e?.response?.data?.error?.message ?? ''
      if (status === 409 && msg.toLowerCase().includes('currently managed')) {
        if (window.confirm(
          'This property is currently managed by another PM company. ' +
          'Accepting will replace that linkage. Continue?',
        )) {
          await acceptMut.mutateAsync({ id, replace: true })
        }
      } else if (status === 409 && msg.toLowerCase().includes('banking onboarding incomplete')) {
        if (window.confirm(
          msg + '\n\nOpen the Banking page now?',
        )) {
          window.location.href = '/banking'
        }
      } else {
        alert(msg || 'Accept failed.')
      }
    }
  }

  const handleReject = async (id: string) => {
    const reason = window.prompt('Optional reason (or leave blank):')
    await rejectMut.mutateAsync({ id, reason: reason || null })
  }

  const incoming = (invitesQ.data ?? []).filter(i => i.direction === 'owner_to_pm')
  const outgoing = (invitesQ.data ?? []).filter(i => i.direction === 'pm_to_owner')

  return (
    <div style={{ padding: 24 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: '1.4rem', color: 'var(--text-0)' }}>Property Invitations</h1>
          <div style={{ fontSize: '.78rem', color: 'var(--text-3)', marginTop: 4 }}>
            Mutual handshake before a property links to your company.
          </div>
        </div>
        <button className="btn btn-primary" onClick={() => setShowSend(true)}>
          <Plus size={14} style={{ marginRight: 6 }} /> Invite Owner
        </button>
      </div>

      {invitesQ.isLoading && <div style={{ color: 'var(--text-3)' }}>Loading…</div>}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <div className="card" style={{ padding: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
            <Inbox size={16} color="var(--gold)" />
            <div style={{ fontWeight: 600, color: 'var(--text-0)' }}>Incoming from owners ({incoming.length})</div>
          </div>
          {incoming.length === 0 && <div style={{ color: 'var(--text-3)', fontSize: '.82rem' }}>No invitations.</div>}
          {incoming.map(inv => (
            <div key={inv.id} style={{ borderTop: '1px solid var(--border-0)', paddingTop: 12, marginTop: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                <div>
                  <div style={{ fontWeight: 600, color: 'var(--text-0)' }}>{inv.propertyName}</div>
                  <div style={{ fontSize: '.78rem', color: 'var(--text-2)' }}>
                    Owner wants you to <strong>{inv.proposedScope}</strong>
                  </div>
                  {inv.feePlanName && (
                    <div style={{ fontSize: '.72rem', color: 'var(--text-3)', marginTop: 2 }}>
                      Proposed fee plan: {inv.feePlanName} ({inv.feePlanType})
                    </div>
                  )}
                  <div style={{ fontSize: '.72rem', color: 'var(--text-3)', marginTop: 2 }}>
                    Sent {fmtDate(inv.createdAt)} · Expires {fmtDate(inv.expiresAt)}
                  </div>
                </div>
                <StatusBadge status={inv.status} />
              </div>
              {inv.status === 'pending' && (() => {
                // S161: gate on banking readiness for owner_to_pm + manage scope.
                // The backend will refuse the accept anyway (S159 guard), but
                // disabling the button here saves a round-trip and makes the
                // expected action obvious.
                const bankingGate = inv.proposedScope === 'manage' && !bankingReady
                return (
                  <div style={{ display: 'flex', gap: 6, marginTop: 10, alignItems: 'center' }}>
                    <button className="btn btn-primary btn-sm"
                            disabled={acceptMut.isLoading || bankingGate}
                            title={bankingGate ? 'Complete Stripe Connect onboarding before accepting management invitations' : ''}
                            onClick={() => handleAccept(inv.id)}>
                      <Check size={12} style={{ marginRight: 4 }} /> Accept
                    </button>
                    <button className="btn btn-ghost btn-sm"
                            disabled={rejectMut.isLoading}
                            onClick={() => handleReject(inv.id)}>
                      <XCircle size={12} style={{ marginRight: 4 }} /> Reject
                    </button>
                    {bankingGate && (
                      <a href="/banking" style={{ fontSize: '.7rem', color: 'var(--gold)', marginLeft: 4 }}>
                        Complete banking →
                      </a>
                    )}
                  </div>
                )
              })()}
              {inv.status === 'rejected' && inv.rejectedReason && (
                <div style={{ fontSize: '.72rem', color: 'var(--text-3)', marginTop: 6, fontStyle: 'italic' }}>
                  Reason: {inv.rejectedReason}
                </div>
              )}
            </div>
          ))}
        </div>

        <div className="card" style={{ padding: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
            <Send size={16} color="var(--gold)" />
            <div style={{ fontWeight: 600, color: 'var(--text-0)' }}>Outgoing to owners ({outgoing.length})</div>
          </div>
          {outgoing.length === 0 && <div style={{ color: 'var(--text-3)', fontSize: '.82rem' }}>No invitations.</div>}
          {outgoing.map(inv => (
            <div key={inv.id} style={{ borderTop: '1px solid var(--border-0)', paddingTop: 12, marginTop: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                <div>
                  <div style={{ fontWeight: 600, color: 'var(--text-0)' }}>{inv.propertyName}</div>
                  <div style={{ fontSize: '.78rem', color: 'var(--text-2)' }}>
                    Invited to <strong>{inv.proposedScope}</strong> · {inv.invitedEmail}
                  </div>
                  <div style={{ fontSize: '.72rem', color: 'var(--text-3)', marginTop: 2 }}>
                    Expires {fmtDate(inv.expiresAt)}
                  </div>
                </div>
                <StatusBadge status={inv.status} />
              </div>
              {inv.status === 'pending' && (
                <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
                  <button className="btn btn-ghost btn-sm"
                          disabled={revokeMut.isLoading}
                          onClick={() => {
                            if (window.confirm('Revoke this invitation?')) revokeMut.mutate(inv.id)
                          }}>
                    <RotateCcw size={12} style={{ marginRight: 4 }} /> Revoke
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {showSend && cid && <SendInviteModal pmCompanyId={cid} onClose={() => setShowSend(false)} />}
    </div>
  )
}

const lbl: React.CSSProperties = {
  fontSize: '.72rem', fontWeight: 600, color: 'var(--text-3)',
  textTransform: 'uppercase', letterSpacing: '.06em',
  display: 'block', marginBottom: 5,
}
