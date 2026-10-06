import { useQuery } from 'react-query'
import { RETURNING_GUEST_LABEL, RETURNING_GUEST_DETAIL } from '@gam/shared'
import { apiGet } from '../lib/api'

/**
 * 10/6 (Nic) — "Returning guest — they've stayed with us before."
 *
 *   "I need a way when I'm manually adding a reservation by hand to confirm
 *    that that person's been here before... I need to verify that the system
 *    is not going to try to do a background check on them."
 *
 * Shown beside the background check on the schedule's reservation form and
 * edit, for a stay that needs one (more than three weeks in a row, nothing on
 * file). Only an owner or a manager allowed to invite tenants is offered it
 * (the server says so); front-desk staff without that never see it. When the
 * property's yearly allowance is used up it shows greyed with the reason in
 * words — never a count.
 */
export const RETURNING_GUEST_WORDS = RETURNING_GUEST_LABEL
export { RETURNING_GUEST_DETAIL }

export interface ReturningOffer { available: boolean; free: boolean; message: string | null }

export function useReturningGuestOffer(p: {
  unitId: string | null | undefined; checkIn: string; checkOut: string; email?: string | null; bookingId?: string | null
  enabled?: boolean
}) {
  const ready = !!p.unitId && !!p.checkIn && !!p.checkOut && p.checkOut > p.checkIn && p.enabled !== false
  return useQuery<{ nights: number; screening: string; screeningFee: number | null; offered: boolean; returning: ReturningOffer | null }>(
    ['returning-guest', p.unitId, p.checkIn, p.checkOut, (p.email || '').trim().toLowerCase(), p.bookingId ?? null],
    () => {
      const qs = new URLSearchParams({ checkIn: p.checkIn, checkOut: p.checkOut })
      if (p.email?.trim()) qs.set('email', p.email.trim())
      if (p.bookingId) qs.set('bookingId', p.bookingId)
      return apiGet(`/units/${p.unitId}/returning-guest?${qs.toString()}`)
    },
    { enabled: ready, staleTime: 15_000, retry: false },
  )
}

/** The choice itself: a checkbox, or the same line greyed with the reason. */
export function ReturningGuestChoice({ offer, checked, onChange, fee }: {
  offer: ReturningOffer | null | undefined
  checked: boolean
  onChange: (on: boolean) => void
  /** The background check's fee it saves, when known. */
  fee?: number | null
}) {
  if (!offer) return null
  if (!offer.available) {
    return (
      <div style={{ padding: '8px 10px', border: '1px solid var(--border-1)', borderRadius: 8, opacity: .6, fontSize: '.76rem', color: 'var(--text-3)', lineHeight: 1.5 }}>
        <b style={{ color: 'var(--text-1)' }}>{RETURNING_GUEST_WORDS}</b> — {offer.message}
      </div>
    )
  }
  return (
    <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', cursor: 'pointer', padding: '8px 10px',
                    border: `1px solid ${checked ? 'var(--gold)' : 'var(--border-1)'}`, borderRadius: 8,
                    background: checked ? 'var(--gold-bg)' : 'var(--bg-2)' }}>
      <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} style={{ marginTop: 3 }} />
      <div>
        <div style={{ fontSize: '.8rem', fontWeight: 600, color: 'var(--text-0)' }}>{RETURNING_GUEST_WORDS}</div>
        <div style={{ fontSize: '.72rem', color: 'var(--text-3)', lineHeight: 1.5 }}>
          No background check{fee ? ` and no ${'$'}${fee.toFixed(2)} fee` : ''} — check-in won&apos;t wait on one.
          GAM records that you confirmed it.
        </div>
      </div>
    </label>
  )
}
