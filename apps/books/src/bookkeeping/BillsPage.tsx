/**
 * 10/12 (Nic): bills and accounts payable.
 *
 * GAM Books' own page, shown in GAM Books and inside the landlord portal's
 * Bookkeeping menu — the same bytes in apps/books and apps/landlord
 * (bookkeeping-parity.test.ts). How it reaches the API, shows a toast and
 * links to another Books page is the app's own (./adapter).
 */
import React, { useState } from 'react'
import { useQuery, useQueryClient } from 'react-query'
import { formatCurrency, humanize } from '@gam/shared'
import { booksGet as get, useBooksRole, expensesPagePath, booksPost as post, toast } from './adapter'
import { Link } from 'react-router-dom'
import { Modal } from './common'
import { localToday } from './booksMoney'

// ── BILLS & AP ────────────────────────────────────────────────────────
function BusinessBillsPage(){
  const qc=useQueryClient()
  const{data:bills=[],isLoading}=useQuery('bills',()=>get<any[]>('/books/bills'))
  const{data:vendors=[]}=useQuery('ven',()=>get<any[]>('/books/vendors'))
  const{data:accounts=[]}=useQuery('acct',()=>get<any[]>('/books/accounts'))
  const[tab,setTab]=useState<'open'|'paid'|'all'>('open')
  const[showAdd,setShowAdd]=useState(false)
  const[err,setErr]=useState('')
  const[saving,setSaving]=useState(false)
  const init={vendorId:'',billNumber:'',date:localToday(),dueDate:'',description:'',amount:'',category:'',accountId:'',notes:''}
  const[form,setForm]=useState(init)
  const f=(k:string)=>(e:React.ChangeEvent<HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement>)=>setForm(p=>({...p,[k]:e.target.value}))

  const filtered=tab==='all'?(bills as any[]):(bills as any[]).filter((b:any)=>tab==='open'?b.status==='open'||b.status==='partial':b.status==='paid')
  const totalOpen=(bills as any[]).filter((b:any)=>b.status==='open'||b.status==='partial').reduce((s:number,b:any)=>s+(+b.amount-+b.amountPaid),0)
  const overdue=(bills as any[]).filter((b:any)=>b.dueDate&&new Date(b.dueDate)<new Date()&&b.status!=='paid')

  const add=async(e:React.FormEvent)=>{
    e.preventDefault();setSaving(true);setErr('')
    try{
      await post('/books/bills',{...form,amount:+form.amount})
      qc.invalidateQueries('bills');qc.invalidateQueries('ven')
      setShowAdd(false);setForm(init)
    }catch(ex:any){setErr(ex.response?.data?.error||'Failed')}
    finally{setSaving(false)}
  }

  const payBill=async(id:string,amount:number)=>{
    try{
      await post('/books/bills/'+id+'/pay',{amount})
      qc.invalidateQueries('bills');qc.invalidateQueries('ven')
    }catch(ex:any){toast.error(ex.response?.data?.error||'Could not record the payment.')}
  }

  const STATUS:Record<string,string>={open:'ba',partial:'bb',paid:'bg2',void:'bmu'}
  const expenseAccts=(accounts as any[]).filter((a:any)=>a.type==='expense')

  return(
    <div>
      <div className="ph">
        <div><h1 className="pt">📄 Bills & AP</h1><p className="ps">{(bills as any[]).length} bills · {formatCurrency(totalOpen)} outstanding</p></div>
        <button className="btn bp" onClick={()=>setShowAdd(true)}>+ Add Bill</button>
      </div>

      {overdue.length>0&&<div className="alert ae">⚠ {overdue.length} bill{overdue.length!==1?'s':''} overdue. Review and pay to avoid late fees.</div>}

      <div className="grid4" style={{marginBottom:16}}>
        <div className="kpi"><div className="kl">Open Bills</div><div className="kv a">{(bills as any[]).filter((b:any)=>b.status==='open').length}</div><div className="ks">Awaiting payment</div></div>
        <div className="kpi"><div className="kl">Total Outstanding</div><div className="kv r">{formatCurrency(totalOpen)}</div><div className="ks">AP balance</div></div>
        <div className="kpi"><div className="kl">Overdue</div><div className={`kv ${overdue.length>0?'r':'g'}`}>{overdue.length}</div><div className="ks">Past due date</div></div>
        {/* 10/11: each payment on its own day (the server's paidThisMonth), so a bill paid in parts counts each part in its month. */}
        <div className="kpi"><div className="kl">Paid This Month</div><div className="kv g">{formatCurrency((bills as any[]).reduce((s:number,b:any)=>s+(+b.paidThisMonth||0),0))}</div><div className="ks">Bill payments since the 1st</div></div>
      </div>

      <div className="tabs">
        <button className={`tab ${tab==='open'?'on':''}`} onClick={()=>setTab('open')}>Open ({(bills as any[]).filter((b:any)=>b.status==='open'||b.status==='partial').length})</button>
        <button className={`tab ${tab==='paid'?'on':''}`} onClick={()=>setTab('paid')}>Paid ({(bills as any[]).filter((b:any)=>b.status==='paid').length})</button>
        <button className={`tab ${tab==='all'?'on':''}`} onClick={()=>setTab('all')}>All ({(bills as any[]).length})</button>
      </div>

      <div className="card" style={{padding:0}}>
        {isLoading?<div style={{padding:32,color:'var(--t3)',textAlign:'center'}}><span className="spinner" style={{display:'inline-block'}}/></div>:(
          <table className="tbl">
            <thead><tr><th>Date</th><th>Vendor</th><th>Description</th><th>Due</th><th>Amount</th><th>Paid</th><th>Balance</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {(filtered as any[]).length?(filtered as any[]).map((b:any)=>{
                const isOverdue=b.dueDate&&new Date(b.dueDate)<new Date()&&b.status!=='paid'
                return(
                  <tr key={b.id} style={{background:isOverdue?'rgba(239,68,68,.03)':''}}>
                    <td className="mono" style={{fontSize:'.72rem'}}>{new Date(b.date+'T12:00:00').toLocaleDateString()}</td>
                    <td style={{fontSize:'.75rem',color:'var(--t0)'}}>{b.vendorName||'—'}</td>
                    <td style={{fontSize:'.78rem'}}>{b.description}</td>
                    <td className="mono" style={{fontSize:'.72rem',color:isOverdue?'var(--red)':'var(--t3)'}}>{b.dueDate?new Date(b.dueDate+'T12:00:00').toLocaleDateString():'—'}{isOverdue&&' ⚠'}</td>
                    <td className="mono">{formatCurrency(b.amount)}</td>
                    <td className="mono" style={{color:'var(--green)'}}>{+b.amountPaid>0?formatCurrency(b.amountPaid):'—'}</td>
                    <td className="mono" style={{color:'var(--red)',fontWeight:600}}>{formatCurrency(+b.amount-+b.amountPaid)}</td>
                    <td><span className={`badge ${STATUS[b.status]||'bmu'}`}>{humanize(b.status)}</span></td>
                    <td>{b.status!=='paid'&&<button className="btn bp bsm" onClick={()=>payBill(b.id,+b.amount-+b.amountPaid)}>Pay Full</button>}</td>
                  </tr>
                )
              }):<tr><td colSpan={9}><div className="empty">No {tab==='open'?'open ':''}bills.</div></td></tr>}
            </tbody>
          </table>
        )}
      </div>

      {showAdd&&(
        <Modal title="Add Bill" onClose={()=>setShowAdd(false)}>
          {err&&<div className="alert ae">{err}</div>}
          <form onSubmit={add}>
            <div className="frow"><label>Vendor</label>
              <select value={form.vendorId} onChange={f('vendorId')}>
                <option value="">— No vendor —</option>
                {(vendors as any[]).map((v:any)=><option key={v.id} value={v.id}>{v.name}</option>)}
              </select>
            </div>
            <div className="frow2">
              <div><label>Bill Date</label><input type="date" value={form.date} onChange={f('date')} required/></div>
              <div><label>Due Date</label><input type="date" value={form.dueDate} onChange={f('dueDate')}/></div>
            </div>
            <div className="frow"><label>Description</label><input type="text" value={form.description} onChange={f('description')} required placeholder="e.g. APS Electric — March"/></div>
            <div className="frow2">
              <div><label>Amount</label><input type="number" min="0.01" step="0.01" value={form.amount} onChange={f('amount')} required/></div>
              <div><label>Bill # (optional)</label><input type="text" value={form.billNumber} onChange={f('billNumber')}/></div>
            </div>
            <div className="frow"><label>Expense Account</label>
              <select value={form.accountId} onChange={f('accountId')}>
                <option value="">— Uncategorized —</option>
                {expenseAccts.map((a:any)=><option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}
              </select>
            </div>
            <div className="frow"><label>Notes</label><textarea rows={2} value={form.notes} onChange={f('notes')}/></div>
            <div className="factions">
              <button type="button" className="btn bg-btn" onClick={()=>setShowAdd(false)}>Cancel</button>
              <button type="submit" className="btn bp" disabled={saving}>{saving?<><span className="spinner"/>Saving…</>:'Add Bill'}</button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  )
}

/**
 * 10/12 (Nic, ledger P6, L5): money out is ONE record — the Expenses record.
 * A landlord company's Books Bills moved onto it (migration 20261014180300; each
 * original kept, read only, pointing where it went), so this page retires for
 * a landlord company and points there. A business's books keep it until the
 * business books phase.
 */
export function BillsPage(){
  const role=useBooksRole()
  const landlordBooks=role!=='business_owner'
  const{data:old=[]}=useQuery(['retired-bills'],()=>get<any[]>('/books/bills'),{enabled:landlordBooks})
  if(!landlordBooks)return <BusinessBillsPage/>
  return(
    <div>
      <div className="ph"><div><h1 className="pt">📄 Bills & AP</h1><p className="ps">Bills to pay are on Expenses now.</p></div></div>
      <div className="alert agold" style={{alignItems:'center'}}>
        <span style={{flex:1}}>A bill is an unpaid expense now: add it on Expenses (A bill to pay), record its payments there, and match the bank line that paid it on the Bank page. Your bills from here were moved there, each with its payments.</span>
        <Link to={expensesPagePath()} className="btn bp bsm">Open Expenses</Link>
      </div>
      {(old as any[]).length>0&&(
        <div className="card" style={{overflowX:'auto'}}>
          <div className="ct" style={{marginBottom:8}}>What was here before (read only)</div>
          <table>
            <thead><tr><th>Date</th><th>Description</th><th style={{textAlign:'right'}}>Amount</th><th>Now</th></tr></thead>
            <tbody>{(old as any[]).map((r:any)=>(
              <tr key={r.id}>
                <td>{String(r.date??'').slice(0,10)}</td>
                <td>{r.description}</td>
                <td style={{textAlign:'right'}}>{formatCurrency(+r.amount)}</td>
                <td className="bnote">{r.migratedExpenseId||r.migratedOtherIncomeId?'On Expenses':r.deletedAt?'Removed':'Not moved'}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </div>
  )
}
