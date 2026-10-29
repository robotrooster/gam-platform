/**
 * S629 (Nic): "a property selector or entity selector, to view the transaction
 * logs and stuff specific to that entity."
 *
 * Banking is anchored per ENTITY — each LLC keeps its own Connect account and
 * its own bank — so an entity is the honest unit here, not a property. A
 * property inherits its owning entity's bank, and showing a property selector
 * over per-entity money would invite exactly the merge that caused the
 * mis-filing this session: two properties under one LLC genuinely share one
 * account, and pretending otherwise would be a distinction nobody can act on.
 *
 * Renders nothing for a single-entity portfolio. One option is not a choice,
 * and a control that can only be set one way is noise on the page.
 */
import { useEffect } from 'react'
import { useQuery } from 'react-query'
import { finGet, useIsBookkeeper, pinnedCompanyId } from './adapter'

export interface EntityOption {
  id: string
  businessName?: string | null
  propertyCount?: number
  /**
   * 10/23 — OWNED, OR MANAGED FOR SOMEBODY ELSE. The third-party management
   * portal folded into this one, so one account holds both: Blu owns Country
   * Acres and manages Oak Park for its owner. Absent on a pass from before
   * this, which reads as owned — which it was.
   */
  role?: 'owner' | 'manager'
  /** The management company the access came through, when it came through one. */
  viaPmCompanyId?: string | null
}

// 10/11: a bookkeeper keeps one company's books and is never asked which; the
// company list is the owner's, so it is not even fetched for them. An app that
// has ONE company open (GAM Books) lists that company alone, so its pages never
// ask "which company?" — or offer one the open books are not about.
export function useEntities() {
  const isBookkeeper = useIsBookkeeper()
  const pinned = pinnedCompanyId()
  return useQuery<EntityOption[]>('landlord-entities', () => finGet<EntityOption[]>('/landlords/me/entities'),
    { enabled: !isBookkeeper, select: list => pinned ? list.filter(en => en.id === pinned) : list })
}

/**
 * S654 (NO DEFAULT COMPANY): true while an account that owns several companies
 * has not named one. Gates the actions that would land data in a company. Team
 * logins get a 403 on the entities list, so they read as an empty list and are
 * never blocked — the server derives their company.
 */
export function useCompanyMissing(value: string): boolean {
  const { data: entities = [] } = useEntities()
  return entities.length > 1 && !value
}

/** Owned first, then managed. The order is the point, so it is written once. */
const OWNED_FIRST = [
  { role: 'owner' as const, heading: 'Companies you own' },
  { role: 'manager' as const, heading: 'Companies you manage for others' },
]

export function EntityPicker({ value, onChange, label = 'Company', note, disabled }: {
  value: string
  onChange: (id: string) => void
  label?: string
  /** S654: locked while a request for the chosen company is in flight. */
  disabled?: boolean
  /**
   * S633: the trailing sentence explaining WHY the choice matters here. The
   * default is about banking, which is where this control started; a CSV import
   * or a tax statement needs a different reason, and a wrong reason is worse
   * than none.
   */
  note?: string
}) {
  const { data: entities = [] } = useEntities()

  // Land on something real before the first fetch resolves, so the page never
  // queries with an empty entity and shows a blank feed that looks like "no
  // transactions" rather than "nothing selected yet".
  useEffect(() => {
    // S654 (Nic, DIRECTIVE): "None is the default." One company needs no
    // choosing; two or more start on "Choose a company" — the first in the
    // list is not a default.
    if (!value && entities.length === 1) onChange(entities[0].id)
  }, [entities, value, onChange])

  if (entities.length < 2) return null

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
      <label className="form-label" style={{ margin: 0, fontSize: '.72rem' }}>{label}</label>
      <select className="input" style={{ width: 'auto', minWidth: 240 }} disabled={disabled}
              value={value} onChange={e => onChange(e.target.value)}>
        <option value="">Choose a company…</option>
        {/* 10/23: owned companies and managed ones are different kinds of
            answer — "what did I earn" against "what did I earn managing" — so
            they are grouped rather than mixed into one list. A portfolio with
            no managed company renders exactly as it did. */}
        {OWNED_FIRST.map(group => {
          const inGroup = entities.filter(en => (en.role ?? 'owner') === group.role)
          if (!inGroup.length) return null
          const label = (en: EntityOption) =>
            `${en.businessName || 'Unnamed company'}${en.propertyCount
              ? ` — ${en.propertyCount} propert${en.propertyCount === 1 ? 'y' : 'ies'}` : ''}`
          // One kind only: no heading to explain, so the list stays plain.
          if (inGroup.length === entities.length) {
            return inGroup.map(en => <option key={en.id} value={en.id}>{label(en)}</option>)
          }
          return (
            <optgroup key={group.role} label={group.heading}>
              {inGroup.map(en => <option key={en.id} value={en.id}>{label(en)}</option>)}
            </optgroup>
          )
        })}
      </select>
      <span style={{ fontSize: '.7rem', color: 'var(--text-3)' }}>
        {note ?? 'Each company has its own bank account and its own transactions.'}
      </span>
    </div>
  )
}
