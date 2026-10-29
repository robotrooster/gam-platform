/**
 * 10/17 (Nic) — ONE HOME FOR A TAX RATE, on the page a filing is made from.
 *
 * The lodging rate lived in three places and they drifted: the figure that
 * actually priced a stay sat at 6.35% for three weeks after the named tax was
 * changed to 6.6%, so what the company collected and what it filed did not
 * match. The named tax is the one home now, and this is where the person doing
 * the filing can see and correct it — Nic: "owner AND bookkeeper may change a
 * rate... journal every change with who and when so a filing traces to the
 * rate in force."
 *
 * A rate ticked "charged on a stay here" is what EVERY door prices a stay
 * with — the booking site, a pay link and the front desk all follow it the
 * moment it is saved, and nothing is repriced that was already sold.
 *
 * One of the shared financial pages: the same bytes in the landlord portal and
 * GAM Books (financials-parity.test.ts).
 */
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from 'react-query'
import { finGet, finPatch, toast, toastError } from './adapter'
import { errorWords } from './common'

interface TaxRate {
  id: string
  name: string
  rate: string | number
  propertyId: string | null
  isActive: boolean
  onStays: boolean
}

interface RateChange {
  id: number
  name: string
  oldRate: number | null
  newRate: number | null
  oldIsActive: boolean | null
  newIsActive: boolean | null
  oldOnStays: boolean | null
  newOnStays: boolean | null
  changedAt: string
  changedBy: string | null
  changedByName: string | null
}

/** 0.066 → "6.6%" (and a rate of nothing → "0%"). */
function percent(rate: number | string | null | undefined): string {
  const n = Number(rate ?? 0) * 100
  const s = n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')
  return `${s || '0'}%`
}

/** "Oct 17, 2026 at 9:25 pm" — when the rate changed, in plain words. */
function when(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })} at `
    + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

/** What one journal row says happened, in the words a filing needs. */
function changeWords(c: RateChange): string {
  if (c.oldRate == null) return `Added at ${percent(c.newRate)}`
  if (c.newIsActive === false && c.oldIsActive !== false) return 'Turned off'
  if (c.oldIsActive === false && c.newIsActive) return `Turned back on at ${percent(c.newRate)}`
  if (Number(c.oldRate) !== Number(c.newRate)) return `${percent(c.oldRate)} → ${percent(c.newRate)}`
  if (c.oldOnStays !== c.newOnStays) return c.newOnStays ? 'Now charged on stays here' : 'No longer charged on stays here'
  return 'Changed'
}

export function StayTaxCard({ propertyId }: { propertyId: string }) {
  const qc = useQueryClient()
  const [editing, setEditing] = useState<string | null>(null)
  const [draftPct, setDraftPct] = useState('')

  const propQ = `?propertyId=${propertyId}`
  const { data: rates = [], error } = useQuery<TaxRate[]>(['stay-tax-rates', propertyId],
    () => finGet(`/pos/tax-rates${propQ}`), { enabled: !!propertyId })
  const { data: changes = [] } = useQuery<RateChange[]>(['stay-tax-changes', propertyId],
    () => finGet(`/pos/tax-rates/changes${propQ}`), { enabled: !!propertyId })

  const save = useMutation(
    (v: { id: string; rate: number }) => finPatch(`/pos/tax-rates/${v.id}`, { rate: v.rate }),
    {
      onSuccess: () => {
        setEditing(null)
        qc.invalidateQueries('stay-tax-rates')
        qc.invalidateQueries('stay-tax-changes')
        toast('Saved. Every stay booked from now on is priced with it — nothing already sold is repriced.')
      },
      onError: (e: any) => toastError(errorWords(e, 'Could not save the rate. Try again in a moment.')),
    })

  if (!propertyId) {
    return (
      <div className="card fin-card">
        <div className="fin-card-head">
          <span className="fin-card-title">The rates these taxes are charged at</span>
          <span className="fin-card-note">Pick one property above to see the rates it charges and change one.</span>
        </div>
      </div>
    )
  }

  const live = rates.filter(r => r.isActive !== false)
  const stayRate = live.filter(r => r.onStays).reduce((n, r) => n + Number(r.rate || 0), 0)
  const stayNames = live.filter(r => r.onStays).map(r => r.name)

  return (
    <div className="card fin-card">
      <div className="fin-card-head">
        <span className="fin-card-title">The rates these taxes are charged at</span>
        <span className="fin-card-note">
          One home for every rate: change it here and the whole platform follows, including what a stay is priced at.
        </span>
      </div>

      {error ? <div className="fin-empty">{errorWords(error, 'Could not load the rates.')}</div> : null}

      <table className="data-table">
        <thead><tr>
          <th>Tax</th>
          <th>Charged on</th>
          <th className="fin-num">Rate</th>
          <th />
        </tr></thead>
        <tbody>
          {live.length === 0 ? (
            <tr><td colSpan={4} className="fin-empty">This property has no named taxes yet.</td></tr>
          ) : live.map(r => (
            <tr key={r.id}>
              <td>
                {r.name}
                {r.propertyId ? null : <div className="fin-muted">Set for every property of this company.</div>}
              </td>
              <td>{r.onStays ? 'Stays here, and what it is ticked onto' : 'What it is ticked onto'}</td>
              <td className="fin-num">
                {editing === r.id ? (
                  <input className="form-input fin-date" type="number" min={0} max={100} step="0.01"
                    value={draftPct} autoFocus
                    onChange={e => setDraftPct(e.target.value)} />
                ) : percent(r.rate)}
              </td>
              <td className="fin-row-actions">
                {editing === r.id ? (
                  <>
                    <button type="button" className="btn btn-primary btn-sm"
                      disabled={save.isLoading || draftPct === '' || Number(draftPct) < 0 || Number(draftPct) > 100}
                      onClick={() => save.mutate({ id: r.id, rate: Number(draftPct) / 100 })}>
                      {save.isLoading ? 'Saving…' : 'Save rate'}
                    </button>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(null)}>Cancel</button>
                  </>
                ) : (
                  <button type="button" className="btn btn-primary btn-sm"
                    onClick={() => { setEditing(r.id); setDraftPct(String(+(Number(r.rate || 0) * 100).toFixed(4))) }}>
                    Change rate
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <p className="fin-muted" style={{ padding: '0 16px 4px' }}>
        {stayNames.length
          ? `A stay at this property is priced at ${percent(stayRate)} — ${stayNames.join(' + ')}. `
            + 'The booking site, a pay link and the front desk all quote that one rate; a stay already priced keeps the rate it was sold with.'
          : 'No tax is charged on stays at this property. The register\'s Taxes screen is where a tax is made and ticked "charged on a stay here".'}
      </p>

      {changes.length ? (
        <div style={{ padding: '6px 16px 14px' }}>
          <div className="fin-field-label" style={{ marginBottom: 6 }}>Every change, so a filing traces to the rate in force</div>
          <table className="data-table">
            <thead><tr>
              <th>Tax</th>
              <th>What changed</th>
              <th>Who</th>
              <th>When</th>
            </tr></thead>
            <tbody>
              {changes.map(c => (
                <tr key={c.id}>
                  <td>{c.name}</td>
                  <td>{changeWords(c)}</td>
                  <td>{c.changedByName || (c.changedBy ? 'Someone at this company' : 'GAM')}</td>
                  <td>{when(c.changedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  )
}
