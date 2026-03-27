import fs from 'fs'
import path from 'path'
import { db } from './index'

async function migrate() {
  console.log('🗄️  Running GAM database migration…')
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8')
  try {
    await db.query(sql)
    console.log('✅  Schema applied successfully')

    // Seed initial platform state rows
    await db.query(`
      INSERT INTO reserve_fund_state (balance, target_balance, phase, reserve_rate, monthly_contribution)
      VALUES (0, 0, 1, 1.00, 0)
      ON CONFLICT DO NOTHING
    `)
    await db.query(`
      INSERT INTO float_account_state (balance, seed_capital, apy, monthly_interest)
      VALUES (25000, 25000, 0.045, 0)
      ON CONFLICT DO NOTHING
    `)
    console.log('✅  Initial platform state seeded')
  } catch (err: any) {
    // Ignore "already exists" errors so migration is idempotent
    if (err.code === '42P07' || err.message?.includes('already exists')) {
      console.log('ℹ️   Schema already up to date')
    } else {
      console.error('❌  Migration failed:', err.message)
      process.exit(1)
    }
  } finally {
    await db.end()
  }
}

migrate()
