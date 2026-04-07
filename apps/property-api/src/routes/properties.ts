import { Router, Request, Response } from 'express';
import { pool } from '../index';

const router = Router();

router.get('/search', async (req: Request, res: Response) => {
  try {
    const {
      q,
      min_price,
      max_price,
      min_units,
      max_units,
      portfolio,
      property_type,
      owner_type,
      sort = 'val_desc',
      use_type,
      is_rental,
      flood_zone,
      is_gated,
      is_golf,
      is_lake,
      is_mountain,
      is_premium,
      is_waterway,
      limit = '50',
      offset = '0'
    } = req.query;

    const conditions: string[] = [];
    const params: any[] = [];
    let i = 1;

    if (q) {
      // Use tsvector full-text search — scales to 100M+ rows
      const tsquery = (q as string).trim().split(/\s+/).filter(Boolean).map((w: string) => w.replace(/[^a-zA-Z0-9]/g,'')).filter(Boolean).join(' & ')
      conditions.push(`p.search_vector @@ to_tsquery('simple', $${i})`)
      params.push(tsquery); i++;
    }
    if (min_price) { conditions.push(`p.last_sale_price >= $${i++}`); params.push(Number(min_price)); }
    if (max_price) { conditions.push(`p.last_sale_price <= $${i++}`); params.push(Number(max_price)); }
    if (min_units) { conditions.push(`p.unit_count >= $${i++}`); params.push(Number(min_units)); }
    if (max_units) { conditions.push(`p.unit_count <= $${i++}`); params.push(Number(max_units)); }
    if (portfolio === 'true') { conditions.push(`p.portfolio_sale_flag = true`); }
    if (use_type) { conditions.push(`p.use_type = $${i++}`); params.push(use_type as string); }
    if (is_rental === 'true') { conditions.push(`p.is_rental = true`); }
    if (flood_zone === 'true') { conditions.push(`p.flood_zone IS NOT NULL`); }
    if (is_gated === 'true') { conditions.push(`p.is_gated = true`); }
    if (is_golf === 'true') { conditions.push(`p.is_golf = true`); }
    if (is_lake === 'true') { conditions.push(`p.is_lake = true`); }
    if (is_mountain === 'true') { conditions.push(`p.is_mountain_view = true`); }
    if (is_premium === 'true') { conditions.push(`p.is_premium_view = true`); }
    if (is_waterway === 'true') { conditions.push(`p.is_waterway = true`); }

    if (property_type) {
      const types = (property_type as string).split(',').map(t => t.trim()).filter(Boolean);
      if (types.length) {
        conditions.push(`p.property_type_std = ANY($${i++})`);
        params.push(types);
      }
    }

    if (owner_type) {
      const otypes = (owner_type as string).split(',').map(t => t.trim()).filter(Boolean);
      if (otypes.length) {
        conditions.push(`p.owner_type = ANY($${i++})`);
        params.push(otypes);
      }
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const orderMap: Record<string, string> = {
      val_desc: 'p.assessed_value DESC NULLS LAST',
      val_asc:  'p.assessed_value ASC NULLS LAST',
      addr:     'p.situs_address ASC',
      units_desc: 'p.unit_count DESC NULLS LAST',
      sale_desc: 'p.last_sale_date DESC NULLS LAST',
    };
    const orderBy = orderMap[sort as string] || orderMap.val_desc;

    // Use fast estimate for unfiltered queries, exact count only when filtered
    const countResult = conditions.length === 0
      ? await pool.query(`SELECT reltuples::bigint AS count FROM pg_class WHERE relname = 'parcels'`)
      : await pool.query(`SELECT COUNT(*) FROM parcels p ${where}`, params);

    const dataResult = await pool.query(
      `SELECT
        p.apn, p.owner_name_parsed, p.owner_name_raw, p.owner_type,
        p.situs_address, p.situs_city, p.situs_zip, p.situs_state,
        p.county, p.last_sale_price, p.last_sale_date,
        p.unit_count, p.property_type_std, p.property_type_raw,
        p.assessed_value, p.year_built, p.lot_size_sqft, p.lot_size_sqft,
        p.portfolio_sale_flag, p.portfolio_sale_id,
        p.owner_mailing_address, p.owner_mailing_city, p.owner_mailing_state, p.owner_mailing_zip,
        p.lat, p.lon
      FROM parcels p ${where}
      ORDER BY ${orderBy}
      LIMIT $${i} OFFSET $${i + 1}`,
      [...params, Number(limit), Number(offset)]
    );

    res.json({
      total: Number(countResult.rows[0].count),
      limit: Number(limit),
      offset: Number(offset),
      results: dataResult.rows
    });
  } catch (err: any) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/:apn', async (req: Request, res: Response) => {
  try {
    const { apn } = req.params;
    const result = await pool.query(
      `SELECT p.*,
              o.parcel_count, o.states_present, o.counties_present,
              (SELECT COUNT(*) FROM businesses b WHERE b.parcel_apn = p.apn) as business_count
       FROM parcels p
       LEFT JOIN owners o ON o.id = p.owner_id
       WHERE p.apn = $1`,
      [apn]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Parcel not found' });
    res.json(result.rows[0]);
  } catch (err: any) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Businesses at a parcel
router.get('/:apn/businesses', async (req: Request, res: Response) => {
  try {
    const { apn } = req.params;
    const result = await pool.query(
      `SELECT
        account_number, business_name, dba_name,
        situs_address, situs_zip,
        mailing_address, mailing_zip,
        full_cash_value, assessed_value,
        use_type, tax_period, class_code
       FROM businesses
       WHERE parcel_apn = $1
       ORDER BY full_cash_value DESC NULLS LAST`,
      [apn]
    );
    res.json({ count: result.rows.length, results: result.rows });
  } catch (err: any) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Mobile home park search from businesses table
router.get('/mobile-homes/search', async (req: Request, res: Response) => {
  try {
    const { q, limit = '50', offset = '0' } = req.query;
    const conditions: string[] = [
      `(b.business_name ILIKE '%mobile home%' OR b.business_name ILIKE '%manufactured home%' OR b.business_name ILIKE '%mobile village%' OR b.business_name ILIKE '%mobile ranch%' OR b.business_name ILIKE '%trailer park%' OR b.business_name ILIKE '%trailer village%' OR b.business_name ILIKE '%rv park%' OR b.business_name ILIKE '%rv village%' OR b.business_name ILIKE '%mobile estate%' OR b.business_name ILIKE '%mobile manor%' OR b.business_name ILIKE '%mobile park%')`
    ];
    const params: any[] = [];
    let i = 1;

    if (q) {
      conditions.push(`(b.business_name ILIKE $${i} OR b.situs_address ILIKE $${i})`);
      params.push(`%${q}%`); i++;
    }

    const where = `WHERE ${conditions.join(' AND ')}`;
    const countResult = await pool.query(`SELECT COUNT(*) FROM businesses b ${where}`, params);
    const dataResult = await pool.query(
      `SELECT b.account_number, b.business_name, b.dba_name,
              b.situs_address, b.situs_zip, b.mailing_address,
              b.full_cash_value, b.assessed_value, b.legal_class,
              b.class_code, b.tax_period,
              p.apn, p.lat, p.lon, p.owner_name_parsed, p.owner_type,
              p.lot_size_sqft, p.unit_count, p.last_sale_price, p.last_sale_date,
              p.parcel_assessed, p.parcel_fcv, p.subdivision_name,
              p.is_rental, p.owner_mailing_address, p.owner_mailing_city,
              p.owner_mailing_state, p.owner_mailing_zip
       FROM businesses b
       LEFT JOIN LATERAL (
         SELECT p.apn, p.lat, p.lon, p.owner_name_parsed, p.owner_type,
                p.lot_size_sqft, p.unit_count, p.last_sale_price, p.last_sale_date,
                p.assessed_value as parcel_assessed, p.full_cash_value as parcel_fcv,
                p.legal_class, p.use_type, p.subdivision_name, p.is_rental,
                p.owner_mailing_address, p.owner_mailing_city, p.owner_mailing_state, p.owner_mailing_zip
         FROM parcels p
         WHERE p.situs_address = split_part(b.situs_address, ',', 1)
         ORDER BY p.lot_size_sqft DESC NULLS LAST
         LIMIT 1
       ) p ON true
       ${where}
       ORDER BY b.full_cash_value DESC NULLS LAST
       LIMIT $${i} OFFSET $${i+1}`,
      [...params, Number(limit), Number(offset)]
    );

    res.json({
      total: Number(countResult.rows[0].count),
      limit: Number(limit),
      offset: Number(offset),
      source: 'businesses',
      results: dataResult.rows
    });
  } catch (err: any) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
