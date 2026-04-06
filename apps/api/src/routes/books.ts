import { Router } from 'express'
import { db, queryOne } from '../db'
import { requireAuth, requireLandlord } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'

export const booksRouter = Router()
booksRouter.use(requireAuth)

// ── Scope helper — admin sees all, landlord sees own ──────────
function landlordScope(user: any) {
  if (user.role === 'admin' || user.role === 'super_admin') return null
  return user.landlordId || user.profileId
}

// ════════════════════════════════════════
// CHART OF ACCOUNTS
// ════════════════════════════════════════

// GET /api/books/accounts
booksRouter.get('/accounts', async (req, res, next) => {
  try {
    const lid = landlordScope(req.user)
    const { rows } = await db.query(
      `SELECT * FROM books_accounts
       WHERE (landlord_id = $1 OR $1 IS NULL)
       AND active = TRUE
       ORDER BY code ASC`,
      [lid]
    )
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

// POST /api/books/accounts
booksRouter.post('/accounts', async (req, res, next) => {
  try {
    const lid = landlordScope(req.user)
    const { code, name, type, subtype, description } = req.body
    if (!code || !name || !type) throw new AppError(400, 'code, name, and type are required')
    const exists = await queryOne(
      'SELECT id FROM books_accounts WHERE code=$1 AND (landlord_id=$2 OR landlord_id IS NULL)',
      [code, lid]
    )
    if (exists) throw new AppError(409, `Account code ${code} already exists`)
    const { rows: [acct] } = await db.query(
      `INSERT INTO books_accounts (landlord_id, code, name, type, subtype, description)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [lid, code, name, type, subtype || null, description || null]
    )
    res.status(201).json({ success: true, data: acct })
  } catch (e) { next(e) }
})

// PATCH /api/books/accounts/:id
booksRouter.patch('/accounts/:id', async (req, res, next) => {
  try {
    const lid = landlordScope(req.user)
    const { name, subtype, description, active } = req.body
    const { rows: [acct] } = await db.query(
      `UPDATE books_accounts SET
         name=COALESCE($1,name), subtype=COALESCE($2,subtype),
         description=COALESCE($3,description), active=COALESCE($4,active),
         updated_at=NOW()
       WHERE id=$5 AND (landlord_id=$6 OR $6 IS NULL) RETURNING *`,
      [name||null, subtype||null, description||null, active??null, req.params.id, lid]
    )
    if (!acct) throw new AppError(404, 'Account not found')
    res.json({ success: true, data: acct })
  } catch (e) { next(e) }
})

// DELETE /api/books/accounts/:id
booksRouter.delete('/accounts/:id', async (req, res, next) => {
  try {
    const lid = landlordScope(req.user)
    await db.query(
      `UPDATE books_accounts SET active=FALSE, updated_at=NOW()
       WHERE id=$1 AND (landlord_id=$2 OR $2 IS NULL)`,
      [req.params.id, lid]
    )
    res.json({ success: true })
  } catch (e) { next(e) }
})

// POST /api/books/accounts/seed — seed standard property mgmt COA
booksRouter.post('/accounts/seed', async (req, res, next) => {
  try {
    const lid = landlordScope(req.user)
    const standardAccounts = [
      // Assets
      { code:'1010', name:'Checking Account',           type:'asset',     subtype:'bank' },
      { code:'1020', name:'Savings / Reserve Account',  type:'asset',     subtype:'bank' },
      { code:'1030', name:'Security Deposits Held',     type:'asset',     subtype:'current' },
      { code:'1100', name:'Accounts Receivable',        type:'asset',     subtype:'current' },
      { code:'1200', name:'Prepaid Expenses',           type:'asset',     subtype:'current' },
      { code:'1500', name:'Rental Property',            type:'asset',     subtype:'fixed' },
      { code:'1510', name:'Accumulated Depreciation',   type:'asset',     subtype:'fixed' },
      // Liabilities
      { code:'2010', name:'Accounts Payable',           type:'liability', subtype:'current' },
      { code:'2020', name:'Security Deposits Payable',  type:'liability', subtype:'current' },
      { code:'2030', name:'Payroll Liabilities',        type:'liability', subtype:'current' },
      { code:'2040', name:'Sales Tax Payable',          type:'liability', subtype:'current' },
      { code:'2100', name:'Mortgage Payable',           type:'liability', subtype:'longterm' },
      // Equity
      { code:'3010', name:'Owner Equity',               type:'equity',    subtype:null },
      { code:'3020', name:'Owner Draws',                type:'equity',    subtype:null },
      { code:'3030', name:'Retained Earnings',          type:'equity',    subtype:null },
      // Income
      { code:'4010', name:'Rental Income',              type:'income',    subtype:'operating' },
      { code:'4020', name:'Late Fee Income',            type:'income',    subtype:'operating' },
      { code:'4030', name:'Application Fee Income',     type:'income',    subtype:'operating' },
      { code:'4040', name:'Pet Fee Income',             type:'income',    subtype:'operating' },
      { code:'4050', name:'Laundry / Vending Income',   type:'income',    subtype:'operating' },
      { code:'4060', name:'Storage Fee Income',         type:'income',    subtype:'operating' },
      { code:'4070', name:'Utility Reimbursements',     type:'income',    subtype:'operating' },
      { code:'4900', name:'Other Income',               type:'income',    subtype:'other' },
      // Expenses
      { code:'5010', name:'Mortgage / Loan Interest',   type:'expense',   subtype:'operating' },
      { code:'5020', name:'Property Taxes',             type:'expense',   subtype:'operating' },
      { code:'5030', name:'Property Insurance',         type:'expense',   subtype:'operating' },
      { code:'5040', name:'Repairs & Maintenance',      type:'expense',   subtype:'operating' },
      { code:'5050', name:'Utilities',                  type:'expense',   subtype:'operating' },
      { code:'5060', name:'Landscaping',                type:'expense',   subtype:'operating' },
      { code:'5070', name:'Pest Control',               type:'expense',   subtype:'operating' },
      { code:'5080', name:'Property Management Fees',   type:'expense',   subtype:'operating' },
      { code:'5090', name:'Advertising & Marketing',    type:'expense',   subtype:'operating' },
      { code:'5100', name:'Legal & Professional Fees',  type:'expense',   subtype:'operating' },
      { code:'5110', name:'Accounting & Bookkeeping',   type:'expense',   subtype:'operating' },
      { code:'5120', name:'Payroll Expenses',           type:'expense',   subtype:'operating' },
      { code:'5130', name:'Contractor Payments',        type:'expense',   subtype:'operating' },
      { code:'5140', name:'Office Supplies',            type:'expense',   subtype:'operating' },
      { code:'5150', name:'Software & Subscriptions',   type:'expense',   subtype:'operating' },
      { code:'5160', name:'Vehicle & Travel',           type:'expense',   subtype:'operating' },
      { code:'5170', name:'Depreciation Expense',       type:'expense',   subtype:'operating' },
      { code:'5900', name:'Other Expenses',             type:'expense',   subtype:'other' },
    ]
    let inserted = 0
    for (const a of standardAccounts) {
      const exists = await queryOne(
        'SELECT id FROM books_accounts WHERE code=$1 AND (landlord_id=$2 OR landlord_id IS NULL)',
        [a.code, lid]
      )
      if (!exists) {
        await db.query(
          `INSERT INTO books_accounts (landlord_id, code, name, type, subtype, is_system)
           VALUES ($1,$2,$3,$4,$5,TRUE)`,
          [lid, a.code, a.name, a.type, a.subtype]
        )
        inserted++
      }
    }
    res.json({ success: true, data: { inserted, message: `${inserted} accounts added` } })
  } catch (e) { next(e) }
})

// ════════════════════════════════════════
// EMPLOYEES
// ════════════════════════════════════════

booksRouter.get('/employees', async (req, res, next) => {
  try {
    const lid = landlordScope(req.user)
    const { rows } = await db.query(
      `SELECT * FROM books_employees WHERE (landlord_id=$1 OR $1 IS NULL) ORDER BY last_name,first_name`,
      [lid]
    )
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

booksRouter.post('/employees', async (req, res, next) => {
  try {
    const lid = landlordScope(req.user)
    const { firstName, lastName, email, phone, address, ssnLast4, payType, payRate,
            payFrequency, filingStatus, federalAllowances, azWithholdingPct,
            title, department, startDate } = req.body
    if (!firstName || !lastName || !payType || payRate === undefined)
      throw new AppError(400, 'firstName, lastName, payType, payRate required')
    const { rows: [emp] } = await db.query(
      `INSERT INTO books_employees
         (landlord_id, first_name, last_name, email, phone, address, ssn_last4,
          pay_type, pay_rate, pay_frequency, filing_status, federal_allowances,
          az_withholding_pct, title, department, start_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
      [lid, firstName, lastName, email||null, phone||null, address||null, ssnLast4||null,
       payType, payRate, payFrequency||'biweekly', filingStatus||'single',
       federalAllowances||0, azWithholdingPct||2.5, title||null, department||null, startDate||null]
    )
    res.status(201).json({ success: true, data: emp })
  } catch (e) { next(e) }
})

booksRouter.patch('/employees/:id', async (req, res, next) => {
  try {
    const lid = landlordScope(req.user)
    const f = req.body
    const { rows: [emp] } = await db.query(
      `UPDATE books_employees SET
         first_name=COALESCE($1,first_name), last_name=COALESCE($2,last_name),
         email=COALESCE($3,email), phone=COALESCE($4,phone), title=COALESCE($5,title),
         department=COALESCE($6,department), pay_type=COALESCE($7,pay_type),
         pay_rate=COALESCE($8,pay_rate), pay_frequency=COALESCE($9,pay_frequency),
         status=COALESCE($10,status), updated_at=NOW()
       WHERE id=$11 AND (landlord_id=$12 OR $12 IS NULL) RETURNING *`,
      [f.firstName||null, f.lastName||null, f.email||null, f.phone||null,
       f.title||null, f.department||null, f.payType||null, f.payRate||null,
       f.payFrequency||null, f.status||null, req.params.id, lid]
    )
    if (!emp) throw new AppError(404, 'Employee not found')
    res.json({ success: true, data: emp })
  } catch (e) { next(e) }
})

// ════════════════════════════════════════
// CONTRACTORS
// ════════════════════════════════════════

booksRouter.get('/contractors', async (req, res, next) => {
  try {
    const lid = landlordScope(req.user)
    const { rows } = await db.query(
      `SELECT * FROM books_contractors WHERE (landlord_id=$1 OR $1 IS NULL) ORDER BY created_at DESC`,
      [lid]
    )
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

booksRouter.post('/contractors', async (req, res, next) => {
  try {
    const lid = landlordScope(req.user)
    const { firstName, lastName, businessName, email, phone, address, ein, ssnLast4,
            entityType, trade, payRate, payUnit, w9OnFile } = req.body
    const { rows: [con] } = await db.query(
      `INSERT INTO books_contractors
         (landlord_id, first_name, last_name, business_name, email, phone, address,
          ein, ssn_last4, entity_type, trade, pay_rate, pay_unit, w9_on_file)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [lid, firstName||null, lastName||null, businessName||null, email||null,
       phone||null, address||null, ein||null, ssnLast4||null,
       entityType||'individual', trade||null, payRate||null, payUnit||'project', w9OnFile||false]
    )
    res.status(201).json({ success: true, data: con })
  } catch (e) { next(e) }
})

booksRouter.patch('/contractors/:id', async (req, res, next) => {
  try {
    const lid = landlordScope(req.user)
    const f = req.body
    const { rows: [con] } = await db.query(
      `UPDATE books_contractors SET
         first_name=COALESCE($1,first_name), last_name=COALESCE($2,last_name),
         business_name=COALESCE($3,business_name), email=COALESCE($4,email),
         trade=COALESCE($5,trade), pay_rate=COALESCE($6,pay_rate),
         status=COALESCE($7,status), w9_on_file=COALESCE($8,w9_on_file), updated_at=NOW()
       WHERE id=$9 AND (landlord_id=$10 OR $10 IS NULL) RETURNING *`,
      [f.firstName||null, f.lastName||null, f.businessName||null, f.email||null,
       f.trade||null, f.payRate||null, f.status||null, f.w9OnFile??null,
       req.params.id, lid]
    )
    if (!con) throw new AppError(404, 'Contractor not found')
    res.json({ success: true, data: con })
  } catch (e) { next(e) }
})

// ════════════════════════════════════════
// VENDORS
// ════════════════════════════════════════

booksRouter.get('/vendors', async (req, res, next) => {
  try {
    const lid = landlordScope(req.user)
    const { rows } = await db.query(
      `SELECT * FROM books_vendors WHERE (landlord_id=$1 OR $1 IS NULL) AND status='active' ORDER BY name`,
      [lid]
    )
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

booksRouter.post('/vendors', async (req, res, next) => {
  try {
    const lid = landlordScope(req.user)
    const { name, contactName, email, phone, address, category, paymentTerms, accountNumber, taxId, notes } = req.body
    if (!name) throw new AppError(400, 'name is required')
    const { rows: [v] } = await db.query(
      `INSERT INTO books_vendors
         (landlord_id, name, contact_name, email, phone, address, category, payment_terms, account_number, tax_id, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [lid, name, contactName||null, email||null, phone||null, address||null,
       category||null, paymentTerms||'net30', accountNumber||null, taxId||null, notes||null]
    )
    res.status(201).json({ success: true, data: v })
  } catch (e) { next(e) }
})

booksRouter.patch('/vendors/:id', async (req, res, next) => {
  try {
    const lid = landlordScope(req.user)
    const f = req.body
    const { rows: [v] } = await db.query(
      `UPDATE books_vendors SET
         name=COALESCE($1,name), contact_name=COALESCE($2,contact_name),
         email=COALESCE($3,email), phone=COALESCE($4,phone),
         category=COALESCE($5,category), payment_terms=COALESCE($6,payment_terms),
         status=COALESCE($7,status), notes=COALESCE($8,notes), updated_at=NOW()
       WHERE id=$9 AND (landlord_id=$10 OR $10 IS NULL) RETURNING *`,
      [f.name||null, f.contactName||null, f.email||null, f.phone||null,
       f.category||null, f.paymentTerms||null, f.status||null, f.notes||null,
       req.params.id, lid]
    )
    if (!v) throw new AppError(404, 'Vendor not found')
    res.json({ success: true, data: v })
  } catch (e) { next(e) }
})
