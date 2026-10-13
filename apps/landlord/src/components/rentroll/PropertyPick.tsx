import { useQuery } from 'react-query'
import { Building2 } from 'lucide-react'
import type { RentRollProperty, RentRollResident } from '@gam/shared'
import { api } from '../../lib/api'
import './rentroll.css'

/**
 * 10/13 (Nic) — ONE PROPERTY AT A TIME, PICKED FIRST.
 *
 *   "I don't like having Mountain View and Oak Park options right next to each
 *    other at the top I want them inside of the view right like you you click
 *    into the property and then toggle the view that you want to see."
 *   Answered 10/13: "Always pick first" — the page asks which property every
 *   time, EXCEPT a company with only one property opens straight to it.
 *
 * The list is the server's (GET /api/balances/rent-roll/properties: the
 * properties the viewer may see, by name).
 */
export function useRentRollProperties() {
  return useQuery(['rent-roll-properties'],
    () => api.get('/balances/rent-roll/properties').then(r => r.data.data as RentRollProperty[]), {
      staleTime: 60_000,
      // A refusal (no "View all payments") will not change on a retry: say it at once.
      retry: (count: number, e: any) => { const st = e?.response?.status; return !(st >= 400 && st < 500) && count < 2 },
    })
}

/**
 * The property the page shows: the one the address names when the viewer may
 * see it (while the list loads, trusted — the server answers 404 for any
 * other), else the only one when there is just one; null asks.
 */
export function chosenProperty(asked: string | null, list: readonly RentRollProperty[] | undefined): string | null {
  if (asked && (!list || list.some(p => p.propertyId === asked))) return asked
  return list && list.length === 1 ? list[0].propertyId : null
}

/** The pick itself: every property by name, one line each. */
export function PropertyPickList({ properties, onPick }: { properties: readonly RentRollProperty[]; onPick: (propertyId: string) => void }) {
  return (
    <div className="card rrh-picker">
      <div className="rrh-picker-title">Pick a property</div>
      {properties.map(p => (
        <button key={p.propertyId} type="button" className="rrh-prop" onClick={() => onPick(p.propertyId)}>
          <Building2 size={15} style={{ color: 'var(--gold)', flex: '0 0 auto' }} />
          <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{p.name}</span>
          <span className="rrh-prop-meta">
            {p.owned ? `${p.spaces} space${p.spaces === 1 ? '' : 's'}` : 'No longer yours · bills from before'}
          </span>
        </button>
      ))}
    </div>
  )
}

/** The household's name on a row: its primary resident (everyone on hover). */
export function householdName(residents: readonly RentRollResident[]): string {
  const primary = residents.find(r => r.primary) ?? residents[0]
  return primary?.name || 'No resident named'
}
export function householdNames(residents: readonly RentRollResident[]): string {
  return residents.map(r => r.name).filter(Boolean).join(', ')
}

/**
 * The tenant report a name opens (10/13: "Clicking the NAME opens the tenant
 * report") — that row's household, i.e. its lease ("when someone is renting 2
 * spots with 2 leases it is 2 households"). null when the row names nobody.
 */
export function reportPath(row: { householdId: string | null; leaseId: string | null }): string | null {
  if (!row.householdId) return null
  return `/tenants/${row.householdId}/report${row.leaseId ? `?leaseId=${encodeURIComponent(row.leaseId)}` : ''}`
}
