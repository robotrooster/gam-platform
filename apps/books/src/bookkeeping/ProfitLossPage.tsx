/**
 * 10/12 (Nic): the Books profit and loss — the ledger, with GAM income beside it.
 *
 * GAM Books' own page, shown in GAM Books and inside the landlord portal's
 * Bookkeeping menu — the same bytes in apps/books and apps/landlord
 * (bookkeeping-parity.test.ts). How it reaches the API, shows a toast and
 * links to another Books page is the app's own (./adapter).
 */
import { useState } from 'react'
import { useQuery } from 'react-query'
import { formatCurrency, MONEY_COLUMN_LABEL } from '@gam/shared'
import { booksGet as get, useBooksRole } from './adapter'
import { MoneyThreeTable, MoneyTieLines, type MoneyThreeRow } from './common'
import { localToday, loadErrorText, splitBeside, PAID_AHEAD_COUNTED_NOTE } from './booksMoney'
// 10/12 (Nic, ledger P8): once the company's books are live the P&L is read
// from them — income in Received, Charged and Owed with the strip that ties
// Owed, expenses paid and incurred, money out (./LedgerStatements).
import { LedgerProfitLossView } from './LedgerStatements'

// ── P&L REPORT ────────────────────────────────────────────────────────
export function ProfitLossPage(){
  const now=new Date()
  const[startDate,setStartDate]=useState(`${now.getFullYear()}-01-01`)
  const[endDate,setEndDate]=useState(localToday(now))
  const{data,isLoading,error}=useQuery(['pl',startDate,endDate],()=>get<any>(`/books/reports/pl?startDate=${startDate}&endDate=${endDate}`))

  const income=(data as any)?.income||[]
  const expenses=(data as any)?.expenses||[]
  const totalIncome=(data as any)?.totalIncome||0
  const totalExpenses=(data as any)?.totalExpenses||0
  const netIncome=(data as any)?.netIncome||0
  const gamRent=(data as any)?.gamRentIncome||0
  // S655 → 10/12 (Nic): the GAM P&L — the landlord reports' own. "NO Money
  // received / Money billed toggle anywhere": its income lines (rent, fees,
  // utilities, paid ahead, register sales, credits given, ...) show Received,
  // Charged and Owed side by side (gamPL.view, Received leads) and add up to
  // each column's total, with the tie line under them; its expenses are GAM's
  // platform fee, the payment processing fees the landlord covers (always
  // listed), maintenance, lot rent and expenses entered in GAM; the net is
  // shown on each money column.
  const gamPL=(data as any)?.gamPL
  const gamView=gamPL?.view
  const gamRows:MoneyThreeRow[]=gamView
    ?(gamView.lines??[]).map((l:any)=>({key:l.line,label:l.label,received:l.received,charged:l.charged,owed:l.owed}))
    :(gamPL?.lineItems??[]).map((l:any)=>({key:l.line,label:l.label,received:l.amount,charged:null,owed:null}))
  const gamBeside:any[]=gamPL?.besideItems??[]
  // The paid-ahead money on hand already counted on the day it arrived, so it
  // is shown on its own line, never as "beside the total" (booksMoney: splitBeside).
  const{aside:gamAside,onHand:gamPaidAhead}=splitBeside(gamBeside)
  const gamExpenses:Array<{key:string;label:string;amount:number}>=gamPL?.expenses?[
    {key:'platformFee',label:'GAM platform fee',amount:Number(gamPL.expenses.platformFee||0)},
    {key:'processingFees',label:'Payment processing fees',amount:Number(gamPL.expenses.processingFees||0)},
    // 10/12 (Nic, G10): card fees guests got back with refunds of card sales.
    ...(Number(gamPL.expenses.cardFeesRefunded)?[{key:'cardFeesRefunded',label:'Card fees refunded',amount:Number(gamPL.expenses.cardFeesRefunded)}]:[]),
    ...(Number(gamPL.expenses.maintenance)?[{key:'maintenance',label:'Maintenance',amount:Number(gamPL.expenses.maintenance)}]:[]),
    ...(Number(gamPL.expenses.lotRent)?[{key:'lotRent',label:'Lot rent',amount:Number(gamPL.expenses.lotRent)}]:[]),
    ...(Number(gamPL.expenses.enteredExpenses)?[{key:'enteredExpenses',label:'Expenses entered in GAM',amount:Number(gamPL.expenses.enteredExpenses)}]:[]),
  ]:[]
  const gamNets={received:Number(gamPL?.nets?.received??gamPL?.net??0),charged:gamPL?.nets?.charged}
  // GAM's landlord income; a business's books have none.
  const role=useBooksRole()
  const isBusiness=role==='business_owner'||role==='business_staff'

  // 10/12 (Nic, ledger P8): the books themselves, once they are live.
  if(!error&&(data as any)?.source==='ledger')return <LedgerProfitLossView data={data} startDate={startDate} endDate={endDate} setStartDate={setStartDate} setEndDate={setEndDate}/>

  return(
    <div>
      <div className="ph">
        <div><h1 className="pt">📈 Profit & Loss</h1><p className="ps">Income statement · {new Date(startDate+'T12:00:00').toLocaleDateString()} – {new Date(endDate+'T12:00:00').toLocaleDateString()}</p></div>
        <div style={{display:'flex',gap:8,alignItems:'center',flexWrap:'wrap'}}>
          <input type="date" value={startDate} onChange={e=>setStartDate(e.target.value)} style={{width:'auto',padding:'5px 8px',fontSize:'.75rem'}}/>
          <span style={{color:'var(--t3)'}}>to</span>
          <input type="date" value={endDate} onChange={e=>setEndDate(e.target.value)} style={{width:'auto',padding:'5px 8px',fontSize:'.75rem'}}/>
        </div>
      </div>
      {/* 10/11: a refused report says why — never "$0.00 Profitable" under it. */}
      {!!error?<div className="alert aw">{loadErrorText(error,'Could not load the profit and loss.')}</div>:<>
      <div className="grid4" style={{marginBottom:16}}>
        <div className="kpi"><div className="kl">Ledger Income</div><div className="kv g">{formatCurrency(totalIncome)}</div><div className="ks">{income.length} income accounts</div></div>
        {!isBusiness&&<div className="kpi"><div className="kl">GAM income · {MONEY_COLUMN_LABEL.received}</div><div className="kv gold">{formatCurrency(gamView?.received??gamRent)}</div><div className="ks">{gamView?`${MONEY_COLUMN_LABEL.charged} ${formatCurrency(gamView.charged)} · from your GAM properties`:'From your GAM properties'}</div></div>}
        <div className="kpi"><div className="kl">Ledger Expenses</div><div className="kv r">{formatCurrency(totalExpenses)}</div><div className="ks">{expenses.length} expense accounts</div></div>
        <div className="kpi"><div className="kl">Ledger Net Income</div><div className={`kv ${netIncome>=0?'g':'r'}`}>{formatCurrency(netIncome)}</div><div className="ks">{netIncome>=0?'Profitable':'Loss'}</div></div>
      </div>

      {isLoading?<div style={{padding:32,color:'var(--t3)',textAlign:'center'}}><span className="spinner" style={{display:'inline-block'}}/></div>:(
        <div className="grid2">
          <div>
            {(gamPL||gamRent!==0)&&(
              <div className="card" style={{marginBottom:12}}>
                <div className="ct">🏘 GAM income</div>
                <MoneyThreeTable rows={gamRows} totalLabel="Total GAM income"
                  total={gamView?{received:gamView.received,charged:gamView.charged,owed:gamView.owed}:{received:gamRent,charged:null,owed:null}}/>
                <MoneyTieLines lines={gamView?.tieText}/>
                {gamPaidAhead&&(
                  <div className="dr dr-sub"><span className="dk">{gamPaidAhead.label} — {PAID_AHEAD_COUNTED_NOTE}</span><span className="dv mono">{formatCurrency(gamPaidAhead.amount)}</span></div>
                )}
                {gamExpenses.map(e=>(
                  <div key={e.key} className="dr"><span className="dk">{e.label}</span><span className="dv mono" style={{color:'var(--red)'}}>({formatCurrency(e.amount)})</span></div>
                ))}
                {gamPL?.expenses&&(<>
                  <div className="dr" style={{borderTop:'1px solid var(--b1)',paddingTop:6,marginTop:4}}><span className="dk" style={{fontWeight:700}}>GAM net · on {MONEY_COLUMN_LABEL.received.toLowerCase()}</span><span className="dv mono" style={{color:gamNets.received>=0?'var(--green)':'var(--red)',fontWeight:700}}>{formatCurrency(gamNets.received)}</span></div>
                  {gamNets.charged!=null&&<div className="dr"><span className="dk">GAM net · on {MONEY_COLUMN_LABEL.charged.toLowerCase()}</span><span className="dv mono" style={{color:Number(gamNets.charged)>=0?'var(--green)':'var(--red)'}}>{formatCurrency(Number(gamNets.charged))}</span></div>}
                </>)}
                {gamAside.length>0&&(
                  <div style={{marginTop:8,paddingTop:6,borderTop:'1px dashed var(--b1)'}}>
                    {gamAside.map((b:any)=>(
                      <div key={b.key} className="dr"><span className="dk">{b.label} (beside the total)</span><span className="dv mono">{formatCurrency(b.amount)}</span></div>
                    ))}
                  </div>
                )}
              </div>
            )}
            <div className="card" style={{marginBottom:12}}>
              <div className="ct">Ledger income accounts</div>
              {income.map((a:any)=>(
                <div key={a.code} className="dr">
                  <span className="dk">{a.code} · {a.name}</span>
                  <span className="dv mono" style={{color:'var(--green)'}}>{formatCurrency(a.periodAmount)}</span>
                </div>
              ))}
              {income.length===0&&<div style={{color:'var(--t3)',fontSize:'.78rem',padding:'8px 0'}}>No ledger income recorded. Post journal entries to your income accounts.</div>}
              <div className="dr" style={{borderTop:'2px solid var(--b1)',marginTop:8,paddingTop:8}}>
                <span style={{fontWeight:700,color:'var(--t0)',fontFamily:'var(--font-d)'}}>Total Ledger Income</span>
                <span style={{fontFamily:'var(--font-m)',fontWeight:700,color:'var(--green)',fontSize:'1rem'}}>{formatCurrency(totalIncome)}</span>
              </div>
            </div>

            <div className="card">
              <div className="ct">Expenses</div>
              {expenses.map((a:any)=>(
                <div key={a.code} className="dr">
                  <span className="dk">{a.code} · {a.name}</span>
                  <span className="dv mono" style={{color:'var(--red)'}}>{formatCurrency(a.periodAmount)}</span>
                </div>
              ))}
              {expenses.length===0&&<div style={{color:'var(--t3)',fontSize:'.78rem',padding:'8px 0'}}>No expenses recorded.</div>}
              <div className="dr" style={{borderTop:'2px solid var(--b1)',marginTop:8,paddingTop:8}}>
                <span style={{fontWeight:700,color:'var(--t0)',fontFamily:'var(--font-d)'}}>Total Expenses</span>
                <span style={{fontFamily:'var(--font-m)',fontWeight:700,color:'var(--red)',fontSize:'1rem'}}>{formatCurrency(totalExpenses)}</span>
              </div>
            </div>
          </div>

          <div className="card" style={{alignSelf:'start'}}>
            <div className="ct">Ledger Net Income Summary</div>
            <div className="dr"><span className="dk">Total Ledger Income</span><span className="dv mono" style={{color:'var(--green)'}}>{formatCurrency(totalIncome)}</span></div>
            <div className="dr"><span className="dk">Total Ledger Expenses</span><span className="dv mono" style={{color:'var(--red)'}}>({formatCurrency(totalExpenses)})</span></div>
            <div style={{borderTop:'2px solid var(--b1)',marginTop:12,paddingTop:12,display:'flex',justifyContent:'space-between',alignItems:'center'}}>
              <span style={{fontFamily:'var(--font-d)',fontWeight:800,fontSize:'1rem',color:'var(--t0)'}}>NET INCOME</span>
              <span style={{fontFamily:'var(--font-d)',fontWeight:800,fontSize:'1.4rem',color:netIncome>=0?'var(--green)':'var(--red)'}}>{formatCurrency(netIncome)}</span>
            </div>
            <div style={{marginTop:16,padding:'12px',background:'var(--bg3)',borderRadius:8,fontSize:'.72rem',color:'var(--t3)',lineHeight:1.6}}>
              <strong style={{color:'var(--t2)'}}>Note:</strong> Net income here is your ledger: the journal entries posted to your income and expense accounts. Income and expense transactions entered in Books are not part of it (they are in Cash Flow). GAM income is shown on its own, from your GAM properties, and is not added into the ledger totals.
            </div>
          </div>
        </div>
      )}
      </>}
    </div>
  )
}
