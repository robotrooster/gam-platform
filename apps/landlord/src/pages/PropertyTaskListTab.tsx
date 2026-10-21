import { useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from 'react-query'
import { CheckCircle2, Circle, ClipboardList, X } from 'lucide-react'
import { apiGet, apiPost } from '../lib/api'
import { usePerms } from '../lib/permissions'

/**
 * 10/20 (Nic, relaying Blu) — THE PARK'S TASK LIST.
 *
 *   "He doesn't want to sit there and go through and add everything as a
 *    maintenance request per se, but he wants to have a list that the
 *    maintenance person can consult and check off when it's done... It's just
 *    like a task list of, hey, you know, fix these meters and do these things."
 *
 * One park's checklist. The landlord types lines; whoever is at the property
 * ticks them off. It is NOT maintenance: no status, no priority, no assignment,
 * no due date, and nothing anywhere counts how long a line sat open.
 *
 * SMOOTH MEANS NO MODAL. Nic asked for "something smooth", and the test of that
 * is a landlord with six things in their head: type a line, press enter, type
 * the next one. The box keeps focus and the list grows under it. A dialog per
 * task would be the ceremony Blu is trying to get away from, wearing a
 * different hat.
 *
 * Shown on the property page for the landlord, and on the maintenance person's
 * own screen for the one park they are standing in. The server decides who may
 * write: ticking is anybody the landlord put on the property, adding and
 * removing are the owner's (routes/propertyTaskList.ts). `isOwner` here only
 * keeps a button off a screen that would be refused anyway.
 */
export function PropertyTaskListTab({ propertyId }: { propertyId: string }) {
  const qc = useQueryClient()
  const { isOwner } = usePerms()
  const [draft, setDraft] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const boxRef = useRef<HTMLInputElement>(null)

  const key = ['property-task-list', propertyId]
  const { data: items = [], isLoading } = useQuery<any[]>(
    key, () => apiGet(`/property-task-list/${propertyId}`))

  // Every write refreshes the same list and clears the last error. The worker's
  // cross-property screen reads its own query, so it is invalidated too.
  const after = () => {
    setErr(null)
    qc.invalidateQueries(key)
    qc.invalidateQueries('my-property-tasks')
  }
  const fail = (e: any) => setErr(e?.response?.data?.error || 'That did not save. Try again.')

  const addMut = useMutation(
    (body: string) => apiPost(`/property-task-list/${propertyId}`, { body }),
    {
      onSuccess: () => {
        after()
        setDraft('')
        // The whole point of typing the next one: the cursor never leaves.
        boxRef.current?.focus()
      },
      onError: fail,
    })

  const tickMut = useMutation(
    (id: string) => apiPost(`/property-task-list/${propertyId}/items/${id}/done`, {}),
    { onSuccess: after, onError: fail })

  const hideMut = useMutation(
    (id: string) => apiPost(`/property-task-list/${propertyId}/items/${id}/hide`, {}),
    { onSuccess: after, onError: fail })

  const submit = () => {
    const body = draft.trim()
    if (!body || addMut.isLoading) return
    addMut.mutate(body)
  }

  const open = items.filter(i => !i.doneAt)
  const done = items.filter(i => i.doneAt)

  return (
    <div className="card" style={{ marginTop: 20 }}>
      <h3 style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '0 0 4px', fontSize: '.95rem' }}>
        <ClipboardList size={16} /> Task list
        {open.length > 0 && (
          <span style={{ fontSize: '.72rem', color: 'var(--text-3)', fontWeight: 500 }}>
            {open.length} to do
          </span>
        )}
      </h3>
      <p style={{ fontSize: '.78rem', color: 'var(--text-3)', margin: '0 0 16px', maxWidth: 620 }}>
        Jobs around the property for whoever is working here — fix the meters, re-gravel a site,
        swap a bulb. Not repair requests: nothing here is timed, counted or reported on, and
        residents never see it. A ticked line stays on the list with who did it.
      </p>

      {isOwner && (
        <div style={{ display: 'flex', gap: 8, maxWidth: 620, marginBottom: 6 }}>
          <input
            ref={boxRef}
            value={draft}
            placeholder="Fix the meters on row C"
            maxLength={500}
            onChange={e => { setDraft(e.target.value); setErr(null) }}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); submit() } }}
            style={{ flex: 1 }}
          />
          <button className="btn btn-primary btn-sm" disabled={!draft.trim() || addMut.isLoading}
            onClick={submit}>
            {addMut.isLoading ? 'Adding…' : 'Add'}
          </button>
        </div>
      )}
      {isOwner && (
        <p style={{ fontSize: '.72rem', color: 'var(--text-3)', margin: '0 0 16px' }}>
          Press enter to add it and keep typing.
        </p>
      )}

      {err && <p style={{ color: 'var(--red)', fontSize: '.78rem', margin: '0 0 12px' }}>{err}</p>}

      {isLoading ? (
        <p style={{ fontSize: '.8rem', color: 'var(--text-3)' }}>Loading…</p>
      ) : items.length === 0 ? (
        <div className="empty-state" style={{ padding: 32 }}>
          <ClipboardList size={36} />
          <h3>Nothing on the list</h3>
          <p style={{ fontSize: '.8rem', color: 'var(--text-3)' }}>
            {isOwner
              ? 'Type the first job above.'
              : 'Nothing to do here right now.'}
          </p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, maxWidth: 620 }}>
          {open.map(i => (
            <TaskRow key={i.id} item={i} isOwner={isOwner}
              onTick={() => tickMut.mutate(i.id)}
              onHide={() => hideMut.mutate(i.id)}
              busy={tickMut.isLoading || hideMut.isLoading} />
          ))}
          {done.length > 0 && (
            <p style={{ fontSize: '.72rem', color: 'var(--text-3)', margin: '16px 0 4px' }}>
              Done
            </p>
          )}
          {done.map(i => (
            <TaskRow key={i.id} item={i} isOwner={isOwner}
              onTick={() => {}}
              onHide={() => hideMut.mutate(i.id)}
              busy={hideMut.isLoading} />
          ))}
        </div>
      )}
    </div>
  )
}

/** One line. Ticked lines read dimmed, with who did it and when. */
function TaskRow(
  { item, isOwner, onTick, onHide, busy }:
  { item: any; isOwner: boolean; onTick: () => void; onHide: () => void; busy: boolean },
) {
  const isDone = !!item.doneAt
  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', gap: 10, padding: '8px 4px',
      borderBottom: '1px solid var(--border)',
    }}>
      <button
        onClick={onTick}
        disabled={isDone || busy}
        title={isDone ? 'Done' : 'Mark it done'}
        aria-label={isDone ? 'Done' : 'Mark it done'}
        style={{
          background: 'none', border: 'none', padding: 0, marginTop: 1,
          cursor: isDone ? 'default' : 'pointer',
          color: isDone ? 'var(--gold)' : 'var(--text-3)', lineHeight: 0,
        }}>
        {isDone ? <CheckCircle2 size={18} /> : <Circle size={18} />}
      </button>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: '.85rem',
          color: isDone ? 'var(--text-3)' : 'var(--text-0)',
          textDecoration: isDone ? 'line-through' : 'none',
          wordBreak: 'break-word',
        }}>
          {item.body}
        </div>
        {isDone && (
          <div style={{ fontSize: '.72rem', color: 'var(--text-3)', marginTop: 2 }}>
            {item.doneByName ? `Done by ${item.doneByName}` : 'Done'}
            {' · '}
            {new Date(item.doneAt).toLocaleDateString(undefined,
              { month: 'short', day: 'numeric', year: 'numeric' })}
          </div>
        )}
      </div>
      {isOwner && (
        <button
          className="btn btn-ghost btn-sm"
          onClick={onHide}
          disabled={busy}
          title="Take it off the list"
          aria-label="Take it off the list"
          style={{ lineHeight: 0, padding: '4px 6px' }}>
          <X size={14} />
        </button>
      )}
    </div>
  )
}
