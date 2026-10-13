/**
 * 10/12 (Nic): bank reconciliation — one bank account against its statement,
 * on the company's ledger (Nic, decision 2: "Full bookkeeping (bank lines,
 * reconciling, journal entries, bills, payroll, vendors) … One level").
 *
 * GAM Books' own page, shown in GAM Books, inside the landlord portal's
 * Bookkeeping menu, and on the portal's Bank page (Reconciliation tab) — the
 * same bytes in apps/books and apps/landlord (bookkeeping-parity.test.ts). How
 * it reaches the API, shows a toast and links to another Books page is the
 * app's own (./adapter).
 *
 * A landlord company reconciles on the ledger GAM keeps automatically
 * (services/bankReconciliation): type the statement's last day and ending
 * balance; lines the bank feed already matched (and the opening balance)
 * arrive ticked; tick off the rest against the paper; finish at a $0.00
 * difference, which freezes every cleared line. Only the latest finished
 * statement can be undone, never inside a closed month, always saying why.
 * A business's books still reconcile their Transactions (the business ledger
 * is a later phase), below.
 */
import React, { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery, useQueryClient } from 'react-query'
import {
  formatCurrency, humanize, BOOKS_TRANSACTION_TYPE_LABEL, BANK_RECONCILIATION_STATUS_LABEL,
} from '@gam/shared'
import { booksGet as get, booksPost as post, booksPatch as patch, toast, useBooksRole, expensesPagePath } from './adapter'
import { loadErrorText } from './booksMoney'
import { Modal } from './common'

const day=(d:string|null|undefined)=>d?new Date(`${d.slice(0,10)}T12:00:00`).toLocaleDateString():'—'
const statusLabel=(s:string)=>(BANK_RECONCILIATION_STATUS_LABEL as Record<string,string>)[s]??'—'
const errText=(ex:any,fallback:string)=>ex?.response?.data?.error||fallback
const isZero=(n:number|null|undefined)=>n!=null&&Math.abs(n)<0.005

interface Account { accountId:string; code:string; name:string; linked:boolean; active:boolean; ledgerBalance:number; reconciledThrough:string|null; reconciledBalance:number|null; inProgress:{id:string;statementDate:string;statementBalance:number}|null }
interface Line { lineId:string; day:string; bookedOn:string|null; amount:number; description:string; journalEntry:boolean; takesBack:boolean; bankLine:{id:string;day:string;description:string|null}|null; clearing:string|null; automatic:boolean }
interface Rec { id:string; status:string; statementDate:string; statementBalance:number; beginningBalance:number|null; clearedBalance:number|null; completedAt:string|null; undoneAt:string|null; undoReason:string|null; by:string|null }
interface Worksheet { account:Account; reconciliation:Rec|null; startsAfter:string|null; beginningBalance:number; clearedThisStatement:number; clearedBalance:number; difference:number|null; ledgerBalance:number; notCleared:number; lines:Line[]; canceledPairs:number; history:Rec[]; canFinish:boolean }

export function BankReconcilePage({embedded=false}:{embedded?:boolean}={}){
  const role=useBooksRole()
  // A business's books reconcile their Transactions until the business ledger ships.
  if(role==='business_owner'||role==='business_staff')return <TransactionsReconcile/>
  return <LedgerReconcile embedded={embedded}/>
}

// ── ON THE LEDGER (a landlord company) ────────────────────────────────
function LedgerReconcile({embedded}:{embedded:boolean}){
  const qc=useQueryClient()
  const{data:accounts,isLoading:loadingAccounts,error:accountsError}=useQuery('reconcileAccounts',()=>get<Account[]>('/books/reconcile/accounts'))
  const list:Account[]=accounts??[]
  const[accountId,setAccountId]=useState('')
  // One linked bank (or one statement in progress): open it straight away.
  useEffect(()=>{
    if(accountId||!list.length)return
    const working=list.find(a=>a.inProgress)
    const linked=list.filter(a=>a.linked)
    const pick=working??(linked.length===1?linked[0]:list.length===1?list[0]:null)
    if(pick)setAccountId(pick.accountId)
  },[list,accountId])
  const{data:ws,isLoading,error}=useQuery(['reconcileWorksheet',accountId],()=>get<Worksheet>(`/books/reconcile/accounts/${accountId}`),{enabled:!!accountId})
  const show=(next:Worksheet)=>{qc.setQueryData(['reconcileWorksheet',accountId],next);qc.invalidateQueries('reconcileAccounts')}

  const header=embedded?null:(
    <div className="ph"><div><h1 className="pt">🏦 Bank Reconciliation</h1><p className="ps">Check each bank account against its statement. Lines the bank feed matched arrive ticked; tick off the rest until the difference is $0.00.</p></div></div>
  )
  if(loadingAccounts)return <div>{header}<div style={{padding:32,textAlign:'center'}}><span className="spinner" style={{display:'inline-block'}}/></div></div>
  if(accountsError)return <div>{header}<div className="alert ae">{loadErrorText(accountsError,'Could not load the bank accounts.')}</div></div>

  return(
    <div>
      {header}
      <div className="card" style={{marginBottom:16}}>
        <div className="frow" style={{marginBottom:0}}><label>Bank account</label>
          <select value={accountId} onChange={e=>setAccountId(e.target.value)}>
            <option value="">Choose a bank account…</option>
            {list.map(a=><option key={a.accountId} value={a.accountId}>{a.code} · {a.name}{a.inProgress?' (in progress)':a.reconciledThrough?` (reconciled through ${day(a.reconciledThrough)})`:''}</option>)}
          </select>
        </div>
        {!list.length&&<div style={{fontSize:'.76rem',color:'var(--t3)',marginTop:8,lineHeight:1.5}}>No bank account is on the books yet. Link your bank on the Bank page; its account appears here once money moves through it.</div>}
      </div>
      {!accountId?null:isLoading||!ws?(error?<div className="alert ae">{loadErrorText(error,'Could not load this account.')}</div>:<div style={{padding:32,textAlign:'center'}}><span className="spinner" style={{display:'inline-block'}}/></div>)
        :ws.reconciliation?<Statement ws={ws} onChange={show}/>:<StartStatement ws={ws} onChange={show}/>}
      {ws&&accountId&&<History ws={ws} onChange={show}/>}
    </div>
  )
}

function StartStatement({ws,onChange}:{ws:Worksheet;onChange:(w:Worksheet)=>void}){
  const[date,setDate]=useState('')
  const[balance,setBalance]=useState('')
  const[saving,setSaving]=useState(false)
  const start=async(e:React.FormEvent)=>{
    e.preventDefault();setSaving(true)
    try{
      const r=await post<Worksheet>(`/books/reconcile/accounts/${ws.account.accountId}/start`,{statementDate:date,statementBalance:balance})
      onChange(r.data)
    }catch(ex:any){toast.error(errText(ex,'Could not start this statement.'))}
    finally{setSaving(false)}
  }
  return(
    <div className="grid2" style={{marginBottom:16}}>
      <div className="card">
        <div className="ct">Start a statement</div>
        <form onSubmit={start}>
          <div className="frow"><label>Statement&apos;s last day</label><input type="date" value={date} onChange={e=>setDate(e.target.value)} min={ws.startsAfter??undefined} required/></div>
          <div className="frow"><label>Ending balance on the statement</label><input type="number" step="0.01" inputMode="decimal" value={balance} onChange={e=>setBalance(e.target.value)} placeholder="0.00" required/></div>
          <div style={{fontSize:'.72rem',color:'var(--t3)',marginBottom:12,lineHeight:1.5}}>Type the figures printed on the statement — never a number worked out here.</div>
          <button type="submit" className="btn bp" disabled={saving||!date||balance===''}>{saving?<><span className="spinner"/>Starting…</>:'Start reconciling'}</button>
        </form>
      </div>
      <div className="card">
        <div className="ct">{ws.account.name}</div>
        <div className="dr"><span className="dk">Reconciled through</span><span className="dv mono">{ws.startsAfter?day(ws.startsAfter):'Not reconciled yet'}</span></div>
        <div className="dr"><span className="dk">Cleared balance so far</span><span className="dv mono">{formatCurrency(ws.beginningBalance)}</span></div>
        <div className="dr"><span className="dk">On the books today</span><span className="dv mono">{formatCurrency(ws.ledgerBalance)}</span></div>
        <div className="dr"><span className="dk">Not cleared yet</span><span className="dv mono">{formatCurrency(ws.notCleared)}</span></div>
      </div>
    </div>
  )
}

function Statement({ws,onChange}:{ws:Worksheet;onChange:(w:Worksheet)=>void}){
  const rec=ws.reconciliation!
  const[busy,setBusy]=useState(false)
  const[editing,setEditing]=useState(false)
  const[date,setDate]=useState(rec.statementDate)
  const[balance,setBalance]=useState(String(rec.statementBalance))
  const[setAside,setSetAside]=useState(false)
  useEffect(()=>{setDate(rec.statementDate);setBalance(String(rec.statementBalance))},[rec.statementDate,rec.statementBalance])
  const run=async(fn:()=>Promise<{data:Worksheet}>,fallback:string,done?:string):Promise<boolean>=>{
    setBusy(true)
    try{const r=await fn();onChange(r.data);if(done)toast(done);return true}
    catch(ex:any){toast.error(errText(ex,fallback));return false}
    finally{setBusy(false)}
  }
  const tick=(lineIds:string[],cleared:boolean)=>run(()=>post<Worksheet>(`/books/reconcile/${rec.id}/tick`,{lineIds,cleared}),'Could not change that tick.')
  const save=async(e:React.FormEvent)=>{
    e.preventDefault()
    if(await run(()=>patch<Worksheet>(`/books/reconcile/${rec.id}`,{statementDate:date,statementBalance:balance}),'Could not change the statement.'))setEditing(false)
  }
  const finish=()=>run(()=>post<Worksheet>(`/books/reconcile/${rec.id}/finish`),'Could not finish this statement.','Reconciled. Its lines are frozen.')
  const books=ws.lines.filter(l=>!l.journalEntry)
  const journal=ws.lines.filter(l=>l.journalEntry)
  const unticked=books.filter(l=>!l.clearing)
  const diff=ws.difference??0
  return(
    <>
      <div className="grid2" style={{marginBottom:16}}>
        <div className="card">
          <div className="ct">Statement ending {day(rec.statementDate)}</div>
          {editing?(
            <form onSubmit={save}>
              <div className="frow"><label>Statement&apos;s last day</label><input type="date" value={date} onChange={e=>setDate(e.target.value)} min={ws.startsAfter??undefined} required/></div>
              <div className="frow"><label>Ending balance on the statement</label><input type="number" step="0.01" inputMode="decimal" value={balance} onChange={e=>setBalance(e.target.value)} required/></div>
              <div className="factions">
                <button type="button" className="btn bg-btn" onClick={()=>setEditing(false)}>Cancel</button>
                <button type="submit" className="btn bp" disabled={busy}>Save</button>
              </div>
            </form>
          ):(
            <>
              <div className="dr"><span className="dk">Ending balance on the statement</span><span className="dv mono">{formatCurrency(rec.statementBalance)}</span></div>
              <div className="dr"><span className="dk">Beginning (cleared on earlier statements)</span><span className="dv mono">{formatCurrency(ws.beginningBalance)}</span></div>
              <div className="dr"><span className="dk">Cleared on this statement</span><span className="dv mono">{formatCurrency(ws.clearedThisStatement)}</span></div>
              <div className="dr"><span className="dk" style={{fontWeight:700}}>Cleared balance</span><span className="dv mono" style={{fontWeight:700}}>{formatCurrency(ws.clearedBalance)}</span></div>
              <div className="dr" style={{borderTop:'1px solid var(--b1)',marginTop:4,paddingTop:8}}>
                <span className="dk" style={{fontWeight:700}}>Difference</span>
                <span className="mono" style={{color:isZero(diff)?'var(--green)':'var(--red)',fontWeight:700}}>{formatCurrency(diff)}</span>
              </div>
              <div className="factions" style={{marginTop:12,flexWrap:'wrap'}}>
                <button className="btn bg-btn" onClick={()=>setSetAside(true)} disabled={busy}>Set aside</button>
                <button className="btn bp" onClick={()=>setEditing(true)} disabled={busy}>Change statement</button>
                <button className="btn bp" onClick={finish} disabled={busy||!ws.canFinish}>{busy?<><span className="spinner"/>Working…</>:'Finish'}</button>
              </div>
              {!ws.canFinish&&<div style={{fontSize:'.72rem',color:'var(--t3)',marginTop:8,lineHeight:1.5}}>Finish opens at a $0.00 difference.</div>}
            </>
          )}
        </div>
        <div className="card">
          <div className="ct">{ws.account.name}</div>
          <div className="dr"><span className="dk">On the books through {day(rec.statementDate)}</span><span className="dv mono">{formatCurrency(ws.ledgerBalance)}</span></div>
          <div className="dr"><span className="dk">Not on this statement yet</span><span className="dv mono">{formatCurrency(ws.notCleared)}</span></div>
          <div style={{fontSize:'.74rem',color:'var(--t3)',marginTop:10,lineHeight:1.5}}>
            A bank charge or deposit on the statement that is not listed here? Add it on the <Link to={expensesPagePath()} style={{color:'var(--gold)'}}>Expenses</Link> page as paid from this bank (or file it from the bank feed), then tick it.
          </div>
          {ws.canceledPairs>0&&<div style={{fontSize:'.72rem',color:'var(--t3)',marginTop:8,lineHeight:1.5}}>{ws.canceledPairs} line{ws.canceledPairs!==1?'s were':' was'} corrected before this statement; each and its correction come to $0.00 together and are left off.</div>}
        </div>
      </div>

      <LineTable title="On the books" lines={books} busy={busy} onTick={tick}
        action={unticked.length>1?<button className="btn bp bsm" disabled={busy} onClick={()=>tick(unticked.map(l=>l.lineId),true)}>Tick all {unticked.length}</button>:null}
        empty="Nothing on the books for this account through the statement's last day."/>
      {journal.length>0&&(
        <LineTable title="Journal entries to this account (reconciling items)" lines={journal} busy={busy} onTick={tick}
          note="A bookkeeper's adjustment — no bank line stands behind it. Tick it only when it is on the statement." empty=""/>
      )}

      {setAside&&<ReasonModal title="Set aside this statement" what="The statement stops being worked and its ticks come off. It stays on record, with who set it aside, when and why." button="Set it aside"
        onSave={async(reason)=>{const r=await post<Worksheet>(`/books/reconcile/${rec.id}/undo`,{reason});onChange(r.data);toast('Set aside.')}}
        onClose={()=>setSetAside(false)}/>}
    </>
  )
}

function LineTable({title,lines,busy,onTick,action,note,empty}:{title:string;lines:Line[];busy:boolean;onTick:(ids:string[],cleared:boolean)=>void;action?:React.ReactNode;note?:string;empty:string}){
  return(
    <div className="card" style={{padding:0,marginBottom:16}}>
      <div style={{padding:'12px 16px',borderBottom:'1px solid var(--b1)',display:'flex',justifyContent:'space-between',alignItems:'center',gap:8,flexWrap:'wrap'}}>
        <div className="ct" style={{marginBottom:0}}>{title}</div>
        {action}
      </div>
      {note&&<div style={{padding:'8px 16px 0',fontSize:'.72rem',color:'var(--t3)'}}>{note}</div>}
      <div style={{overflowX:'auto'}}>
        <table className="tbl" style={{minWidth:520}}>
          <thead><tr><th style={{width:36}}></th><th>Date</th><th>What</th><th style={{textAlign:'right'}}>In</th><th style={{textAlign:'right'}}>Out</th></tr></thead>
          <tbody>
            {lines.length?lines.map(l=>{
              const ticked=!!l.clearing
              const why=l.clearing==='bank_line'&&l.bankLine?`Matched to the bank line of ${day(l.bankLine.day)}`:l.clearing==='opening'?'The opening balance':''
              return(
                <tr key={l.lineId}>
                  <td><input type="checkbox" aria-label={ticked?'On the statement':'Tick when on the statement'} checked={ticked} disabled={busy||l.automatic} title={why||undefined} onChange={e=>onTick([l.lineId],e.target.checked)}/></td>
                  <td className="mono" style={{fontSize:'.72rem',whiteSpace:'nowrap'}}>{day(l.day)}{l.bookedOn&&<div style={{color:'var(--t3)'}}>booked {day(l.bookedOn)}</div>}</td>
                  <td style={{fontSize:'.78rem',color:'var(--t0)'}}>
                    {l.description}
                    {l.takesBack&&<div style={{fontSize:'.68rem',color:'var(--amber)'}}>Takes back an earlier line of the same record</div>}
                    {why&&<div style={{fontSize:'.68rem',color:'var(--t3)'}}>{why}</div>}
                  </td>
                  <td className="mono" style={{textAlign:'right',color:'var(--green)'}}>{l.amount>0?formatCurrency(l.amount):''}</td>
                  <td className="mono" style={{textAlign:'right',color:'var(--red)'}}>{l.amount<0?formatCurrency(-l.amount):''}</td>
                </tr>
              )
            }):<tr><td colSpan={5}><div className="empty">{empty}</div></td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function History({ws,onChange}:{ws:Worksheet;onChange:(w:Worksheet)=>void}){
  const[undoing,setUndoing]=useState<Rec|null>(null)
  if(!ws.history.length)return null
  // Only the latest finished statement can be undone, and only while none is being worked.
  const latest=ws.reconciliation?null:ws.history.find(h=>h.status==='completed')??null
  return(
    <div className="card" style={{padding:0}}>
      <div style={{padding:'12px 16px',borderBottom:'1px solid var(--b1)'}}><div className="ct" style={{marginBottom:0}}>Earlier statements</div></div>
      <div style={{overflowX:'auto'}}>
        <table className="tbl" style={{minWidth:520}}>
          <thead><tr><th>Last day</th><th style={{textAlign:'right'}}>Ending balance</th><th>Status</th><th>By</th><th></th></tr></thead>
          <tbody>
            {ws.history.map(h=>(
              <tr key={h.id}>
                <td className="mono" style={{fontSize:'.74rem'}}>{day(h.statementDate)}</td>
                <td className="mono" style={{textAlign:'right'}}>{formatCurrency(h.statementBalance)}</td>
                <td><span className={`badge ${h.status==='completed'?'bg2':'ba'}`}>{statusLabel(h.status)}</span>{h.undoReason&&<div style={{fontSize:'.68rem',color:'var(--t3)',marginTop:2}}>{h.undoReason}</div>}</td>
                <td style={{fontSize:'.74rem'}}>{h.by??'—'}</td>
                <td>{latest?.id===h.id&&<button className="btn bg-btn bsm" onClick={()=>setUndoing(h)}>Undo</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {undoing&&<ReasonModal title="Undo this reconciliation" what={`The statement ending ${day(undoing.statementDate)} stops counting as reconciled and its lines come back to be ticked again. It stays on record, with who undid it, when and why. A closed month must be reopened first.`} button="Undo it"
        onSave={async(reason)=>{const r=await post<Worksheet>(`/books/reconcile/${undoing.id}/undo`,{reason});onChange(r.data);toast('Undone.')}}
        onClose={()=>setUndoing(null)}/>}
    </div>
  )
}

/** Asks why before a statement is set aside or undone (kept on record, never removed). */
function ReasonModal({title,what,button,onSave,onClose}:{title:string;what:string;button:string;onSave:(reason:string)=>Promise<void>;onClose:()=>void}){
  const[reason,setReason]=useState('')
  const[err,setErr]=useState('')
  const[saving,setSaving]=useState(false)
  const go=async(e:React.FormEvent)=>{
    e.preventDefault();setSaving(true);setErr('')
    try{await onSave(reason.trim());onClose()}
    catch(ex:any){setErr(errText(ex,'Could not do that.'))}
    finally{setSaving(false)}
  }
  return(
    <Modal title={title} onClose={onClose}>
      {err&&<div className="alert ae">{err}</div>}
      <form onSubmit={go}>
        <p style={{fontSize:'.8rem',color:'var(--t2)',marginBottom:12}}>{what}</p>
        <div className="frow"><label>Why</label><textarea rows={2} value={reason} onChange={e=>setReason(e.target.value)} maxLength={500} required placeholder="e.g. Typed the wrong statement"/></div>
        <div className="factions">
          <button type="button" className="btn bg-btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn bp" disabled={saving||!reason.trim()}>{saving?<><span className="spinner"/>Working…</>:button}</button>
        </div>
      </form>
    </Modal>
  )
}

// ── A BUSINESS'S BOOKS: ITS TRANSACTIONS (until the business ledger ships) ──
// 10/11: one bank account at a time. The server works out the chosen
// account's own figures over every row (GET /books/reconciliation):
//   cleared balance = journal entries to the account + its reconciled
//   transactions — what the statement's ending balance should match. Marking an
//   uncleared transaction that is on the statement moves it into the cleared
//   balance, until the difference is zero.
function TransactionsReconcile(){
  const{data:accounts=[]}=useQuery('acct',()=>get<any[]>('/books/accounts'))
  const[statementBal,setStatementBal]=useState('')
  const[selectedAcct,setSelectedAcct]=useState('')
  const qc=useQueryClient()
  const bankAccts=(accounts as any[]).filter((a:any)=>a.subtype==='bank')
  const{data:rec,isLoading,error}=useQuery(['reconciliation',selectedAcct],()=>get<any>(`/books/reconciliation?accountId=${selectedAcct}`),{enabled:!!selectedAcct})
  const unrecTxs:any[]=(rec as any)?.uncleared??[]
  const cleared=Number((rec as any)?.clearedBalance??0)
  const diff=(+statementBal||0)-cleared

  const reconcile=async(id:string)=>{
    try{
      await patch('/books/transactions/'+id+'/reconcile')
      qc.invalidateQueries('reconciliation')
      qc.invalidateQueries('txs')
    }catch(ex:any){toast.error(ex.response?.data?.error||'Could not mark it reconciled.')}
  }

  return(
    <div>
      <div className="ph"><div><h1 className="pt">🏦 Bank Reconciliation</h1><p className="ps">{selectedAcct?`${unrecTxs.length} unreconciled transaction${unrecTxs.length!==1?'s':''} in this account`:'Choose a bank account to reconcile'}</p></div></div>

      <div className="grid2" style={{marginBottom:16}}>
        <div className="card">
          <div className="ct">Reconciliation Setup</div>
          <div className="frow"><label>Bank Account</label>
            <select value={selectedAcct} onChange={e=>setSelectedAcct(e.target.value)}>
              <option value="">Select bank account…</option>
              {bankAccts.map((a:any)=><option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}
            </select>
          </div>
          {bankAccts.length===0&&<div style={{fontSize:'.72rem',color:'var(--t3)'}}>No bank accounts yet. Add one in the Chart of Accounts with the subtype "bank".</div>}
          <div className="frow"><label>Statement Ending Balance</label><input type="number" step="0.01" value={statementBal} onChange={e=>setStatementBal(e.target.value)} placeholder="0.00"/></div>
        </div>
        <div className="card">
          <div className="ct">Balance Summary</div>
          {!selectedAcct?<div style={{fontSize:'.78rem',color:'var(--t3)'}}>Choose a bank account to see its balances.</div>
          :error?<div className="alert aw">{loadErrorText(error,'Could not load this account.')}</div>
          :<>
            <div className="dr"><span className="dk">Statement balance</span><span className="dv mono">{formatCurrency(+statementBal||0)}</span></div>
            <div className="dr"><span className="dk">Journal entries to this account</span><span className="dv mono">{formatCurrency((rec as any)?.journalBalance??0)}</span></div>
            <div className="dr"><span className="dk">Reconciled transactions</span><span className="dv mono">{formatCurrency((rec as any)?.clearedNet??0)}</span></div>
            <div className="dr"><span className="dk" style={{fontWeight:700}}>Cleared balance</span><span className="dv mono" style={{fontWeight:700}}>{formatCurrency(cleared)}</span></div>
            <div className="dr" style={{borderTop:'1px solid var(--b1)',marginTop:4,paddingTop:8}}>
              <span className="dk" style={{fontWeight:700}}>Difference</span>
              <span style={{color:Math.abs(diff)<0.005?'var(--green)':'var(--red)',fontWeight:700,fontFamily:'var(--font-m)'}}>{formatCurrency(diff)}</span>
            </div>
            {Math.abs(diff)<0.005&&statementBal&&<div style={{marginTop:10}}><span className="badge bg2">✓ Reconciled</span></div>}
            <div className="dr" style={{marginTop:8}}><span className="dk">Not yet reconciled</span><span className="dv mono">{formatCurrency((rec as any)?.unclearedNet??0)}</span></div>
            <div className="dr"><span className="dk">Book balance (everything)</span><span className="dv mono">{formatCurrency((rec as any)?.bookBalance??0)}</span></div>
          </>}
        </div>
      </div>

      {!!(rec as any)?.unassignedCount&&<div className="alert aw">{(rec as any).unassignedCount} unreconciled transaction{(rec as any).unassignedCount!==1?'s are':' is'} not tied to any account, so {(rec as any).unassignedCount!==1?'they are':'it is'} not part of this reconciliation.</div>}

      {selectedAcct&&(
        <div className="card" style={{padding:0}}>
          <div style={{padding:'12px 16px',borderBottom:'1px solid var(--b1)',display:'flex',justifyContent:'space-between',alignItems:'center'}}>
            <div className="ct" style={{marginBottom:0}}>Unreconciled Transactions</div>
            <span style={{fontSize:'.72rem',color:'var(--t3)'}}>Mark each one that is on the statement</span>
          </div>
          {isLoading?<div style={{padding:32,color:'var(--t3)',textAlign:'center'}}><span className="spinner" style={{display:'inline-block'}}/></div>:(
            <div style={{overflowX:'auto'}}>
            <table className="tbl">
              <thead><tr><th>Date</th><th>Description</th><th>Type</th><th>Amount</th><th></th></tr></thead>
              <tbody>
                {unrecTxs.length?unrecTxs.map((t:any)=>(
                  <tr key={t.id}>
                    <td className="mono" style={{fontSize:'.72rem'}}>{new Date(t.date+'T12:00:00').toLocaleDateString()}</td>
                    <td style={{fontSize:'.78rem',color:'var(--t0)'}}>{t.description}</td>
                    <td><span className={`badge ${t.type==='income'?'bg2':'br'}`}>{(BOOKS_TRANSACTION_TYPE_LABEL as Record<string,string>)[t.type]??humanize(t.type)}</span></td>
                    <td className="mono" style={{color:t.type==='income'?'var(--green)':'var(--red)'}}>{t.type==='income'?'+':'-'}{formatCurrency(t.amount)}</td>
                    <td><button className="btn bp bsm" onClick={()=>reconcile(t.id)}>✓ Reconcile</button></td>
                  </tr>
                )):<tr><td colSpan={5}><div className="empty">Every transaction in this account is reconciled.</div></td></tr>}
              </tbody>
            </table>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
