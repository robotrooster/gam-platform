/**
 * S609 — the tenant's autopay control, on the Payments page.
 *
 * NIC, DIRECTIVE: the pull day belongs to the tenant. "The landlord should not
 * be pulling the strings on when the money gets moved. That could be used the
 * wrong way with a landlord pushing the date back and getting extra late fees."
 * There is no landlord-facing version of this screen and there must never be —
 * the landlord only ever sees THAT a payment is scheduled.
 *
 * NO FORECAST (Nic): "We don't need to make it all complicated and show somebody
 * what their bill will be exactly." The balance moves between choosing a day and
 * the charge landing, so any number promised here is one the system cannot keep.
 * The tenant is told the rule instead — the whole balance, on the day they pick,
 * and picking a day after rent is due costs late fees under their lease.
 */

import { useState } from 'react'
import { useQuery, useQueryClient } from 'react-query'
import { apiGet, apiPut } from '../lib/api'
import { useTenantPaymentMethods, type SavedPaymentMethod } from './payShared'

interface AutopayRow {
  leaseId:         string
  propertyName:    string
  unitNumber:      string
  rentDueDay:      number | null
  /** S616: how many days past the due day before a late fee starts. */
  lateFeeGraceDays: number | null
  lateFeeEnabled:  boolean | null
  autopayId:       string | null
  enabled:         boolean | null
  pullDay:         number | null
  paymentMethodId: string | null
  lastSuccessCycle: string | null
  disarmedAt:      string | null
  disarmedReason:  string | null
}

const ordinal = (n: number): string => {
  const s = ['th', 'st', 'nd', 'rd']
  const v = n % 100
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`
}

export function AutopaySection() {
  const { data: rows = [] } = useQuery<AutopayRow[]>('autopay', () => apiGet('/autopay'))
  if (rows.length === 0) return null
  return (
    <>
      {rows.map((r) => <AutopayCard key={r.leaseId} row={r} multi={rows.length > 1} />)}
    </>
  )
}

function AutopayCard({ row, multi }: { row: AutopayRow; multi: boolean }) {
  const qc = useQueryClient()
  const { data: methods = [] } = useTenantPaymentMethods()
  const on = !!row.enabled

  const [editing, setEditing] = useState(false)
  // null = "on the day rent is due", the ordinary case.
  const [pullDay, setPullDay] = useState<number | null>(row.pullDay)
  const [methodId, setMethodId] = useState<string | null>(row.paymentMethodId)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const save = async (enabled: boolean) => {
    setSaving(true); setError(null)
    try {
      await apiPut('/autopay', {
        leaseId: row.leaseId,
        enabled,
        pullDay,
        paymentMethodId: methodId,
      })
      qc.invalidateQueries('autopay')
      setEditing(false)
    } catch (e: any) {
      setError(e?.response?.data?.error?.message || e?.message || 'Could not save that. Try again.')
    } finally {
      setSaving(false)
    }
  }

  const dueDay = row.rentDueDay ?? 1
  const chargeDay = pullDay ?? dueDay
  // Matches the late-fee engine's own fallback, so the screen and the charge
  // never disagree about which day is safe.
  const graceDays = row.lateFeeGraceDays ?? 5
  // The engine fires when today >= due + grace, so the last free day is one
  // before that. With late fees switched off entirely there is no unsafe day.
  const lastFreeDay = row.lateFeeEnabled === false ? 28 : dueDay + graceDays - 1
  const afterDue = chargeDay > dueDay
  // A bank still verifying cannot be charged, so it must not be offered as the
  // method a monthly schedule depends on.
  const usable = methods.filter((m: SavedPaymentMethod) => !(m.type === 'ach' && m.verified === false))

  const label = (m: SavedPaymentMethod) =>
    m.type === 'ach'
      ? `${m.bankName ?? 'Bank'} ····${m.last4 ?? ''}`
      : `${(m.brand ?? 'Card').toUpperCase()} ····${m.last4 ?? ''}`

  return (
    <div className="card" style={{ padding: 16, marginTop: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 240 }}>
          <div style={{ fontSize: '.72rem', fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.08em', marginBottom: 4 }}>
            Autopay{multi ? ` — ${row.propertyName} · Unit ${row.unitNumber}` : ''}
          </div>

          {on && !editing ? (
            <>
              <div style={{ fontWeight: 700, color: 'var(--green)', fontSize: '1rem' }}>
                On — pays on the {ordinal(chargeDay)} of each month
              </div>
              <div style={{ fontSize: '.74rem', color: 'var(--t3)', marginTop: 4, lineHeight: 1.5 }}>
                We charge your whole balance on that day, whatever it is then.
                {afterDue && ' Because that’s after rent is due, late fees under your lease still apply.'}
              </div>
            </>
          ) : !on ? (
            <>
              <div style={{ fontWeight: 700, color: 'var(--t0)', fontSize: '1rem' }}>Off</div>
              <div style={{ fontSize: '.74rem', color: 'var(--t3)', marginTop: 4, lineHeight: 1.5 }}>
                {row.disarmedReason
                  ? `${row.disarmedReason} Turn it back on once the account you pay from is ready.`
                  : 'Pick a day and we’ll pay your rent for you each month — useful if your money lands on a set date.'}
              </div>
            </>
          ) : null}
        </div>

        {!editing && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
            {on ? (
              <>
                <button className="btn btn-p btn-sm" onClick={() => setEditing(true)}>Change</button>
                <button className="btn btn-g btn-sm" disabled={saving} onClick={() => save(false)}>
                  Turn off
                </button>
              </>
            ) : (
              <button className="btn btn-p btn-sm" onClick={() => setEditing(true)}>Set up autopay</button>
            )}
          </div>
        )}
      </div>

      {editing && (
        <div style={{ marginTop: 14, borderTop: '1px solid var(--b1)', paddingTop: 14 }}>
          <div style={{ fontSize: '.78rem', color: 'var(--t3)', marginBottom: 6 }}>Pay on</div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '.82rem', color: 'var(--t1)' }}>
              <input type="radio" checked={pullDay == null} onChange={() => setPullDay(null)} />
              The day rent is due (the {ordinal(dueDay)})
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '.82rem', color: 'var(--t1)' }}>
              <input type="radio" checked={pullDay != null} onChange={() => setPullDay(dueDay)} />
              A day I pick
            </label>
            {pullDay != null && (
              <select
                className="inp"
                value={pullDay}
                onChange={(e) => setPullDay(Number(e.target.value))}
                style={{ width: 110 }}
              >
                {/* 1–28 only: the 29th–31st do not exist every month, and a
                    schedule that silently skips February is worse than none. */}
                {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => (
                  <option key={d} value={d}>{ordinal(d)}</option>
                ))}
              </select>
            )}
          </div>

          {/* S616 (Nic): "if people get their Social Security on the third or
              the fifth... and it's still within the grace period, they should be
              able to choose to have auto payment set up."
              They always could. What was wrong was this message: ANY day after
              the due day was called late, so a tenant paid on the 3rd with a
              five-day grace was warned about fees they would never be charged.
              Telling someone their rent will be penalised when it will not is
              how you talk them out of the arrangement that would have kept them
              current.
              The engine charges a fee when today >= due + grace, so the last
              free day is (due + grace − 1). Autopay initiating on that day is
              genuinely safe: an in-flight ACH counts as paid from the day it
              starts, so the fee never accrues while it clears. */}
          {pullDay != null && pullDay > dueDay && (
            pullDay <= lastFreeDay ? (
              <div style={{ fontSize: '.74rem', color: 'var(--t3)', marginTop: 8, lineHeight: 1.5 }}>
                Rent is due on the {ordinal(dueDay)}, and your lease allows {graceDays} day
                {graceDays === 1 ? '' : 's'} past that before a late fee. Paying on the{' '}
                {ordinal(pullDay)} is inside that window — <strong>no late fee</strong>. Pick the day your
                money actually arrives.
              </div>
            ) : (
              <div style={{ fontSize: '.74rem', color: 'var(--warn)', marginTop: 8, lineHeight: 1.5 }}>
                Rent is due on the {ordinal(dueDay)}, and your lease allows {graceDays} day
                {graceDays === 1 ? '' : 's'} past that. Paying on the {ordinal(pullDay)} is beyond it, so
                late fees under your lease will apply — we can&apos;t waive those. The {ordinal(lastFreeDay)} is
                the last day without one.
              </div>
            )
          )}

          <div style={{ fontSize: '.78rem', color: 'var(--t3)', margin: '14px 0 6px' }}>Pay from</div>
          <select
            className="inp"
            value={methodId ?? ''}
            onChange={(e) => setMethodId(e.target.value || null)}
            style={{ width: '100%', maxWidth: 340 }}
          >
            <option value="">Whichever method is my default at the time</option>
            {usable.map((m: SavedPaymentMethod) => (
              <option key={m.id} value={m.id}>{label(m)}</option>
            ))}
          </select>

          <div style={{ fontSize: '.74rem', color: 'var(--t3)', marginTop: 10, lineHeight: 1.5 }}>
            We charge your <strong>whole balance</strong> on that day — rent plus anything else on your
            account at that moment. We don&apos;t show you the amount in advance because it can still change
            between now and then. You&apos;ll get an email each time it runs, and if it ever doesn&apos;t go
            through we&apos;ll tell you straight away.
          </div>

          {error && (
            <div className="alert a-warn" style={{ marginTop: 10, fontSize: '.78rem' }}>{error}</div>
          )}

          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button className="btn btn-p" disabled={saving} onClick={() => save(true)}>
              {saving ? 'Saving…' : on ? 'Save changes' : 'Turn on autopay'}
            </button>
            <button className="btn btn-g" disabled={saving} onClick={() => {
              setEditing(false); setPullDay(row.pullDay); setMethodId(row.paymentMethodId); setError(null)
            }}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
