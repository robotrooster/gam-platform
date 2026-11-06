import { useState } from 'react'
import { formatCurrency } from '@gam/shared'

/**
 * ── 10/29 (Nic): THE DEPOSIT OFFER, WHEREVER THEY ARE ──────────────────────
 *
 *   "We need the prompt to pop up for any tenants when the deposit has not
 *    been paid yet. If they log in to go and pay their bill, that needs to ask
 *    if they want to sign up for flex deposit at that point. It needs to be
 *    there until the deposit is handled one way or another."
 *
 * The server decides whether there is anything to offer (tenants.me →
 * flexDepositOffer); this only draws it. It goes quiet when the deposit is
 * funded or a plan starts — never because somebody closed it. "Not now" is
 * kept for the session only, so it is in front of them again next visit, which
 * is the point: the resident at MH 28 would otherwise have paid $450 on the
 * 1st without ever learning she could pay $179.50.
 */
export function FlexDepositOfferPrompt({ offer, where }: { offer: any; where: 'home' | 'payments' }) {
  const [hidden, setHidden] = useState(false)
  if (!offer || hidden) return null
  const money = (n: number) => formatCurrency(n)
  return (
    <div className="card" style={{
      borderColor: 'var(--gold)', marginBottom: 16,
      display: 'flex', flexWrap: 'wrap', gap: 16,
      alignItems: 'center', justifyContent: 'space-between',
    }}>
      <div style={{ minWidth: 0, flex: '1 1 260px' }}>
        <div style={{ fontWeight: 600, color: 'var(--text-0)' }}>
          You don't have to pay the whole deposit at once
        </div>
        <div className="ks" style={{ marginTop: 4 }}>
          Your {money(offer.depositAmount)} deposit can be split into{' '}
          {offer.choices.map((c: any) => c.payments).join(' or ')} payments — as little as{' '}
          <strong style={{ color: 'var(--gold)' }}>{money(offer.lowestFirstPull)}</strong> now,
          including the one-time service fee. The rest come monthly.
          {/* The one blocker a resident clears themselves, so the prompt says
              what to do about it instead of going quiet (flexDepositOffer). */}
          {offer.needsBank
            ? ' Payments come from a bank account, so you will add one first.'
            : ''}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
        <button className="btn btn-ghost btn-sm" onClick={() => setHidden(true)}>Not now</button>
        <a className="btn btn-primary btn-sm" href="/services?flexdeposit=1"
           style={{ textDecoration: 'none' }}>
          {offer.needsBank ? 'Get started'
            : where === 'payments' ? 'Split my deposit' : 'See my options'}
        </a>
      </div>
    </div>
  )
}

