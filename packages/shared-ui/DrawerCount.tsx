/**
 * ── COUNTING THE CASH DRAWER DOWN ───────────────────────────────────────────
 *
 * 10/30 (Nic, directive): "Make a bank deposit" was the wrong wording and the
 * wrong model. Staff count the drawer down to what it started with so the
 * register zeroes out; the money pulled out waits until a bank run is worth
 * making. This screen is the count, not the bank trip.
 *
 * Lives in shared-ui on purpose. The register ships in TWO apps and a test
 * fails the deploy if they drift (apps/api/src/pos-parity.test.ts); one file
 * imported by both cannot drift. No new CSS classes either — that would be two
 * stylesheets to keep in step — so everything here is inline off the theme vars.
 *
 * THE WORD "FLOAT" IS NOT IN THIS FILE. Asked what it meant, Nic had never
 * heard it: "What the hell is a register float? What does that even mean?" The
 * screen says STARTING CASH — what stays in the drawer.
 *
 * Three states, in the order a person meets them:
 *   no register chosen  → claim this tablet ("set once per device", his choice)
 *   register, no shift   → start the shift, which shows what is in the drawer
 *   shift open           → count it down
 *
 * The device remembers which register it is. Nic, 10/31: a tablet is set up once
 * and never asked again, because "it just has to know which one it is" and the
 * person at 6am should not be picking from a list they can get wrong.
 */
import { useState, useEffect, useMemo } from 'react'
import { CASH_DENOMINATIONS, CASH_DENOMINATION_LABEL, cashBreakdownTotalCents,
         STARTING_CASH_SUGGESTION_CENTS, DRAWER_VARIANCE_REASON_SUGGESTION_CENTS } from '@gam/shared'

export interface DrawerApi {
  get:   (path: string) => Promise<any>
  post:  (path: string, body?: any) => Promise<any>
  patch: (path: string, body?: any) => Promise<any>
  toastError: (msg: string) => void
}

export interface DrawerRegister {
  id: string
  name: string
  startingCashCents: number | null
  startingCashBreakdown: Record<string, number> | null
  varianceReasonOverCents: number | null
  openShiftId: string | null
  openShiftWho: string | null
  openShiftOpeningCents: number | null
}

const money = (cents: number | null | undefined) =>
  cents == null ? '—' : `$${(cents / 100).toFixed(2)}`

/** Which register this tablet is. Per device, remembered, changeable. */
const DEVICE_KEY = 'gam.register.device'
function rememberedRegister(propertyId: string): string | null {
  try { return localStorage.getItem(`${DEVICE_KEY}.${propertyId}`) } catch { return null }
}
function rememberRegister(propertyId: string, registerId: string | null): void {
  try {
    if (registerId) localStorage.setItem(`${DEVICE_KEY}.${propertyId}`, registerId)
    else localStorage.removeItem(`${DEVICE_KEY}.${propertyId}`)
  } catch { /* private mode: it asks again next time, which is safe */ }
}

const card: React.CSSProperties = {
  border: '1px solid var(--border-1)', borderRadius: 'var(--r-md, 10px)', padding: 14,
}
const label: React.CSSProperties = {
  fontSize: '.72rem', color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.04em',
}
const why: React.CSSProperties = {
  fontSize: '.75rem', color: 'var(--text-3)', lineHeight: 1.5,
}

export function DrawerCount({ propertyId, api, canConfigure }: {
  propertyId: string; api: DrawerApi
  /** Whoever may set up registers and their starting cash (pos.manage_inventory). */
  canConfigure?: boolean
}) {
  const [registers, setRegisters] = useState<DrawerRegister[] | null>(null)
  const [mine, setMine] = useState<string | null>(() => rememberedRegister(propertyId))
  const [busy, setBusy] = useState(false)
  const [reload, setReload] = useState(0)

  useEffect(() => { setMine(rememberedRegister(propertyId)) }, [propertyId])

  useEffect(() => {
    let alive = true
    api.get(`/pos/registers?propertyId=${encodeURIComponent(propertyId)}`)
      .then((rows: any) => { if (!alive) return
        // The API serves camelCase to every frontend (S583 wire contract); a
        // snake_case read here is `undefined` in production and this screen
        // would render blank. The guard in apps/api/src/wireContract.test.ts
        // caught exactly that before it shipped.
        setRegisters((rows ?? []).map((r: any) => ({
          id: r.id, name: r.name,
          startingCashCents: r.startingCashCents == null ? null : Number(r.startingCashCents),
          startingCashBreakdown: r.startingCashBreakdown ?? null,
          varianceReasonOverCents: r.varianceReasonOverCents == null ? null : Number(r.varianceReasonOverCents),
          openShiftId: r.openShiftId ?? null,
          openShiftWho: r.openShiftWho ?? null,
          openShiftOpeningCents: r.openShiftOpeningCents == null ? null : Number(r.openShiftOpeningCents),
        })))
      })
      .catch(() => { if (alive) setRegisters([]) })
    return () => { alive = false }
  }, [propertyId, reload, api])

  const register = useMemo(
    () => registers?.find(r => r.id === mine) ?? null, [registers, mine])

  if (registers == null) return <div style={why}>Loading the registers…</div>

  if (registers.length === 0) {
    return (
      <div style={card}>
        <div style={{ fontWeight: 700, color: 'var(--text-0)', marginBottom: 4 }}>No registers here yet</div>
        <div style={{ ...why, marginBottom: canConfigure ? 10 : 0 }}>
          A register is one cash drawer. Add one for each drawer this place runs — a second one kept for break
          coverage counts as its own, because it holds a different amount of cash.
        </div>
        {canConfigure
          ? <NewRegister propertyId={propertyId} api={api} onMade={() => setReload(n => n + 1)} />
          : <div style={why}>Ask the owner or a manager to set one up.</div>}
      </div>
    )
  }

  // ── This tablet has not been claimed yet ────────────────────────────────
  if (!register) {
    return (
      <div style={card}>
        <div style={{ fontWeight: 700, color: 'var(--text-0)', marginBottom: 4 }}>Which register is this?</div>
        <div style={{ ...why, marginBottom: 10 }}>
          Asked once on this device, then never again — so nobody has to pick it at the start of every shift.
        </div>
        <div style={{ display: 'grid', gap: 6 }}>
          {registers.map(r => (
            <button key={r.id} className="btn btn-primary" style={{ justifyContent: 'space-between' }}
              onClick={() => { rememberRegister(propertyId, r.id); setMine(r.id) }}>
              <span>{r.name}</span>
              <span style={{ fontSize: '.75rem', opacity: .8 }}>
                {r.startingCashCents == null ? 'no starting cash set' : `starts with ${money(r.startingCashCents)}`}
              </span>
            </button>
          ))}
        </div>
      </div>
    )
  }

  const forget = () => { rememberRegister(propertyId, null); setMine(null) }

  // ── Claimed, but nobody has said what stays in the drawer ───────────────
  if (register.startingCashCents == null) {
    return (
      <div style={card}>
        <div style={{ fontWeight: 700, color: 'var(--text-0)' }}>{register.name}</div>
        <div style={{ ...why, margin: '6px 0 10px' }}>
          Nobody has said what stays in this drawer yet, so there is nothing to count down to.
        </div>
        {canConfigure
          ? <StartingCash registerId={register.id} api={api} onSaved={() => setReload(n => n + 1)} />
          : <div style={{ ...why, marginBottom: 10 }}>Ask the owner or a manager to set it.</div>}
        <button className="btn btn-ghost btn-sm" style={{ marginTop: 10 }} onClick={forget}>
          This is a different register
        </button>
      </div>
    )
  }

  // ── Claimed and ready, no shift open ────────────────────────────────────
  if (!register.openShiftId) {
    return (
      <div style={card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10 }}>
          <div style={{ fontWeight: 700, color: 'var(--text-0)' }}>{register.name}</div>
          <button className="btn btn-ghost btn-sm" onClick={forget}>Not this register</button>
        </div>
        <div style={{ ...why, margin: '6px 0 10px' }}>
          The drawer starts with <b style={{ color: 'var(--text-0)' }}>{money(register.startingCashCents)}</b>
          {register.startingCashBreakdown
            ? <> — {describeBreakdown(register.startingCashBreakdown)}</> : null}. Count it before you start if
          you want to be sure it's right.
        </div>
        <button className="btn btn-primary" disabled={busy}
          onClick={async () => {
            setBusy(true)
            try { await api.post(`/pos/registers/${register.id}/shifts`, {}); setReload(n => n + 1) }
            catch (e: any) { api.toastError(errText(e)) }
            finally { setBusy(false) }
          }}>
          Start the shift
        </button>
        <PastCounts propertyId={propertyId} api={api} reload={reload} />
      </div>
    )
  }

  return (
    <>
      <CountDown shiftId={register.openShiftId} registerName={register.name} api={api}
                 onClosed={() => setReload(n => n + 1)} onForget={forget} />
      <PastCounts propertyId={propertyId} api={api} reload={reload} />
    </>
  )
}

/**
 * ── 10/31 (Nic): WHAT HAPPENED BEFORE ───────────────────────────────────────
 *
 *   "The bosses are going to want to know where that money went, not that just
 *    that it's gone."
 *
 * The count and the leads were both useless without somewhere to look back, so
 * "how often is Register 1 short?" had no answer. This is every closed shift,
 * newest first, with the run of numbers above it.
 */
function PastCounts({ propertyId, api, reload }: { propertyId: string; api: DrawerApi; reload: number }) {
  const [data, setData] = useState<any>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!open) return
    let alive = true
    api.get(`/pos/registers/shifts?propertyId=${encodeURIComponent(propertyId)}`)
      .then((d: any) => { if (alive) setData(d) })
      .catch(() => { if (alive) setData(false) })
    return () => { alive = false }
  }, [propertyId, open, reload, api])

  if (!open) {
    return (
      <button className="btn btn-ghost btn-sm" style={{ marginTop: 10 }} onClick={() => setOpen(true)}>
        Past counts
      </button>
    )
  }
  if (data === null) return <div style={{ ...why, marginTop: 12 }}>Loading the past counts…</div>
  if (data === false) return <div style={{ ...why, marginTop: 12 }}>Could not load the past counts.</div>

  const shifts: any[] = data.shifts ?? []
  const sum = data.summary ?? {}
  return (
    <div style={{ ...card, marginTop: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10 }}>
        <div style={{ fontWeight: 700, color: 'var(--text-0)' }}>Past counts — last 30 days</div>
        <button className="btn btn-ghost btn-sm" onClick={() => setOpen(false)}>Hide</button>
      </div>

      <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', margin: '10px 0 12px' }}>
        <Figure label="Counted" value={String(sum.shifts ?? 0)} />
        <Figure label="Balanced" value={String(sum.balanced ?? 0)} tone={sum.balanced ? 'good' : undefined} />
        <Figure label="Short" value={String(sum.short ?? 0)} tone={sum.short ? 'bad' : undefined} />
        <Figure label="Over" value={String(sum.over ?? 0)} />
        <Figure label="Net difference"
          value={money(Number(sum.netVarianceCents ?? 0))}
          tone={Number(sum.netVarianceCents ?? 0) < 0 ? 'bad' : undefined} strong />
        <Figure label="Taken to the safe" value={money(Number(sum.droppedCents ?? 0))} />
      </div>

      {shifts.length === 0 ? (
        <div style={why}>No drawer has been counted here yet.</div>
      ) : (
        <div style={{ display: 'grid', gap: 6 }}>
          {shifts.map(sh => {
            const v = Number(sh.varianceCents ?? 0)
            const isOpen = sh.status === 'open'
            return (
              <div key={sh.id} style={{
                padding: '8px 10px', borderRadius: 8, background: 'var(--bg-2)',
                borderLeft: `3px solid ${isOpen ? 'var(--gold)' : v === 0 ? 'var(--green)' : 'var(--red)'}`,
              }}>
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'baseline' }}>
                  <span className="mono" style={{ fontWeight: 700, color: 'var(--text-0)' }}>
                    {String(sh.businessDay ?? '').slice(0, 10)}
                  </span>
                  <span style={{ fontSize: '.82rem', color: 'var(--text-0)' }}>{sh.registerName}</span>
                  {isOpen
                    ? <span style={{ fontSize: '.78rem', color: 'var(--gold)' }}>still open</span>
                    : <span style={{ fontSize: '.78rem', color: v === 0 ? 'var(--green)' : 'var(--red)' }}>
                        {v === 0 ? 'balanced' : `${money(Math.abs(v))} ${v < 0 ? 'short' : 'over'}`}
                      </span>}
                  {sh.closedByName && (
                    <span style={{ fontSize: '.78rem', color: 'var(--text-3)' }}>counted by {sh.closedByName}</span>
                  )}
                  {sh.bankedOn
                    ? <span style={{ fontSize: '.78rem', color: 'var(--text-3)' }}>
                        banked {String(sh.bankedOn).slice(0, 10)}
                      </span>
                    : !isOpen && Number(sh.dropCents ?? 0) > 0
                      ? <span style={{ fontSize: '.78rem', color: 'var(--text-3)' }}>
                          {money(Number(sh.dropCents))} in the safe
                        </span>
                      : null}
                </div>
                {!isOpen && (
                  <div style={{ ...why, marginTop: 3 }}>
                    Started {money(Number(sh.openingCashCents ?? 0))} · should have held{' '}
                    {money(Number(sh.expectedCashCents ?? 0))} · counted {money(Number(sh.countedCashCents ?? 0))}
                  </div>
                )}
                {sh.varianceReason && (
                  <div style={{ fontSize: '.78rem', color: 'var(--text-2)', marginTop: 3, fontStyle: 'italic' }}>
                    "{sh.varianceReason}"
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

/** "five 5s and 75 1s" — his own words for why a bare total is not enough. */
function describeBreakdown(b: Record<string, number>): string {
  const parts = CASH_DENOMINATIONS
    .filter(d => (b[String(d)] ?? 0) > 0)
    .map(d => `${b[String(d)]} × ${CASH_DENOMINATION_LABEL[d] ?? `${d}c`}`)
  return parts.length ? parts.join(', ') : 'no breakdown given'
}

function errText(e: any): string {
  return e?.response?.data?.error || e?.message || 'That did not go through'
}

/**
 * The count. The drawer's own figure is shown — this is not blind entry: the
 * cashier is counting real money and has to be able to see whether it matches.
 * (Blind entry is for METER reads, where a prior value biases the reader.)
 */
function CountDown({ shiftId, registerName, api, onClosed, onForget }: {
  shiftId: string; registerName: string; api: DrawerApi
  onClosed: () => void; onForget: () => void
}) {
  const [shift, setShift] = useState<any>(null)
  const [byDenom, setByDenom] = useState<Record<string, number>>({})
  const [plainTotal, setPlainTotal] = useState('')
  const [useDenoms, setUseDenoms] = useState(true)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    api.get(`/pos/registers/shifts/${shiftId}`)
      .then((d: any) => { if (alive) setShift(d) })
      .catch(() => { if (alive) setShift(false) })
    return () => { alive = false }
  }, [shiftId, api])

  const countedCents = useDenoms
    ? cashBreakdownTotalCents(byDenom)
    : Math.round((Number(plainTotal) || 0) * 100)

  if (shift === null) return <div style={why}>Loading the drawer…</div>
  if (shift === false) return <div style={why}>Could not load this shift.</div>

  const expected = Number(shift.money?.expectedCents ?? 0)
  const opening = Number(shift.money?.openingCents ?? 0)
  const variance = countedCents - expected
  const drop = countedCents - opening
  const threshold = shift.varianceReasonOverCents == null ? null : Number(shift.varianceReasonOverCents)
  const needsReason = threshold != null && Math.abs(variance) > threshold
  const entered = useDenoms ? Object.keys(byDenom).length > 0 : plainTotal.trim() !== ''

  return (
    <div style={card}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10 }}>
        <div style={{ fontWeight: 700, color: 'var(--text-0)' }}>{registerName} — counting down</div>
        <button className="btn btn-ghost btn-sm" onClick={onForget}>Not this register</button>
      </div>

      <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', margin: '10px 0 12px' }}>
        <Figure label="Started with" value={money(opening)} />
        <Figure label="Cash taken in" value={money(Number(shift.money?.cashSalesCents ?? 0))} />
        <Figure label="Cash handed back" value={money(Number(shift.money?.cashRefundsCents ?? 0))} />
        <Figure label="Should be in the drawer" value={money(expected)} strong />
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
        <button className={`btn btn-sm ${useDenoms ? 'btn-primary' : 'btn-ghost'}`}
          onClick={() => setUseDenoms(true)}>Count the bills</button>
        <button className={`btn btn-sm ${!useDenoms ? 'btn-primary' : 'btn-ghost'}`}
          onClick={() => setUseDenoms(false)}>Just the total</button>
      </div>

      {useDenoms ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(118px, 1fr))', gap: 8 }}>
          {CASH_DENOMINATIONS.map(d => (
            <label key={d} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ ...label, width: 58, flexShrink: 0 }}>{CASH_DENOMINATION_LABEL[d] ?? d}</span>
              <input className="form-input mono" type="text" inputMode="numeric" autoComplete="off"
                value={byDenom[String(d)] ?? ''} placeholder="0"
                onChange={e => {
                  const n = e.target.value.replace(/\D/g, '')
                  setByDenom(prev => {
                    const next = { ...prev }
                    if (n === '') delete next[String(d)]
                    else next[String(d)] = Number(n)
                    return next
                  })
                }}
                style={{ width: '100%', minWidth: 0, textAlign: 'right' }} />
            </label>
          ))}
        </div>
      ) : (
        <div>
          <span style={label}>What was in the drawer</span>
          <input className="form-input mono" type="text" inputMode="decimal" autoComplete="off"
            value={plainTotal} placeholder="0.00"
            onChange={e => setPlainTotal(e.target.value.replace(/[^\d.]/g, ''))}
            style={{ width: '100%' }} />
          <div style={{ ...why, marginTop: 4 }}>
            Counting the bills instead records what's actually in there — "$200" made of two $100 bills can't
            break a hundred for a $4 bag of ice.
          </div>
        </div>
      )}

      {entered && (
        <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border-0)' }}>
          <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap' }}>
            <Figure label="You counted" value={money(countedCents)} strong />
            <Figure label={variance === 0 ? 'Balanced' : variance < 0 ? 'Short' : 'Over'}
              value={variance === 0 ? '—' : money(Math.abs(variance))}
              tone={variance === 0 ? 'good' : 'bad'} strong />
            <Figure label="Comes out of the drawer" value={money(Math.max(0, drop))} />
          </div>
          {variance !== 0 && <Leads leads={shift.leads ?? []} varianceCents={variance} />}
          {needsReason && (
            <div style={{ marginTop: 10 }}>
              <span style={label}>What happened?</span>
              <input className="form-input" value={reason} maxLength={500}
                onChange={e => setReason(e.target.value)}
                placeholder="e.g. took $20 for the propane guy, receipt in the drawer"
                style={{ width: '100%' }} />
              <div style={{ ...why, marginTop: 4 }}>
                Anything over {money(threshold)} off needs a note. It still closes either way.
              </div>
            </div>
          )}
        </div>
      )}

      <button className="btn btn-primary" style={{ marginTop: 12 }}
        disabled={busy || !entered || (needsReason && !reason.trim())}
        onClick={async () => {
          setBusy(true)
          try {
            await api.post(`/pos/registers/shifts/${shiftId}/count`, {
              countedCents,
              countedBreakdown: useDenoms ? byDenom : null,
              varianceReason: reason.trim() || null,
            })
            onClosed()
          } catch (e: any) { api.toastError(errText(e)) }
          finally { setBusy(false) }
        }}>
        {busy ? 'Closing…' : `Leave ${money(opening)} and close the shift`}
      </button>
    </div>
  )
}

function Figure({ label: l, value, strong, tone }: {
  label: string; value: string; strong?: boolean; tone?: 'good' | 'bad'
}) {
  return (
    <div>
      <div style={label}>{l}</div>
      <div className="mono" style={{
        fontWeight: strong ? 700 : 600,
        fontSize: strong ? '1.05rem' : '.95rem',
        color: tone === 'bad' ? 'var(--red)' : tone === 'good' ? 'var(--green)' : 'var(--text-0)',
      }}>{value}</div>
    </div>
  )
}

/**
 * 10/31 (Nic): "The bosses are going to want to know where that money went, not
 * that just that it's gone." So the difference is never shown bare — these are
 * the places it could be, cheapest to check first, and an exact match is called
 * out because that is the one you can stop looking after.
 *
 * Nothing here accuses anybody. Each line is a thing that happened, with its
 * amount and its time.
 */
function Leads({ leads, varianceCents }: { leads: any[]; varianceCents: number }) {
  if (!leads?.length) {
    return (
      <div style={{ ...why, marginTop: 10 }}>
        Nothing in this shift accounts for the difference — no ticket left open, no sale rung into another
        drawer, no void. Worth retracing the last few sales.
      </div>
    )
  }
  const exact = leads.filter(l => l.explainsItExactly)
  return (
    <div style={{ marginTop: 10 }}>
      <div style={label}>
        {exact.length ? 'This accounts for it exactly' : `Where ${money(Math.abs(varianceCents))} could be`}
      </div>
      <div style={{ display: 'grid', gap: 6, marginTop: 5 }}>
        {leads.slice(0, 6).map((l, i) => (
          <div key={l.ref ?? i} style={{
            display: 'flex', gap: 8, alignItems: 'baseline',
            padding: '7px 10px', borderRadius: 8, background: 'var(--bg-2)',
            border: l.explainsItExactly ? '1px solid var(--gold)' : '1px solid transparent',
          }}>
            <span className="mono" style={{ fontWeight: 700, color: 'var(--text-0)', flexShrink: 0 }}>
              {money(l.amountCents)}
            </span>
            <span style={{ fontSize: '.8rem', color: 'var(--text-2)', lineHeight: 1.45 }}>{l.what}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

/**
 * Adding a register, and saying what stays in its drawer.
 *
 * 10/31 (Nic): GAM SUGGESTS and a person confirms — "it can suggest $100, but
 * nothing is set in stone. They would have to confirm it." The box is
 * pre-filled with the suggestion and the button says Confirm, because the
 * difference between a suggestion and a default is whether somebody looked.
 *
 * Nothing inherits from the property or the company. His own reason for per
 * register: a second drawer kept for break coverage "doesn't need to be the
 * same across each register at the property."
 */
function NewRegister({ propertyId, api, onMade }: {
  propertyId: string; api: DrawerApi; onMade: () => void
}) {
  const [name, setName] = useState('')
  const [dollars, setDollars] = useState((STARTING_CASH_SUGGESTION_CENTS / 100).toFixed(0))
  const [busy, setBusy] = useState(false)
  const cents = Math.round((Number(dollars) || 0) * 100)
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <div>
        <span style={label}>What is this drawer called?</span>
        <input className="form-input" value={name} maxLength={60}
          onChange={e => setName(e.target.value)}
          placeholder="Register 1, Front Desk, Store…" style={{ width: '100%' }} />
      </div>
      <div>
        <span style={label}>What stays in it</span>
        <input className="form-input mono" type="text" inputMode="decimal" value={dollars}
          onChange={e => setDollars(e.target.value.replace(/[^\d.]/g, ''))} style={{ width: '100%' }} />
        <div style={{ ...why, marginTop: 4 }}>
          A suggestion, not a rule — put whatever this drawer actually keeps. You can say which bills and
          coins once it exists.
        </div>
      </div>
      <button className="btn btn-primary" disabled={busy || !name.trim() || cents < 0}
        onClick={async () => {
          setBusy(true)
          try {
            await api.post('/pos/registers', {
              propertyId, name: name.trim(),
              startingCashCents: cents,
              varianceReasonOverCents: DRAWER_VARIANCE_REASON_SUGGESTION_CENTS,
            })
            onMade()
          } catch (e: any) { api.toastError(errText(e)) }
          finally { setBusy(false) }
        }}>
        Confirm and add it
      </button>
    </div>
  )
}

/** Setting what stays in an existing drawer — a total, or bill by bill. */
function StartingCash({ registerId, api, onSaved }: {
  registerId: string; api: DrawerApi; onSaved: () => void
}) {
  const [byDenom, setByDenom] = useState<Record<string, number>>({})
  const [dollars, setDollars] = useState((STARTING_CASH_SUGGESTION_CENTS / 100).toFixed(0))
  const [useDenoms, setUseDenoms] = useState(false)
  const [busy, setBusy] = useState(false)
  const cents = useDenoms ? cashBreakdownTotalCents(byDenom) : Math.round((Number(dollars) || 0) * 100)
  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
        <button className={`btn btn-sm ${!useDenoms ? 'btn-primary' : 'btn-ghost'}`}
          onClick={() => setUseDenoms(false)}>A total</button>
        <button className={`btn btn-sm ${useDenoms ? 'btn-primary' : 'btn-ghost'}`}
          onClick={() => setUseDenoms(true)}>Bill by bill</button>
      </div>
      {useDenoms ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(118px, 1fr))', gap: 8 }}>
          {CASH_DENOMINATIONS.map(d => (
            <label key={d} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ ...label, width: 58, flexShrink: 0 }}>{CASH_DENOMINATION_LABEL[d] ?? d}</span>
              <input className="form-input mono" type="text" inputMode="numeric" autoComplete="off"
                value={byDenom[String(d)] ?? ''} placeholder="0"
                onChange={e => {
                  const n = e.target.value.replace(/\D/g, '')
                  setByDenom(prev => {
                    const next = { ...prev }
                    if (n === '') delete next[String(d)]
                    else next[String(d)] = Number(n)
                    return next
                  })
                }}
                style={{ width: '100%', minWidth: 0, textAlign: 'right' }} />
            </label>
          ))}
        </div>
      ) : (
        <input className="form-input mono" type="text" inputMode="decimal" value={dollars}
          onChange={e => setDollars(e.target.value.replace(/[^\d.]/g, ''))} style={{ width: '100%' }} />
      )}
      <div style={{ ...why, margin: '6px 0 8px' }}>
        {useDenoms
          ? <>Adds up to <b style={{ color: 'var(--text-0)' }}>{money(cents)}</b>. Saying which bills is worth
              doing — "$200" made of two $100 bills can't break a hundred for a $4 bag of ice.</>
          : <>A suggestion, not a rule. Nothing from the property or the company fills this in.</>}
      </div>
      <button className="btn btn-primary" disabled={busy || cents <= 0}
        onClick={async () => {
          setBusy(true)
          try {
            await api.patch(`/pos/registers/${registerId}`, {
              startingCashCents: cents,
              startingCashBreakdown: useDenoms ? byDenom : null,
            })
            onSaved()
          } catch (e: any) { api.toastError(errText(e)) }
          finally { setBusy(false) }
        }}>
        Confirm {money(cents)} stays in the drawer
      </button>
    </div>
  )
}
