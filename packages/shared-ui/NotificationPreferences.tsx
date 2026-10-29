/**
 * ONE NOTIFICATION SETTINGS LIST, EVERY PORTAL.
 *
 * 10/20 (Nic): "I want you to build every notification category in the settings
 * page and turn off the ones that are non-critical... I would add everything to
 * the list, but the five critical ones make it not checkable so that they can
 * see that they will still get those emails. That way it's not like, I thought I
 * turned it off, blah, blah, blah. Like, I'm still getting these emails. Make it
 * known that that's the ones that they're still going to get on those rare
 * instances where it happens."
 *
 * And why this is one component rather than a third hand-written list: "I don't
 * want you to switch off three remaining email settings when you said there's
 * five critical things and 22 other ones that weren't even on the list. Like,
 * you're thinking too narrow. I want you to fix the root."
 *
 * There were THREE lists before this — landlord Settings, tenant Profile, and a
 * second tenant page — each a hand-typed subset of the types GAM actually sends.
 * Every row here comes from NOTIFICATION_CATALOG in @gam/shared, so a type that
 * can be sent cannot be missing from the screen.
 *
 * Styling sticks to what both portals define: the `card` and `btn btn-primary`
 * classes and the shared color variables (text, bg, border-0, gold, green, red).
 * The table itself is styled inline because `data-table` is a landlord-only
 * class.
 */
import { Fragment, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { Bell, Check, Lock, AlertTriangle } from 'lucide-react'
import {
  notificationGroupsFor, isCriticalNotificationType,
  type NotificationCatalogEntry,
} from '@gam/shared'

export type NotificationPrefsApi = {
  get:   (url: string) => Promise<any>
  patch: (url: string, body: any) => Promise<any>
}

type Choice = { email: boolean; inApp: boolean }

/** One stored row, read whichever way the portal's interceptor cased it. */
function storedChoice(row: any): Choice {
  return {
    email: row?.emailEnabled ?? row?.email_enabled ?? true,
    inApp: row?.inAppEnabled ?? row?.in_app_enabled ?? true,
  }
}

/**
 * What went wrong, in a sentence a person can act on. Never the raw object —
 * and never a native dialog (memory: gam-no-native-dialogs), so it renders in
 * the row and in the card.
 */
function saveFailureText(e: unknown): string {
  const msg = (e as any)?.response?.data?.error
    ?? (e as any)?.response?.statusText
    ?? (e as any)?.message
  return typeof msg === 'string' && msg.trim()
    ? `Not saved — ${msg.trim()}. Try again.`
    : 'Not saved — GAM could not reach the server. Try again.'
}

export function NotificationPreferences({
  audience, api, isAccountHolder = true, queryKey = 'notification-prefs', title,
}: {
  audience: 'landlord' | 'tenant'
  api: NotificationPrefsApi
  /** False for a team member: hides the switches only the account holder's own notices use. */
  isAccountHolder?: boolean
  queryKey?: string
  /** Heading. Omit on a page that already has one. */
  title?: string
}) {
  const qc = useQueryClient()
  const { data: prefs = [], isLoading } = useQuery<any[]>(queryKey, () => api.get('/notifications/preferences'))

  // The answer the person just gave, held until the refetch catches up. Without
  // it the box snaps back to the old value for a moment, which is what makes
  // someone click it a second time — and a second click on an unsaved box turns
  // the email back ON. Three of a landlord's rows read email-on for exactly
  // that reason after he sat and unchecked everything.
  const [mine, setMine] = useState<Record<string, Choice>>({})
  const [busy, setBusy] = useState<Record<string, true>>({})
  const [justSaved, setJustSaved] = useState<Record<string, true>>({})
  const [bulkBusy, setBulkBusy] = useState(false)
  // 10/20: WHAT A FAILED SAVE LOOKS LIKE.
  //
  // There was no catch here at all. A PATCH that returned 500, or a connection
  // that dropped, left the optimistic value sitting in `mine` — so the box
  // rendered unchecked, the counter dropped, nothing said a word, and the
  // server still had email ON. He keeps getting the email while the page says
  // it is off: the same end state as the double-click race this page was built
  // to fix, reached from the other direction. A failed save now puts the box
  // back where it was and says so, in the row and on the card.
  const [failed, setFailed] = useState<Record<string, string>>({})
  const [bulkFailed, setBulkFailed] = useState<string | null>(null)

  const stored = new Map<string, Choice>()
  for (const row of (prefs as any[])) if (row?.type) stored.set(row.type, storedChoice(row))

  // No stored answer means GAM's default, which is on. That default is only
  // honest because every type GAM can send has a row on this page now — the
  // landlord can always answer. It is not a claim that silence means yes.
  const choiceFor = (type: string): Choice =>
    mine[type] ?? stored.get(type) ?? { email: true, inApp: true }

  const save = useMutation((body: any) => api.patch('/notifications/preferences', body), {
    onSettled: () => qc.invalidateQueries(queryKey),
  })

  /** Forget the optimistic value for these types, so the stored row shows again. */
  function rollBack(types: string[], before: Record<string, Choice>) {
    setMine(m => {
      const next = { ...m }
      for (const t of types) {
        if (t in before) next[t] = before[t]!
        else delete next[t]
      }
      return next
    })
  }

  async function setOne(entry: NotificationCatalogEntry, next: Choice) {
    if (isCriticalNotificationType(entry.type) || busy[entry.type]) return
    const before = { ...mine }
    setMine(m => ({ ...m, [entry.type]: next }))
    setBusy(b => ({ ...b, [entry.type]: true }))
    setFailed(f => { const { [entry.type]: _drop, ...rest } = f; return rest })
    try {
      await save.mutateAsync({ type: entry.type, emailEnabled: next.email, inAppEnabled: next.inApp })
      setJustSaved(s => ({ ...s, [entry.type]: true }))
      setTimeout(() => setJustSaved(s => { const { [entry.type]: _drop, ...rest } = s; return rest }), 2000)
    } catch (e) {
      rollBack([entry.type], before)
      setFailed(f => ({ ...f, [entry.type]: saveFailureText(e) }))
    } finally {
      setBusy(b => { const { [entry.type]: _drop, ...rest } = b; return rest })
    }
  }

  const groups = notificationGroupsFor(audience, { isAccountHolder })
  const optional = groups.flatMap(g => g.entries).filter(e => !isCriticalNotificationType(e.type))
  // 10/20: only the rows that CAN email are counted, and only they get a box.
  // Thirty of these notices are written in the app and emailed nowhere — a box
  // on those did nothing when it was unticked, and they inflated "N of M
  // optional emails are on" with rows that were never emails. Nic's words when
  // three dead types were retired: "a box for mail that cannot arrive is
  // noise." Same rule, applied to the rest of them.
  const emailable = optional.filter(e => !e.inAppOnly)
  const emailOn = emailable.filter(e => choiceFor(e.type).email)
  const allOff  = emailOn.length === 0

  /**
   * 10/20 (Nic): the point of the page. Turning everything off has to record an
   * answer for EVERY optional type in one go — one request, not one per row —
   * because a page that saves most of them is how someone ends up still getting
   * email from the ones that never saved.
   */
  async function setAllEmail(on: boolean) {
    setBulkBusy(true)
    setBulkFailed(null)
    const before = { ...mine }
    const updates = emailable.map(e => {
      const c = choiceFor(e.type)
      return { type: e.type, emailEnabled: on, inAppEnabled: c.inApp }
    })
    const next: Record<string, Choice> = {}
    for (const u of updates) next[u.type] = { email: on, inApp: u.inAppEnabled }
    setMine(m => ({ ...m, ...next }))
    try {
      // 300 at a time is the route's limit; the catalog is well under it today
      // and this keeps working if it doubles.
      for (let i = 0; i < updates.length; i += 300) {
        await save.mutateAsync({ updates: updates.slice(i, i + 300) })
      }
    } catch (e) {
      // Every box goes back to the stored answer and the refetch (onSettled)
      // brings whatever the server really holds. The button must never be left
      // reading "Turn every optional email back on" over nothing saved.
      rollBack(updates.map(u => u.type), before)
      setBulkFailed(saveFailureText(e))
    } finally { setBulkBusy(false) }
  }

  const th: React.CSSProperties = {
    padding: '10px 14px', fontSize: '.68rem', fontWeight: 700, color: 'var(--text-3)',
    textTransform: 'uppercase', letterSpacing: '.06em', borderBottom: '1px solid var(--border-0)',
    textAlign: 'left', background: 'var(--bg-2)',
  }
  const td: React.CSSProperties = { padding: '11px 14px', borderBottom: '1px solid var(--border-0)', verticalAlign: 'top' }
  const cell: React.CSSProperties = { ...td, textAlign: 'center', width: 96 }

  return (
    <div>
      {title && (
        <div className="card-header" style={{ marginBottom: 12 }}>
          <span className="card-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Bell size={16} /> {title}
          </span>
        </div>
      )}

      <div className="card" style={{ padding: 12, marginBottom: 12, fontSize: '.82rem', color: 'var(--text-2)' }}>
        Every notification GAM can send is listed here. <strong>In-app</strong> puts it in your
        notification bell; <strong>Email</strong> sends it to your inbox. Turning email off and
        leaving in-app on means you still see everything when you sign in — nothing is thrown away.
        {' '}A few are always sent, and they say so on their own line. A dash means that notice is
        never sent that way at all.
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
        <button
          className="btn btn-primary"
          disabled={bulkBusy || isLoading}
          onClick={() => { void setAllEmail(allOff) }}
        >
          {bulkBusy ? 'Saving…' : allOff ? 'Turn every optional email back on' : 'Turn off every optional email'}
        </button>
        <span style={{ fontSize: '.78rem', color: 'var(--text-3)' }}>
          {emailOn.length} of {emailable.length} optional emails are on
        </span>
      </div>

      {bulkFailed && (
        <div className="card" style={{
          padding: 12, marginBottom: 12, fontSize: '.82rem',
          color: 'var(--red, #dc4c4c)', display: 'flex', alignItems: 'center', gap: 8,
        }}>
          <AlertTriangle size={15} /> {bulkFailed}
        </div>
      )}

      <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
        {isLoading ? (
          <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-3)' }}>Loading…</div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={th}>Notification</th>
                <th style={{ ...th, textAlign: 'center' }}>In-app</th>
                <th style={{ ...th, textAlign: 'center' }}>Email</th>
              </tr>
            </thead>
            <tbody>
              {groups.map(section => (
                <Fragment key={section.group}>
                  <tr>
                    <td colSpan={3} style={{
                      padding: '9px 14px', background: 'var(--bg-2)', borderBottom: '1px solid var(--border-0)',
                      fontSize: '.7rem', fontWeight: 800, letterSpacing: '.06em', textTransform: 'uppercase',
                      color: 'var(--gold)',
                    }}>{section.label}</td>
                  </tr>
                  {section.entries.map(entry => {
                    const c = choiceFor(entry.type)
                    const locked = isCriticalNotificationType(entry.type)
                    return (
                      <tr key={entry.type}>
                        <td style={td}>
                          <div style={{ fontSize: '.84rem', fontWeight: 600, color: 'var(--text-0)' }}>{entry.label}</div>
                          <div style={{ fontSize: '.72rem', color: 'var(--text-3)', marginTop: 2 }}>{entry.when}</div>
                          {locked && (
                            <div style={{
                              display: 'flex', alignItems: 'center', gap: 5, marginTop: 5,
                              fontSize: '.72rem', color: 'var(--gold)', fontWeight: 600,
                            }}>
                              <Lock size={11} /> GAM always sends this one. {entry.whyAlways}
                            </div>
                          )}
                          {busy[entry.type] && (
                            <div style={{ fontSize: '.7rem', color: 'var(--text-3)', marginTop: 4 }}>Saving…</div>
                          )}
                          {justSaved[entry.type] && !busy[entry.type] && (
                            <div style={{ fontSize: '.7rem', color: 'var(--green)', marginTop: 4, display: 'flex', alignItems: 'center', gap: 4 }}>
                              <Check size={11} /> Saved
                            </div>
                          )}
                          {failed[entry.type] && !busy[entry.type] && (
                            <div style={{ fontSize: '.7rem', color: 'var(--red, #dc4c4c)', marginTop: 4, display: 'flex', alignItems: 'center', gap: 4 }}>
                              <AlertTriangle size={11} /> {failed[entry.type]}
                            </div>
                          )}
                        </td>
                        <td style={cell}>
                          {entry.emailOnly
                            ? <span title="Sent by email only — nothing is posted in the app" style={{ color: 'var(--text-3)' }}>—</span>
                            : <input
                                type="checkbox"
                                checked={locked ? true : c.inApp}
                                disabled={locked || !!busy[entry.type] || bulkBusy}
                                title={locked ? 'GAM always posts this one in your notification bell.' : undefined}
                                onChange={e => setOne(entry, { email: c.email, inApp: e.target.checked })}
                                style={{ width: 16, height: 16, cursor: locked ? 'not-allowed' : 'pointer' }}
                              />}
                        </td>
                        <td style={cell}>
                          {entry.inAppOnly
                            ? <span title="This one is never emailed — it appears in your notification bell only" style={{ color: 'var(--text-3)' }}>—</span>
                            : <input
                                type="checkbox"
                                checked={locked ? true : c.email}
                                disabled={locked || !!busy[entry.type] || bulkBusy}
                                title={locked ? 'GAM always emails this one.' : undefined}
                                onChange={e => setOne(entry, { email: e.target.checked, inApp: c.inApp })}
                                style={{ width: 16, height: 16, cursor: locked ? 'not-allowed' : 'pointer' }}
                              />}
                        </td>
                      </tr>
                    )
                  })}
                </Fragment>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
