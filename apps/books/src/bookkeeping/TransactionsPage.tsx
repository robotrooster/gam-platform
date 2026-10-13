/**
 * 10/12 (Nic): the Books transactions list. (Nic decided money out is one record; this page retires with the ledger rebuild — ported unchanged until then.)
 *
 * GAM Books' own page, shown in GAM Books and inside the landlord portal's
 * Bookkeeping menu — the same bytes in apps/books and apps/landlord
 * (bookkeeping-parity.test.ts). How it reaches the API, shows a toast and
 * links to another Books page is the app's own (./adapter).
 */
import React, { useState } from 'react'
import { useQuery, useQueryClient } from 'react-query'
import { formatCurrency, humanize, BOOKS_TRANSACTION_TYPES, BOOKS_TRANSACTION_TYPE_LABEL } from '@gam/shared'
import { booksGet as get, useBooksRole, expensesPagePath, booksPost as post, booksPatch as patch } from './adapter'
import { Link } from 'react-router-dom'
import { Modal } from './common'
import { localToday } from './booksMoney'

// ── TRANSACTIONS ──────────────────────────────────────────────────────
function BusinessTransactionsPage(){
  const qc=useQueryClient()
  const{data:txs=[],isLoading}=useQuery('txs',()=>get<any[]>('/books/transactions'))
  // 10/11: the tiles' totals cover every transaction (the list stops at 100).
  const{data:sum}=useQuery(['txs','summary'],()=>get<any>('/books/transactions/summary'))
  const{data:accounts=[]}=useQuery('acct',()=>get<any[]>('/books/accounts'))
  const[tab,setTab]=useState<'all'|'income'|'expense'>('all')
  const[showAdd,setShowAdd]=useState(false)
  const[err,setErr]=useState('')
  const[saving,setSaving]=useState(false)
  const init={date:localToday(),description:'',amount:'',type:'expense',category:'',accountId:'',reference:''}
  const[form,setForm]=useState(init)
  const f=(k:string)=>(e:React.ChangeEvent<HTMLInputElement|HTMLSelectElement>)=>setForm(p=>({...p,[k]:e.target.value}))

  const filtered=tab==='all'?(txs as any[]):(txs as any[]).filter((t:any)=>t.type===tab)
  const totalIncome=+(sum?.totalIncome??0)
  const totalExpense=+(sum?.totalExpenses??0)
  const unreconciled=+(sum?.unreconciled??0)
  const shownNote=sum&&sum.count>(txs as any[]).length?` · showing the newest ${(txs as any[]).length}`:''

  const add=async(e:React.FormEvent)=>{
    e.preventDefault();setSaving(true);setErr('')
    try{
      await post('/books/transactions',{...form,amount:+form.amount})
      qc.invalidateQueries('txs');setShowAdd(false);setForm(init)
    }catch(ex:any){setErr(ex.response?.data?.error||'Failed')}
    finally{setSaving(false)}
  }

  const reconcile=async(id:string)=>{
    await patch('/books/transactions/'+id+'/reconcile')
    qc.invalidateQueries('txs')
  }

  return(
    <div>
      <div className="ph">
        <div><h1 className="pt">💳 Transactions</h1><p className="ps">{sum?.count??(txs as any[]).length} transactions · {unreconciled} unreconciled{shownNote}</p></div>
        <button className="btn bp" onClick={()=>setShowAdd(true)}>+ Add Transaction</button>
      </div>

      <div className="grid4" style={{marginBottom:16}}>
        <div className="kpi"><div className="kl">Total Income</div><div className="kv g">{formatCurrency(totalIncome)}</div><div className="ks">{sum?.incomeCount??0} transactions</div></div>
        <div className="kpi"><div className="kl">Total Expenses</div><div className="kv r">{formatCurrency(totalExpense)}</div><div className="ks">{sum?.expenseCount??0} transactions</div></div>
        <div className="kpi"><div className="kl">Net</div><div className={`kv ${totalIncome-totalExpense>=0?'g':'r'}`}>{formatCurrency(totalIncome-totalExpense)}</div><div className="ks">Income minus expenses</div></div>
        <div className="kpi"><div className="kl">Unreconciled</div><div className={`kv ${unreconciled>0?'a':'g'}`}>{unreconciled}</div><div className="ks">Pending reconciliation</div></div>
      </div>

      <div className="tabs">
        <button className={`tab ${tab==='all'?'on':''}`} onClick={()=>setTab('all')}>All ({(txs as any[]).length})</button>
        <button className={`tab ${tab==='income'?'on':''}`} onClick={()=>setTab('income')}>Income ({(txs as any[]).filter((t:any)=>t.type==='income').length})</button>
        <button className={`tab ${tab==='expense'?'on':''}`} onClick={()=>setTab('expense')}>Expenses ({(txs as any[]).filter((t:any)=>t.type==='expense').length})</button>
      </div>

      <div className="card" style={{padding:0}}>
        {isLoading?<div style={{padding:32,color:'var(--t3)',textAlign:'center'}}><span className="spinner" style={{display:'inline-block'}}/></div>:(
          <table className="tbl">
            <thead><tr><th>Date</th><th>Description</th><th>Category</th><th>Account</th><th>Amount</th><th>Type</th><th>Reconciled</th></tr></thead>
            <tbody>
              {(filtered as any[]).length?(filtered as any[]).map((t:any)=>(
                <tr key={t.id}>
                  <td className="mono" style={{fontSize:'.72rem'}}>{new Date(t.date+'T12:00:00').toLocaleDateString()}</td>
                  <td style={{color:'var(--t0)',fontSize:'.78rem'}}>{t.description}</td>
                  <td style={{fontSize:'.72rem',color:'var(--t2)'}}>{t.category||'—'}</td>
                  <td style={{fontSize:'.72rem',color:'var(--t3)'}}>{t.accountName?t.code+' · '+t.accountName:'—'}</td>
                  <td className="mono" style={{color:t.type==='income'?'var(--green)':'var(--red)',fontWeight:600}}>{t.type==='income'?'+':'-'}{formatCurrency(t.amount)}</td>
                  <td><span className={t.type==='income'?'badge bg2':'badge br'}>{(BOOKS_TRANSACTION_TYPE_LABEL as Record<string,string>)[t.type]??humanize(t.type)}</span></td>
                  <td>{t.reconciled?<span className="badge bg2">✓</span>:<button className="btn bp bsm" onClick={()=>reconcile(t.id)}>Mark</button>}</td>
                </tr>
              )):<tr><td colSpan={7}><div className="empty">No transactions yet.</div></td></tr>}
            </tbody>
          </table>
        )}
      </div>

      {showAdd&&(
        <Modal title="Add Transaction" onClose={()=>setShowAdd(false)}>
          {err&&<div className="alert ae">{err}</div>}
          <form onSubmit={add}>
            <div className="frow2">
              <div><label>Date</label><input type="date" value={form.date} onChange={f('date')} required/></div>
              <div><label>Type</label>
                <select value={form.type} onChange={f('type')}>
                  {BOOKS_TRANSACTION_TYPES.map(t=><option key={t} value={t}>{BOOKS_TRANSACTION_TYPE_LABEL[t]}</option>)}
                </select>
              </div>
            </div>
            <div className="frow"><label>Description</label><input type="text" value={form.description} onChange={f('description')} required/></div>
            <div className="frow2">
              <div><label>Amount</label><input type="number" min="0.01" step="0.01" value={form.amount} onChange={f('amount')} required/></div>
              <div><label>Category</label><input type="text" value={form.category} onChange={f('category')} maxLength={100} placeholder="e.g. Repairs, Rent"/></div>
            </div>
            <div className="frow"><label>Account</label>
              <select value={form.accountId} onChange={f('accountId')}>
                <option value="">— Uncategorized —</option>
                {(accounts as any[]).map((a:any)=><option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}
              </select>
            </div>
            <div className="frow"><label>Reference (optional)</label><input type="text" value={form.reference} onChange={f('reference')} placeholder="Check #, invoice #…"/></div>
            <div className="factions">
              <button type="button" className="btn bg-btn" onClick={()=>setShowAdd(false)}>Cancel</button>
              <button type="submit" className="btn bp" disabled={saving}>{saving?<><span className="spinner"/>Saving…</>:'Add Transaction'}</button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  )
}

/**
 * 10/12 (Nic, ledger P6, L5): money out is ONE record — the Expenses record.
 * A landlord company's Books Transactions moved onto it (migration 20261014180300; each
 * original kept, read only, pointing where it went), so this page retires for
 * a landlord company and points there. A business's books keep it until the
 * business books phase.
 */
export function TransactionsPage(){
  const role=useBooksRole()
  const landlordBooks=role!=='business_owner'
  const{data:old=[]}=useQuery(['retired-transactions'],()=>get<any[]>('/books/transactions'),{enabled:landlordBooks})
  if(!landlordBooks)return <BusinessTransactionsPage/>
  return(
    <div>
      <div className="ph"><div><h1 className="pt">💳 Transactions</h1><p className="ps">Money in and out is filed on Expenses and the Bank page now.</p></div></div>
      <div className="alert agold" style={{alignItems:'center'}}>
        <span style={{flex:1}}>Money going out is an expense (log it on Expenses, or file the bank line that paid it on the Bank page), and money coming in is filed on the Bank page. Your transactions from here were moved: money out to Expenses, money in to other income.</span>
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
                <td className="bnote">{r.migratedExpenseId||r.migratedOtherIncomeId?'Moved':r.deletedAt?'Removed':'Not moved'}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </div>
  )
}
