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
      limit = '50',
      offset = '0'
    } = req.query;

    const conditions: string[] = [];
    const params: any[] = [];
    let i = 1;

    if (q) {
      conditions.push(`(p.owner_name_parsed ILIKE $${i} OR p.owner_name_raw ILIKE $${i} OR p.situs_address ILIKE $${i} OR p.apn ILIKE $${i} OR p.situs_city ILIKE $${i})`);
      params.push(`%${q}%`); i++;
    }
    if (min_price) { conditions.push(`p.last_sale_price >= $${i++}`); params.push(Number(min_price)); }
    if (max_price) { conditions.push(`p.last_sale_price <= $${i++}`); params.push(Number(max_price)); }
    if (min_units) { conditions.push(`p.unit_count >= $${i++}`); params.push(Number(min_units)); }
    if (max_units) { conditions.push(`p.unit_count <= $${i++}`); params.push(Number(max_units)); }
    if (portfolio === 'true') { conditions.push(`p.portfolio_sale_flag = true`); }

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

    const countResult = await pool.query(`SELECT COUNT(*) FROM parcels p ${where}`, params);

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
      `SELECT p.*, o.parcel_count, o.states_present, o.counties_present
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

export default router;
