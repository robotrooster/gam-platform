import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { useNavigate } from 'react-router-dom'
import { apiGet, apiPost } from '../lib/api'
import { toast } from '../components/dialogs'
import { formatCurrency } from '@gam/shared'
import { ordinal } from '../lib/flexpayCard'

/**
 * 10/26–27 (Nic) — PROBE, THEN REVEAL.
 *
 *   "I want flex pay to not show a flat price. For the people. I want it to say
 *    learn more and kind of probe them for information before revealing the
 *    price. If they see that price without having done any of the work to get
 *    verified, they're just going to take the late fee. They'll be like, oh, it
 *    only saves me a couple bucks and I don't have to do all this sign up. So
 *    it's not worth it."
 *
 * A price read cold is compared against a late fee in the abstract and loses.
 * The same price read after their OWN history is on screen is a different
 * conversation. So this screen asks one question and then shows them their own
 * figures.
 *
 * THE ONE QUESTION IS WHEN THEIR MONEY ARRIVES, NOT WHEN THEY WANT TO PAY:
 * "If they get paid on the second Wednesday, they cannot choose the third
 * Wednesday just for the heck of it." The draw day follows from the answer, so
 * nothing here offers a day as a preference.
 *
 * WHAT THIS SCREEN NEVER SHOWS, both his own calls:
 *   • the price grid — "We don't want to show tenants the table";
 *   • anybody else's late fee — "if other late fees are less, then that's just
 *     going to create them haggling with the landlord, and the landlord doesn't
 *     want that."
 *
 * And the loss case is shown exactly as plainly as the win, with the way in
 * still open: "they can do it out of spite for the landlord so the landlord
 * doesn't get any late fees if they wanted to."
 */

/**
 * KEYS ARE camelCase, and that is not a style choice: the API camelizes every
 * response, so the service's own snake_case names never reach the browser. A
 * field spelled the way the service spells it reads `undefined` here, silently,
 * and the screen renders blanks with no error anywhere.
 */
interface SavingsMonth {
  month: string
  bill: number
  lateFeeCharged: number
  lateFeeWaived: number
  couldHaveBeenCharged: number
  wouldHavePaid: number | null
}

interface LearnMore {
  offered: boolean
  door: { open: boolean; via: string | null; lateMonths: number; cleanMonths: number
          needs: { lateMonths: number; cleanMonths: number } }
  moneyArrivesDay: number | null
  pullDay: number | null
  arrivesBeforeRentIsLate: boolean
  savings: null | {
    months: SavingsMonth[]
    couldHaveBeenCharged: number
    wouldHavePaid: number
    difference: number
    monthsCompared: number
    monthsUnpriced: number
    pullDay: number | null
    benefitWednesday: number | null
    noLateFeePolicy: boolean
  }
  lateFeeWords: string | null
  disclaimer: string
}

const MONTH = (m: string): string => {
  const [y, mo] = m.split('-')
  const name = ['January', 'February', 'March', 'April', 'May', 'June',
                'July', 'August', 'September', 'October', 'November', 'December'][Number(mo) - 1]
  return `${name} ${y}`
}

export function FlexPayLearnMorePage() {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [day, setDay] = useState<number | ''>('')

  const { data, isLoading } = useQuery<LearnMore>(
    'flexpay-learn-more', () => apiGet('/tenants/me/flexpay-learn-more'))

  const answer = useMutation(
    (d: number) => apiPost('/tenants/me/flexpay-money-arrives', { day: d }),
    {
      onSuccess: () => { qc.invalidateQueries('flexpay-learn-more'); qc.invalidateQueries('tenant-me') },
      onError: (e: any) => toast(e?.response?.data?.error || 'That did not save. Try again.'),
    })

  if (isLoading) return <div style={{ color: 'var(--t3)', fontSize: '.85rem' }}>Loading…</div>

  // Not being offered: say so and send them back, rather than an empty screen.
  if (!data?.offered) {
    return (
      <div style={{ maxWidth: 720 }}>
        <div className="ph"><div className="pt">FlexPay</div></div>
        <div className="card" style={{ padding: 18, fontSize: '.9rem', color: 'var(--t2)' }}>
          FlexPay isn’t available on your account right now.
          <div style={{ marginTop: 12 }}>
            <button className="btn" onClick={() => navigate('/services')}>Back to Services</button>
          </div>
        </div>
      </div>
    )
  }

  const s = data.savings
  const win = s ? s.difference > 0 : false

  return (
    <div style={{ maxWidth: 720 }}>
      <div className="ph"><div className="pt">FlexPay</div></div>

      <div className="card" style={{ padding: 18, marginBottom: 16, fontSize: '.9rem', lineHeight: 1.55 }}>
        FlexPay pays your monthly bill to your landlord on time, and GAM collects it
        from your bank when your income lands. It’s a payment-date subscription —
        not a loan, no interest, and GAM never charges you a late fee.
      </div>

      {/* Their own lease, and whose decision the fee has been in practice. */}
      {data.lateFeeWords && (
        <div className="card" style={{ padding: 18, marginBottom: 16, borderLeft: '3px solid var(--gold)' }}>
          <div style={{ fontWeight: 600, marginBottom: 6, fontSize: '.85rem' }}>What your lease says about being late</div>
          <div style={{ fontSize: '.88rem', color: 'var(--t2)', lineHeight: 1.55 }}>{data.lateFeeWords}</div>
        </div>
      )}

      {/* ── NOT YET ──────────────────────────────────────────────────────── */}
      {!data.door.open && (
        <div className="card" style={{ padding: 18, fontSize: '.88rem', color: 'var(--t2)', lineHeight: 1.55 }}>
          <div style={{ fontWeight: 600, color: 'var(--t0)', marginBottom: 6 }}>Not open to you yet</div>
          FlexPay opens once there’s enough of your own payment history here to show you
          whether it would actually help. You need{' '}
          {data.door.needs.cleanMonths > 0 && <>{data.door.needs.cleanMonths} more month
            {data.door.needs.cleanMonths === 1 ? '' : 's'} of on-time payments</>}
          {data.door.needs.cleanMonths > 0 && data.door.needs.lateMonths > 0 && ' — or '}
          {data.door.needs.lateMonths > 0 && <>{data.door.needs.lateMonths} more month
            {data.door.needs.lateMonths === 1 ? '' : 's'} where a payment ran late</>}
          .
          <div style={{ marginTop: 10, fontSize: '.82rem', color: 'var(--t3)' }}>
            Nothing to do in the meantime. We’ll show you your own numbers when it opens.
          </div>
        </div>
      )}

      {/* ── THE ONE QUESTION ─────────────────────────────────────────────── */}
      {data.door.open && data.moneyArrivesDay == null && (
        <div className="card" style={{ padding: 18 }}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>When does your money arrive?</div>
          <div style={{ fontSize: '.85rem', color: 'var(--t2)', marginBottom: 14, lineHeight: 1.55 }}>
            Not when you’d like to pay — the day your income actually lands. GAM collects
            on that day, so this sets your date and your price together.
          </div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <select className="inp" value={day} style={{ maxWidth: 220 }}
              onChange={e => setDay(e.target.value === '' ? '' : Number(e.target.value))}>
              <option value="">Pick the day…</option>
              {Array.from({ length: 28 }, (_, i) => i + 1).map(d => (
                <option key={d} value={d}>{ordinal(d)} of the month</option>
              ))}
            </select>
            <button className="btn btn-gold" disabled={day === '' || answer.isLoading}
              onClick={() => day !== '' && answer.mutate(day)}>
              {answer.isLoading ? 'Saving…' : 'Show me my numbers'}
            </button>
          </div>
          <div style={{ marginTop: 12, fontSize: '.8rem', color: 'var(--t3)' }}>
            This is between you and GAM. Your landlord isn’t told and it has no bearing on
            your tenancy.
          </div>
        </div>
      )}

      {/* ── PAID BEFORE RENT IS EVER LATE ────────────────────────────────── */}
      {data.arrivesBeforeRentIsLate && (
        <div className="card" style={{ padding: 18, fontSize: '.88rem', color: 'var(--t2)', lineHeight: 1.55 }}>
          <div style={{ fontWeight: 600, color: 'var(--t0)', marginBottom: 6 }}>
            You’re paid on the {ordinal(data.moneyArrivesDay!)} — before rent is late
          </div>
          Your money lands before your rent is late, so there’s nothing for FlexPay to
          cover. Paying it yourself on the day you’re paid costs you nothing at all.
          <div style={{ marginTop: 12 }}>
            <button className="btn" onClick={() => navigate('/payments')}>Go to Payments</button>
          </div>
        </div>
      )}

      {/* ── THE REVEAL: THEIR OWN FIGURES ────────────────────────────────── */}
      {s && (
        <>
          <div className="card" style={{ padding: 18, marginBottom: 16 }}>
            <div style={{ fontWeight: 600, marginBottom: 10 }}>
              Your last {s.monthsCompared} month{s.monthsCompared === 1 ? '' : 's'}
            </div>

            {s.noLateFeePolicy ? (
              <div style={{ fontSize: '.88rem', color: 'var(--t2)', lineHeight: 1.55, marginBottom: 12 }}>
                Your property doesn’t charge late fees at all, so being late has cost you
                nothing. FlexPay would be a cost, not a saving — it’s here if you want your
                bill paid on time regardless.
              </div>
            ) : (
              <div style={{ fontSize: '.88rem', color: 'var(--t2)', lineHeight: 1.55, marginBottom: 12 }}>
                What your lease allowed in late fees, against what FlexPay would have cost
                over the same months. Fees your landlord let slide are counted here — your
                lease allowed them.
              </div>
            )}

            <div style={{ display: 'grid', gap: 8, fontSize: '.88rem' }}>
              <Row label="Late fees you could have been charged" value={formatCurrency(s.couldHaveBeenCharged)} />
              <Row label="What FlexPay would have cost" value={formatCurrency(s.wouldHavePaid)} />
              <div style={{ height: 1, background: 'var(--line,#333)', margin: '4px 0' }} />
              <Row
                label={win ? 'FlexPay would have cost you less' : 'FlexPay would have cost you more'}
                value={formatCurrency(Math.abs(s.difference))}
                strong
                color={win ? 'var(--green,#4caf7d)' : 'var(--t0)'}
              />
            </div>

            {s.monthsUnpriced > 0 && (
              <div style={{ marginTop: 12, fontSize: '.8rem', color: 'var(--t3)' }}>
                {s.monthsUnpriced} month{s.monthsUnpriced === 1 ? '' : 's'} left out: the bill was
                larger than FlexPay covers, so there’s no price to compare.
              </div>
            )}
          </div>

          {/* Month by month, so the total is never a number they have to trust. */}
          {s.months.length > 0 && (
            <div className="card" style={{ padding: 18, marginBottom: 16, overflowX: 'auto' }}>
              <div style={{ fontWeight: 600, marginBottom: 10, fontSize: '.85rem' }}>Month by month</div>
              <table style={{ width: '100%', fontSize: '.82rem', borderCollapse: 'collapse', minWidth: 0 }}>
                <thead>
                  <tr style={{ color: 'var(--t3)', textAlign: 'left' }}>
                    <th style={{ padding: '4px 8px 8px 0', fontWeight: 500 }}>Month</th>
                    <th style={{ padding: '4px 8px 8px 0', fontWeight: 500, textAlign: 'right' }}>Could have been charged</th>
                    <th style={{ padding: '4px 0 8px 0', fontWeight: 500, textAlign: 'right' }}>FlexPay</th>
                  </tr>
                </thead>
                <tbody>
                  {s.months.map(m => (
                    <tr key={m.month} style={{ borderTop: '1px solid var(--line,#2a2a2a)' }}>
                      <td style={{ padding: '7px 8px 7px 0', color: 'var(--t2)' }}>{MONTH(m.month)}</td>
                      <td className="mono" style={{ padding: '7px 8px 7px 0', textAlign: 'right' }}>
                        {formatCurrency(m.couldHaveBeenCharged)}
                        {m.lateFeeWaived > 0 && (
                          <span style={{ color: 'var(--t3)', fontSize: '.75rem' }}>
                            {' '}(incl. {formatCurrency(m.lateFeeWaived)} waived)
                          </span>
                        )}
                      </td>
                      <td className="mono" style={{ padding: '7px 0', textAlign: 'right' }}>
                        {m.wouldHavePaid == null
                          ? <span style={{ color: 'var(--t3)' }}>not covered</span>
                          : formatCurrency(m.wouldHavePaid)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="card" style={{ padding: 18, marginBottom: 16 }}>
            <div style={{ fontSize: '.88rem', lineHeight: 1.55 }}>
              Your bill would be paid on time each month and GAM would collect it from your
              bank on the {ordinal(s.pullDay!)}, the day your money lands.
            </div>
            <div style={{ marginTop: 14 }}>
              {/* The way in stays open either way — that is deliberate. */}
              <button className="btn btn-gold" onClick={() => navigate('/services')}>
                I’m interested in FlexPay
              </button>
            </div>
          </div>

          <div style={{ fontSize: '.78rem', color: 'var(--t3)', lineHeight: 1.6, padding: '0 2px 24px' }}>
            {data.disclaimer}
          </div>
        </>
      )}
    </div>
  )
}

function Row({ label, value, strong, color }: {
  label: string; value: string; strong?: boolean; color?: string
}) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
      <span style={{ color: strong ? (color ?? 'var(--t0)') : 'var(--t2)', fontWeight: strong ? 600 : 400 }}>{label}</span>
      <span className="mono" style={{ color: color ?? 'var(--t0)', fontWeight: strong ? 700 : 500 }}>{value}</span>
    </div>
  )
}
