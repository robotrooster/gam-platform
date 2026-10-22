import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from 'react-query'
import { CheckCircle2, Mail, Send, ShieldCheck } from 'lucide-react'

/** The calling app's own fetchers, injected the way PropertyListPanel's are. */
export interface ScreeningsWaitingApi {
  get: (url: string) => Promise<any>
  post: (url: string, body?: any) => Promise<any>
}

export interface WaitingScreening {
  id: string
  amount: number
  source: string
  created_at: string
  email: string | null
  sends_to: string | null
  booking_id: string | null
  property_name: string | null
  guest_name: string | null
  check_in: string | null
  check_out: string | null
  unit_number: string | null
}

/**
 * 10/21 (Nic) — BACKGROUND CHECKS THAT ARE PAID FOR AND WAITING ON SOMEBODY.
 *
 *   "if it goes to a typoed folder or bounces, how would the tenant sign in to
 *    complete the check if they can't sign in with a typoed email? Because they
 *    would need the two-factor authentication anyway, right? And then nothing
 *    shows the desk it's waiting. Yeah, we need a way to resend it."
 *
 * A guest pays for their check with a stay at the counter and GAM emails them a
 * link. That was the whole of it: one email, once, and if the address was
 * mistyped the money was simply stuck. They could not sign in to fix it either
 * — every account is made with email 2FA on and login needs a verified address,
 * so the code goes to the inbox they cannot reach. Signing up with their real
 * address instead does not help: the paid check is matched by the address the
 * stay was sold to, so it would not be found and they would be asked to pay
 * twice.
 *
 * So the address box here is not a convenience. It is the fix. Correcting it
 * MOVES the check to the new address, and then sends.
 *
 * Shown to the landlord on the property page, and to the front desk in the POS,
 * because the desk is who took the money and who the guest will ring.
 */
export function ScreeningsWaitingPanel({ propertyId, api }: { propertyId?: string | null; api: ScreeningsWaitingApi }) {
  const qc = useQueryClient()
  const url = `/background/waiting${propertyId ? `?propertyId=${propertyId}` : ''}`
  const { data, isLoading } = useQuery<WaitingScreening[]>(['screenings-waiting', propertyId ?? 'all'],
    () => api.get(url).then((r: any) => r.data ?? r))
  const rows = data ?? []

  if (isLoading) return null
  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <ShieldCheck size={15} style={{ color: 'var(--text-3)' }} />
        <h3 style={{ margin: 0, fontSize: '.9rem' }}>Background checks waiting</h3>
      </div>
      <p style={{ margin: '0 0 12px', fontSize: '.76rem', color: 'var(--text-3)', maxWidth: 620 }}>
        Paid for, and the person hasn't done it yet. If their email was typed wrong they can't
        reach the link or sign in — fix the address here and send it again.
      </p>
      {rows.length === 0
        ? <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '.8rem', color: 'var(--text-3)' }}>
            <CheckCircle2 size={15} /> Nobody is waiting. Every check that's been paid for has been done.
          </div>
        : rows.map(r => <WaitingRow key={r.id} row={r} api={api}
            onSent={() => qc.invalidateQueries(['screenings-waiting', propertyId ?? 'all'])} />)}
    </div>
  )
}

function WaitingRow({ row, api, onSent }: { row: WaitingScreening; api: ScreeningsWaitingApi; onSent: () => void }) {
  const [email, setEmail] = useState(row.sends_to ?? '')
  const [sentTo, setSentTo] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const changed = email.trim().toLowerCase() !== (row.sends_to ?? '').toLowerCase()

  const send = useMutation(
    () => api.post(`/background/waiting/${row.id}/resend`, changed ? { email: email.trim() } : {}),
    {
      onSuccess: (r: any) => { setError(null); setSentTo((r.data ?? r)?.sentTo ?? email.trim()); onSent() },
      onError: (e: any) => { setSentTo(null); setError(e?.message || 'The link could not be sent just now. Try again in a moment.') },
    })

  const who = row.guest_name || row.sends_to || 'Somebody'
  const stay = row.check_in && row.check_out
    ? `${row.unit_number ? `Site ${row.unit_number} · ` : ''}${row.check_in} → ${row.check_out}`
    : 'No stay — the check on its own'

  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 10, padding: 12, marginBottom: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontWeight: 700, fontSize: '.86rem' }}>{who}</div>
          <div style={{ fontSize: '.74rem', color: 'var(--text-3)' }}>
            {stay}{row.property_name ? ` · ${row.property_name}` : ''}
          </div>
        </div>
        <div style={{ fontSize: '.74rem', color: 'var(--text-3)', textAlign: 'right' }}>
          Paid ${Number(row.amount).toFixed(2)}<br />{new Date(row.created_at).toLocaleDateString()}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <Mail size={14} style={{ color: 'var(--text-3)' }} />
        <input
          value={email} onChange={e => { setEmail(e.target.value); setSentTo(null); setError(null) }}
          placeholder="Their email"
          style={{ flex: '1 1 220px', minWidth: 0, padding: '6px 10px', borderRadius: 8,
                   border: '1px solid var(--border)', background: 'var(--bg-2)', color: 'var(--text-1)', fontSize: '.8rem' }} />
        <button
          onClick={() => send.mutate()} disabled={send.isLoading || !email.trim()}
          style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', borderRadius: 8,
                   border: 'none', background: 'var(--gold)', color: '#1a1a1a', fontWeight: 700,
                   fontSize: '.78rem', cursor: send.isLoading ? 'default' : 'pointer' }}>
          <Send size={13} /> {send.isLoading ? 'Sending…' : changed ? 'Fix and send' : 'Send again'}
        </button>
      </div>
      {sentTo && <div style={{ marginTop: 6, fontSize: '.74rem', color: 'var(--green)' }}>Sent to {sentTo}.</div>}
      {error && <div style={{ marginTop: 6, fontSize: '.74rem', color: 'var(--red)' }}>{error}</div>}
    </div>
  )
}
