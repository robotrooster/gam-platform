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
