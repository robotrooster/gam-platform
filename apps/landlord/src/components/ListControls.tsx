import { useEffect, useState } from 'react'
import { Search } from 'lucide-react'

// S576: shared list-page controls — one search box + one property dropdown,
// reused across Units, Tenants, Leases, E-Sign, and Payments so big landlords
// (500+ tenants, many properties) can find rows fast. Each page owns its own
// `.filter-bar` wrapper and any extra chips; these are the two common pieces.

export type PropertyOption = { id: string; name: string }

/** Search input with the leading magnifier icon (matches globals.css). */
export function SearchBox({
  value, onChange, placeholder = 'Search…', width,
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  /** Optional fixed width; defaults to the flexible `.search-wrap` (min 200px). */
  width?: number
}) {
  return (
    <div className="search-wrap" style={width ? { flex: 'none', width, minWidth: width } : undefined}>
      <Search className="search-icon" />
      <input
        className="search-input"
        placeholder={placeholder}
        value={value}
        onChange={e => onChange(e.target.value)}
      />
    </div>
  )
}

/**
 * "All properties / <property>" dropdown. `value` is the selected propertyId
 * ('' = all). Options are deduped + sorted by name so callers can pass a raw
 * list (e.g. derived from row data) without pre-processing.
 */
export function PropertySelect({
  value, onChange, properties, allLabel = 'All properties',
}: {
  value: string
  onChange: (propertyId: string) => void
  properties: PropertyOption[]
  allLabel?: string
}) {
  const seen = new Set<string>()
  const opts = properties
    .filter(p => p && p.id && !seen.has(p.id) && (seen.add(p.id), true))
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''))

  // A single-property landlord doesn't need the filter — hide it.
  if (opts.length < 2) return null

  return (
    <select
      className="form-input"
      style={{ width: 'auto', minWidth: 160 }}
      value={value}
      onChange={e => onChange(e.target.value)}
    >
      <option value="">{allLabel}</option>
      {opts.map(p => (
        <option key={p.id} value={p.id}>{p.name}</option>
      ))}
    </select>
  )
}

// ── S639: PROPERTY-SCOPED SURFACES ───────────────────────────────────────
//
// Nic (DIRECTIVE, verbatim): "There should never be a way to look up a specific
// unit unless you are inside the window to that property. I don't wanna be
// looking up all the freaking mobile home number fives between all fifteen of
// my properties."
//
// Unit numbers REPEAT across parks — MH 5 exists at every one of them — so a
// portfolio-wide unit list is not a convenience, it is a way to act on the
// wrong space. The same goes for the master schedule: fifteen parks' worth of
// spots on one timeline is unreadable and unusable.
//
// This is deliberately NOT applied to the money lists (Balances, Payments,
// Disbursements). Those are keyed to a PERSON and a dollar amount, both unique
// across the portfolio, and Nic asked for the cross-property view there.

/**
 * Property picker with no "All properties" escape hatch — the caller must be
 * inside one property's window. A single-property account never sees a control
 * (there is nothing to choose); `usePropertyScope` selects it automatically.
 */
export function RequiredPropertySelect({
  value, onChange, properties,
}: {
  value: string
  onChange: (propertyId: string) => void
  properties: PropertyOption[]
}) {
  const seen = new Set<string>()
  const opts = properties
    .filter(p => p && p.id && !seen.has(p.id) && (seen.add(p.id), true))
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''))

  if (opts.length < 2) return null

  return (
    <select
      className="form-input"
      style={{ width: 'auto', minWidth: 180, fontWeight: 600 }}
      value={value}
      onChange={e => onChange(e.target.value)}
    >
      <option value="" disabled>Choose a property…</option>
      {opts.map(p => (
        <option key={p.id} value={p.id}>{p.name}</option>
      ))}
    </select>
  )
}

/**
 * The chosen property, remembered. Picking a park once should hold across
 * pages and across sessions — onboarding is one unit after another inside the
 * SAME park, and re-picking it every screen is the friction Nic is describing.
 *
 * A one-property account auto-selects and never sees a chooser. `seedFromUrl`
 * lets a deep link (?property=<id>) win on first render.
 */
export function usePropertyScope(
  storageKey: string,
  options: PropertyOption[],
  seedFromUrl?: string | null,
): [string, (id: string) => void] {
  const [id, setIdState] = useState<string>(() => {
    if (seedFromUrl) return seedFromUrl
    try { return localStorage.getItem(storageKey) || '' } catch { return '' }
  })

  const setId = (next: string) => {
    setIdState(next)
    try { localStorage.setItem(storageKey, next) } catch { /* private mode */ }
  }

  const ids = options.filter(p => p && p.id).map(p => p.id)
  const unique = Array.from(new Set(ids))

  useEffect(() => {
    if (unique.length === 0) return
    // Exactly one property: there is nothing to choose, so choose it.
    if (unique.length === 1 && id !== unique[0]) { setId(unique[0]); return }
    // A remembered property that this account can no longer see (sold,
    // transferred, scope changed) must not leave the page permanently blank.
    if (id && !unique.includes(id)) setId('')
  }, [unique.join(','), id])

  return [id, setId]
}
