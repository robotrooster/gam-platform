import { useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from 'react-query'
import { CheckCircle2, Circle, ClipboardList, RotateCcw, ShoppingCart, X } from 'lucide-react'
import { PROPERTY_LIST_KIND_LABEL, type PropertyListKind } from '@gam/shared'

/**
 * The calling app's own fetchers, injected the way WorkTradePanel's are — S652
 * (Nic): "The landlord and the tenant should be seeing the same screens, but
 * from their different portals." 10/21: a work-trade resident reads and ticks
 * this very list from the tenant portal, so one panel serves both and the two
 * can never drift apart.
 */
export interface PropertyListApi {
  get: (url: string) => Promise<any>
  post: (url: string, body?: any) => Promise<any>
}

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
/**
 * 10/21 (Nic) — WHAT EACH LIST IS FOR, IN HIS WORDS.
 *
 * The task list used to prompt "Fix the meters on row C" and describe itself as
 * "fix the meters, re-gravel a site, swap a bulb" — all three of which he then
 * ruled out: "The checkout flow already takes care of the meter reads. So meter
 * reads should not ever be here, along with changing a broken meter, fixing
 * gravel, whatever. None of that stuff should be here. It's an owner that says,
 * hey, I want you to take some pictures of this apartment, get it listed as
 * available, things that are not timed, that are separate from maintenance and
 * separate from checkout." A screen that asks for the wrong thing gets the
 * wrong thing, so the words are the feature.
 */
const WORDS: Record<PropertyListKind, {
  title: string; count: string; about: string; placeholder: string
  doneHeading: string; empty: string; emptyAdd: string; emptyRead: string
}> = {
  job: {
    title: PROPERTY_LIST_KIND_LABEL.job,
    count: 'to do',
    about: 'Jobs the owner wants doing around the property when somebody has the time — take pictures of a '
      + 'vacant one and get it listed, walk the fence line, clear out the laundry room. Not maintenance and not '
      + 'checkout: a broken meter or a repair is a maintenance request, and a closing read is taken at the '
      + 'counter when somebody leaves. Nothing here is timed, counted or reported on, and residents never see it.',
    placeholder: 'Take pictures of MH 14 and get it listed',
    doneHeading: 'Done',
    empty: 'Nothing on the list',
    emptyAdd: 'Type the first job above.',
    emptyRead: 'Nothing to do here right now.',
  },
  supply: {
    title: PROPERTY_LIST_KIND_LABEL.supply,
    count: 'to buy',
    about: 'Things to buy for this property. Anybody working here can add a line — paint brushes, trash bags, '
      + 'a doorknob for 14 — and the owner ticks it off once it is bought, so one list stands in for six text '
      + 'messages. A line stays on the property it is needed at, because that is the delivery address; the '
      + 'owner\'s shopping view puts every park of one company together, because that is one order and one set '
      + 'of books.',
    placeholder: 'Trash bags — the 55 gallon ones',
    doneHeading: 'Bought',
    empty: 'Nothing to buy',
    emptyAdd: 'Type the first thing above.',
    emptyRead: 'Nothing on the shopping list right now.',
  },
}

export function PropertyListPanel({ propertyId, kind = 'job', isOwner, api }: {
  propertyId: string
  /** 'job' — the owner's task list. 'supply' — things to buy (10/21). */
  kind?: PropertyListKind
  /** The viewer may write and remove the task list, and tick a supply bought. */
  isOwner: boolean
  api: PropertyListApi
}) {
  const qc = useQueryClient()
  const words = WORDS[kind]
  // 10/21 (Nic), and the rules are INVERTED between the two lists: the owner
  // writes the jobs and ticks the shopping off; anybody working the park ticks
  // the jobs off and writes the shopping.
  const canAdd = kind === 'supply' ? true : isOwner
  const canTick = kind === 'supply' ? isOwner : true
  const [draft, setDraft] = useState('')
  const [showRemoved, setShowRemoved] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const boxRef = useRef<HTMLInputElement>(null)

  // The owner reads the lines they took off the list too, so nothing can go
  // out of reach with one click (10/21). A worker's read never asks for them.
  const key = ['property-task-list', propertyId, kind, isOwner ? 'with-removed' : 'open']
  const { data: items = [], isLoading } = useQuery<any[]>(
    key, () => api.get(`/property-task-list/${propertyId}?kind=${kind}${isOwner ? '&withHidden=1' : ''}`))

  // Every write refreshes the same list and clears the last error. The worker's
  // cross-property screen reads its own query, so it is invalidated too.
  const after = () => {
    setErr(null)
    qc.invalidateQueries(key)
    qc.invalidateQueries('my-property-tasks')
    // The owner's shopping view across every park reads its own query.
    qc.invalidateQueries('property-supply-run')
  }
  const fail = (e: any) => setErr(e?.response?.data?.error || 'That did not save. Try again.')

  const addMut = useMutation(
    (body: string) => api.post(`/property-task-list/${propertyId}`, { body, kind }),
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
    (id: string) => api.post(`/property-task-list/${propertyId}/items/${id}/done`, {}),
    { onSuccess: after, onError: fail })

  // 10/21 (Nic): "I clicked on it and it highlighted and I couldn't unclick
  // it." The owner's way back from a stray tick.
  const untickMut = useMutation(
    (id: string) => api.post(`/property-task-list/${propertyId}/items/${id}/undone`, {}),
    { onSuccess: after, onError: fail })

  const hideMut = useMutation(
    (id: string) => api.post(`/property-task-list/${propertyId}/items/${id}/hide`, {}),
    { onSuccess: after, onError: fail })

  // 10/21 (Nic): "I tried to X out of it and it deleted it from the list, not
  // completed it. So whatever was there, I didn't get a chance to read it."
  const unhideMut = useMutation(
    (id: string) => api.post(`/property-task-list/${propertyId}/items/${id}/unhide`, {}),
    { onSuccess: after, onError: fail })

  const submit = () => {
    const body = draft.trim()
    if (!body || addMut.isLoading) return
    addMut.mutate(body)
  }

  const live = items.filter(i => !i.hiddenAt)
  const open = live.filter(i => !i.doneAt)
  const done = live.filter(i => i.doneAt)
  const removed = items.filter(i => i.hiddenAt)

  return (
    <div className="card" style={{ marginTop: 20 }}>
      <h3 style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '0 0 4px', fontSize: '.95rem' }}>
        {kind === 'supply' ? <ShoppingCart size={16} /> : <ClipboardList size={16} />} {words.title}
        {open.length > 0 && (
          <span style={{ fontSize: '.72rem', color: 'var(--text-3)', fontWeight: 500 }}>
            {open.length} {words.count}
          </span>
        )}
      </h3>
      <p style={{ fontSize: '.78rem', color: 'var(--text-3)', margin: '0 0 16px', maxWidth: 620 }}>
        {words.about}
        {isOwner ? ' Nothing you tick or take off is lost — both have a way back.' : ' Nothing is ever deleted.'}
      </p>

      {canAdd && (
        <div style={{ display: 'flex', gap: 8, maxWidth: 620, marginBottom: 6 }}>
          <input
            ref={boxRef}
            value={draft}
            placeholder={words.placeholder}
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
      {canAdd && (
        <p style={{ fontSize: '.72rem', color: 'var(--text-3)', margin: '0 0 16px' }}>
          Press enter to add it and keep typing.
        </p>
      )}

      {err && <p style={{ color: 'var(--red)', fontSize: '.78rem', margin: '0 0 12px' }}>{err}</p>}

      {isLoading ? (
        <p style={{ fontSize: '.8rem', color: 'var(--text-3)' }}>Loading…</p>
      ) : items.length === 0 ? (
        <div className="empty-state" style={{ padding: 32 }}>
          {kind === 'supply' ? <ShoppingCart size={36} /> : <ClipboardList size={36} />}
          <h3>{words.empty}</h3>
          <p style={{ fontSize: '.8rem', color: 'var(--text-3)' }}>
            {canAdd ? words.emptyAdd : words.emptyRead}
          </p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, maxWidth: 620 }}>
          {open.map(i => (
            <TaskRow key={i.id} item={i} isOwner={isOwner} kind={kind}
              // A supply line is a request: whoever made it may take their own
              // back while it is unbought. The server says whose it is (`mine`).
              canTick={canTick} canRemove={isOwner || (kind === 'supply' && i.mine === true)}
              onTick={() => tickMut.mutate(i.id)}
              onHide={() => hideMut.mutate(i.id)}
              busy={tickMut.isLoading || hideMut.isLoading} />
          ))}
          {done.length > 0 && (
            <p style={{ fontSize: '.72rem', color: 'var(--text-3)', margin: '16px 0 4px' }}>
              {words.doneHeading}
            </p>
          )}
          {done.map(i => (
            <TaskRow key={i.id} item={i} isOwner={isOwner} kind={kind}
              canTick={isOwner} canRemove={isOwner}
              onTick={() => untickMut.mutate(i.id)}
              onHide={() => hideMut.mutate(i.id)}
              busy={untickMut.isLoading || hideMut.isLoading} />
          ))}
          {/* 10/21 (Nic): what a stray X took off the list, and the way back.
              The owner only — a line somebody removed is not a job. */}
          {isOwner && removed.length > 0 && (<>
            <button type="button" onClick={() => setShowRemoved(v => !v)}
              style={{
                background: 'none', border: 'none', padding: 0, margin: '16px 0 4px',
                color: 'var(--text-3)', fontSize: '.72rem', cursor: 'pointer', textAlign: 'left',
              }}>
              {showRemoved ? '▾' : '▸'} Taken off the list ({removed.length})
            </button>
            {showRemoved && removed.map(i => (
              <TaskRow key={i.id} item={i} isOwner={isOwner} kind={kind} removed
                canTick={false} canRemove
                onTick={() => {}}
                onHide={() => unhideMut.mutate(i.id)}
                busy={unhideMut.isLoading} />
            ))}
          </>)}
        </div>
      )}
    </div>
  )
}

/**
 * One line. Ticked lines read dimmed, with who did it and when.
 *
 * 10/21 (Nic): nothing here is one-way for the owner. The circle un-ticks a
 * ticked line, and a line that was taken off the list shows with "Put it back"
 * in place of the X.
 */
function TaskRow(
  { item, isOwner, kind, canTick, canRemove, onTick, onHide, busy, removed }:
  {
    item: any; isOwner: boolean; kind: PropertyListKind
    canTick: boolean; canRemove: boolean
    onTick: () => void; onHide: () => void; busy: boolean; removed?: boolean
  },
) {
  const isDone = !!item.doneAt
  const canUntick = isOwner && isDone && !removed
  const tickWord = kind === 'supply' ? 'bought' : 'done'
  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', gap: 10, padding: '8px 4px',
      borderBottom: '1px solid var(--border)',
    }}>
      <button
        onClick={onTick}
        disabled={removed || busy || !canTick || (isDone && !canUntick)}
        title={removed ? 'Taken off the list'
          : isDone ? (canUntick ? 'Un-tick it' : tickWord === 'bought' ? 'Bought' : 'Done')
          : canTick ? (tickWord === 'bought' ? 'Mark it bought' : 'Mark it done')
          : 'Only the owner marks this one'}
        aria-label={removed ? 'Taken off the list'
          : isDone ? (canUntick ? 'Un-tick it' : tickWord === 'bought' ? 'Bought' : 'Done')
          : canTick ? (tickWord === 'bought' ? 'Mark it bought' : 'Mark it done')
          : 'Only the owner marks this one'}
        style={{
          background: 'none', border: 'none', padding: 0, marginTop: 1,
          cursor: removed || !canTick || (isDone && !canUntick) ? 'default' : 'pointer',
          color: isDone ? 'var(--gold)' : 'var(--text-3)', lineHeight: 0,
          opacity: removed ? 0.5 : 1,
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
        {/* 10/21: on the shopping list, who asked for it is the point — the
            owner is reading five people's requests in one place. */}
        {kind === 'supply' && !isDone && item.addedByName && (
          <div style={{ fontSize: '.72rem', color: 'var(--text-3)', marginTop: 2 }}>
            Asked for by {item.addedByName}
          </div>
        )}
        {isDone && (
          <div style={{ fontSize: '.72rem', color: 'var(--text-3)', marginTop: 2 }}>
            {item.doneByName
              ? `${tickWord === 'bought' ? 'Bought by' : 'Done by'} ${item.doneByName}`
              : (tickWord === 'bought' ? 'Bought' : 'Done')}
            {' · '}
            {new Date(item.doneAt).toLocaleDateString(undefined,
              { month: 'short', day: 'numeric', year: 'numeric' })}
          </div>
        )}
      </div>
      {canRemove && (removed ? (
        <button
          className="btn btn-ghost btn-sm"
          onClick={onHide}
          disabled={busy}
          title="Put it back on the list"
          style={{ padding: '2px 8px', fontSize: '.72rem', whiteSpace: 'nowrap' }}>
          <RotateCcw size={12} style={{ marginRight: 4, verticalAlign: '-2px' }} />Put it back
        </button>
      ) : (
        <button
          className="btn btn-ghost btn-sm"
          onClick={onHide}
          disabled={busy}
          // 10/21: it used to say "Take it off the list" and Nic pressed it
          // meaning "done". The words now say which of the two it is, and
          // where the line goes — nothing here deletes anything.
          title="Take it off the list (not the same as done — it moves to “Taken off the list”, where you can put it back)"
          aria-label="Take it off the list"
          style={{ lineHeight: 0, padding: '4px 6px' }}>
          <X size={14} />
        </button>
      ))}
    </div>
  )
}
