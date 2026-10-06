import { WORK_TRADE_COVERABLE, WORK_TRADE_COVERABLE_LABEL, type WorkTradeCoverable } from '@gam/shared'

/**
 * 10/6 (Nic) — THE WORK-TRADE PICKER, one for every door that makes one.
 *
 *   "Can I mark somebody as work trade through the reservation flow? Hey,
 *    they're going to be staying for two months. Mark them as work trade. Boom."
 *
 * He chose: the trade covers EVERYTHING by default (untick any), and the hours
 * are "a per property setting with monitored or trusted setting for that user".
 * The invite (Tenant Onboarding → Add one tenant) and the schedule's
 * reservation form and edit use this same component; the server applies the
 * same rules to what it sends (services/stayWorkTrade workTradeTermsSchema).
 */
export interface WorkTradeTerms {
  coveredCharges: WorkTradeCoverable[]
  tracksHours: boolean
  /** Blank = the property's work-trade hours setting. */
  hoursTarget: string
  duties: string
  /** Monitored (false) — you approve their hours; trusted (true) — their hours count as logged. */
  trusted: boolean
}

export const defaultWorkTradeTerms = (): WorkTradeTerms => ({
  coveredCharges: [...WORK_TRADE_COVERABLE], tracksHours: true, hoursTarget: '', duties: '', trusted: false,
})

/** What a save sends for these terms (the API's names). */
export function workTradeTermsPayload(t: WorkTradeTerms, o: { trusted?: boolean } = {}) {
  return {
    coveredCharges: t.coveredCharges,
    tracksHours: t.tracksHours,
    hoursTarget: t.tracksHours && Number(t.hoursTarget) > 0 ? Math.floor(Number(t.hoursTarget)) : null,
    duties: t.duties.trim() || null,
    ...(o.trusted === false ? {} : { trusted: t.trusted }),
  }
}

/**
 * 10/6 (review): the `workTrade` a reservation EDIT sends — or nothing.
 * Only a desk that may change work trades sends it, and only when the tick or
 * the terms changed: the server refuses the field from anyone without that
 * permission, so sending it unchanged would stop a front desk from saving a
 * traded reservation's notes or dates at all. Ticked off on a traded stay →
 * null (the trade ends).
 */
export function workTradeEditPayload(o: {
  canManage: boolean; ticked: boolean; terms: WorkTradeTerms; original: any
}): { workTrade?: ReturnType<typeof workTradeTermsPayload> | null } {
  if (!o.canManage) return {}
  if (!o.ticked) return o.original ? { workTrade: null } : {}
  const next = workTradeTermsPayload(o.terms)
  if (o.original && JSON.stringify(workTradeTermsPayload(workTradeTermsFrom(o.original))) === JSON.stringify(next)) return {}
  return { workTrade: next }
}

/** Terms as a stay's work trade reads back from the schedule. */
export function workTradeTermsFrom(row: any): WorkTradeTerms {
  if (!row) return defaultWorkTradeTerms()
  const covered = (row.coveredCharges ?? row.covered_charges ?? []) as string[]
  return {
    coveredCharges: WORK_TRADE_COVERABLE.filter(k => covered.includes(k)),
    tracksHours: (row.tracksHours ?? row.tracks_hours) !== false,
    hoursTarget: String(row.monthlyHoursTarget ?? row.monthly_hours_target ?? ''),
    duties: row.duties ?? '',
    trusted: row.trusted === true,
  }
}

/** "everything" or "Rent, Electric, …" — the words a reservation's details show. */
export function workTradeCoversWords(covered: readonly string[]): string {
  if (WORK_TRADE_COVERABLE.every(k => covered.includes(k))) return 'everything'
  return WORK_TRADE_COVERABLE.filter(k => covered.includes(k)).map(k => WORK_TRADE_COVERABLE_LABEL[k]).join(', ') || 'nothing'
}

/** "Work trade — covers: Rent, Electric, trusted" */
export function workTradeLine(row: { coveredCharges?: string[]; covered_charges?: string[]; trusted?: boolean } | null | undefined): string | null {
  if (!row) return null
  const covered = (row.coveredCharges ?? row.covered_charges ?? []) as string[]
  return `Work trade — covers: ${workTradeCoversWords(covered)}, ${row.trusted ? 'trusted' : 'monitored'}`
}

const small: React.CSSProperties = { fontSize: '.72rem', color: 'var(--text-2)', lineHeight: 1.5 }

export function WorkTradeTermsFields({ value, onChange, showCovered = true, showTrusted = true, propertyHours }: {
  value: WorkTradeTerms
  onChange: (next: WorkTradeTerms) => void
  /** What it covers (every door that makes an agreement). */
  showCovered?: boolean
  /** Monitored or trusted for this person. */
  showTrusted?: boolean
  /** The property's work-trade hours setting, for the placeholder. */
  propertyHours?: number | null
}) {
  const set = (patch: Partial<WorkTradeTerms>) => onChange({ ...value, ...patch })
  const toggle = (k: WorkTradeCoverable) => set({
    coveredCharges: value.coveredCharges.includes(k)
      ? value.coveredCharges.filter(x => x !== k)
      : WORK_TRADE_COVERABLE.filter(x => x === k || value.coveredCharges.includes(x)),
  })
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      {showCovered && (
        <div>
          <div style={{ fontSize: '.74rem', color: 'var(--text-1)', marginBottom: 4 }}>What it covers</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 14px' }}>
            {WORK_TRADE_COVERABLE.map(k => (
              <label key={k} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '.76rem', cursor: 'pointer' }}>
                <input type="checkbox" checked={value.coveredCharges.includes(k)} onChange={() => toggle(k)} />
                {WORK_TRADE_COVERABLE_LABEL[k]}
              </label>
            ))}
          </div>
          <div style={{ ...small, marginTop: 3, color: value.coveredCharges.length ? 'var(--text-3)' : 'var(--amber)' }}>
            {value.coveredCharges.length
              ? 'Anything unticked is billed in full.'
              : 'Pick at least one thing the work trade covers.'}
          </div>
        </div>
      )}
      {showTrusted && (
        <div style={{ display: 'grid', gap: 4 }}>
          {([[false, 'Monitored', 'You approve the hours they log.'],
             [true, 'Trusted', 'Their hours count as soon as they log them.']] as const).map(([on, title, body]) => (
            <label key={title} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', cursor: 'pointer' }}>
              <input type="radio" checked={value.trusted === on} onChange={() => set({ trusted: on })} style={{ marginTop: 3 }} />
              <div>
                <div style={{ fontSize: '.78rem', color: 'var(--text-0)' }}>{title}</div>
                <div style={small}>{body}</div>
              </div>
            </label>
          ))}
        </div>
      )}
      {/* S637 (Nic): the parent switch, above the hours it governs. */}
      <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', cursor: 'pointer' }}>
        <input type="checkbox" checked={value.tracksHours} onChange={e => set({ tracksHours: e.target.checked })}
          style={{ marginTop: 3, flexShrink: 0 }} />
        <div>
          <div style={{ fontSize: '.78rem', color: 'var(--text-0)' }}>Track hours</div>
          <div style={small}>
            {value.tracksHours
              ? 'They log hours each month.'
              : 'No hours logged — what it covers clears every month.'}
          </div>
        </div>
      </label>
      <div>
        <label style={{ fontSize: '.72rem', color: 'var(--text-2)', display: 'block', marginBottom: 3 }}>Hours per month</label>
        <input className="form-input" type="number" min={1} max={400} style={{ maxWidth: 180 }}
          placeholder={propertyHours ? `property setting (${propertyHours})` : 'property setting'}
          disabled={!value.tracksHours}
          value={value.tracksHours ? value.hoursTarget : ''}
          onChange={e => set({ hoursTarget: e.target.value })} />
      </div>
      <div>
        <label style={{ fontSize: '.72rem', color: 'var(--text-2)', display: 'block', marginBottom: 3 }}>Duties (optional)</label>
        <input className="form-input" placeholder="e.g. grounds, laundry room, snow"
          value={value.duties} onChange={e => set({ duties: e.target.value })} />
      </div>
    </div>
  )
}
