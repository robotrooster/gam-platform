/**
 * 10/13 (Nic): "each expense is chosen on the split or specific unit or
 * property at the time of logging. there should never be a default setting to
 * apply expenses." Payroll, loan interest and depreciation are logged by a
 * person too, so the Run Payroll, Loans and Fixed assets forms ask the same
 * thing when a record is logged: where its cost goes — split across the
 * company's properties by units, one property, or one unit
 * (BOOKS_COST_PLACES). Nothing is chosen for the person: the form starts
 * blank and does not save until it is answered (the API refuses it too).
 *
 * Same bytes in apps/books and apps/landlord (bookkeeping-parity.test.ts).
 */
import { useQuery } from 'react-query'
import { BOOKS_COST_PLACES, BOOKS_COST_PLACE_LABEL, type BooksCostPlace } from '@gam/shared'
import { booksGet as get } from './adapter'

export interface CostPlaceProperty { id: string; name: string; units: { id: string; unitNumber: string }[] }
export interface CostPlaceValue { costPlace: BooksCostPlace | ''; propertyId: string; unitId: string }
export const BLANK_COST_PLACE: CostPlaceValue = { costPlace: '', propertyId: '', unitId: '' }

/**
 * The company's properties and their units (GET /books/cost-places), and
 * whether the question is asked at all — a business's books have no
 * properties, so nothing is asked of a business.
 */
export function useCostPlaces(): { properties: CostPlaceProperty[]; asked: boolean } {
  const { data } = useQuery('booksCostPlaces',
    () => get<{ properties: CostPlaceProperty[]; asked: boolean }>('/books/cost-places'))
  return { properties: data?.properties ?? [], asked: data?.asked ?? true }
}

/** A saved record's place, for its edit form (one logged before 10/13 with no property asks again). */
export function costPlaceOf(r: { costPlace?: string | null; propertyId?: string | null; unitId?: string | null } | null | undefined): CostPlaceValue {
  if (!r) return BLANK_COST_PLACE
  const place = (r.costPlace as BooksCostPlace | null | undefined) ?? (r.unitId ? 'unit' : r.propertyId ? 'property' : '')
  return { costPlace: place, propertyId: r.propertyId ?? '', unitId: r.unitId ?? '' }
}

/** Fully answered: a place, and the property or unit it names. */
export function costPlaceChosen(v: CostPlaceValue): boolean {
  if (v.costPlace === 'split_by_units') return true
  if (v.costPlace === 'property') return !!v.propertyId
  if (v.costPlace === 'unit') return !!v.unitId
  return false
}

/** The place as the API takes it. */
export function costPlaceBody(v: CostPlaceValue): { costPlace: BooksCostPlace | null; propertyId: string | null; unitId: string | null } {
  return {
    costPlace: v.costPlace || null,
    propertyId: v.costPlace === 'property' || v.costPlace === 'unit' ? v.propertyId || null : null,
    unitId: v.costPlace === 'unit' ? v.unitId || null : null,
  }
}

/** What each place means for the cost, in words. */
const PLACE_HELP: Record<BooksCostPlace, string> = {
  split_by_units: 'Shared by every property, by how many units each has.',
  property: 'All of it on one property.',
  unit: 'All of it on one unit.',
}

/**
 * The question itself. `what` names the cost ("its interest", "the wages and
 * employer taxes"); `fixedPropertyId` keeps the property (an asset made from
 * an expense sits where the expense was filed); `allowed` narrows the places.
 */
export function CostPlaceField({ value, onChange, properties, what, allowed, fixedPropertyId, name = 'costPlace' }: {
  value: CostPlaceValue; onChange: (v: CostPlaceValue) => void; properties: CostPlaceProperty[]; what: string
  allowed?: readonly BooksCostPlace[]; fixedPropertyId?: string | null; name?: string
}) {
  const places = BOOKS_COST_PLACES.filter(p => !allowed || allowed.includes(p))
  const propertyId = fixedPropertyId ?? value.propertyId
  const units = properties.find(p => p.id === propertyId)?.units ?? []
  const pick = (costPlace: BooksCostPlace) => onChange({
    costPlace,
    propertyId: costPlace === 'split_by_units' ? '' : fixedPropertyId ?? value.propertyId,
    unitId: costPlace === 'unit' ? value.unitId : '',
  })
  return (
    <div className="frow">
      <label>Where {what} goes</label>
      {places.map(p => (
        <label key={p} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', textTransform: 'none', letterSpacing: 0, fontWeight: 400, fontSize: '.8rem', color: 'var(--t1)', marginBottom: 6, cursor: 'pointer' }}>
          <input type="radio" name={name} value={p} checked={value.costPlace === p} onChange={() => pick(p)}
            style={{ width: 'auto', marginTop: 3, accentColor: 'var(--gold)' }} />
          <span><span style={{ fontWeight: 600, color: 'var(--t0)' }}>{BOOKS_COST_PLACE_LABEL[p]}</span>
            <span style={{ display: 'block', fontSize: '.72rem', color: 'var(--t3)' }}>{PLACE_HELP[p]}</span></span>
        </label>
      ))}
      {(value.costPlace === 'property' || value.costPlace === 'unit') && (
        <div className="frow2" style={{ marginTop: 4 }}>
          <div><label>Property</label>
            <select value={propertyId} disabled={!!fixedPropertyId} required
              onChange={e => onChange({ ...value, propertyId: e.target.value, unitId: '' })}>
              <option value="">Choose the property</option>
              {properties.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          {value.costPlace === 'unit' && <div><label>Unit</label>
            <select value={value.unitId} disabled={!propertyId} required onChange={e => onChange({ ...value, propertyId, unitId: e.target.value })}>
              <option value="">Choose the unit</option>
              {units.map(u => <option key={u.id} value={u.id}>Unit {u.unitNumber}</option>)}
            </select>
          </div>}
        </div>
      )}
    </div>
  )
}
