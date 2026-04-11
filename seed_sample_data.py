#!/usr/bin/env python3
"""
GAM Platform — Sample Data Seed Script
Populates: 5 properties, ~100 units (all types), tenants, leases,
           payments, maintenance requests, announcements
Date range: April 2025 → June 2026

Run from anywhere:
    python3 seed_sample_data.py

To wipe seed data and re-seed:
    python3 seed_sample_data.py --reset
"""

import psycopg2
import psycopg2.extras
import uuid
import random
import sys
from datetime import date, datetime, timedelta


RESET = '--reset' in sys.argv

DB_URL = 'postgresql://postgres:gam_dev_password@localhost:5432/gam'
LANDLORD_USER_ID = 'e6ff2a94-0fb0-4b19-ae32-970e3030371a'

NOW   = date(2026, 4, 11)
START = date(2025, 4, 1)
END   = date(2026, 6, 30)

# ── Fake data pools ───────────────────────────────────────────────────────────
FIRST = ['James','Maria','Robert','Linda','Michael','Barbara','William','Patricia',
 'David','Jennifer','Richard','Elizabeth','Joseph','Susan','Thomas','Jessica',
 'Charles','Sarah','Chris','Karen','Daniel','Lisa','Matthew','Nancy','Anthony',
 'Betty','Mark','Margaret','Donald','Sandra','Steven','Ashley','Paul','Dorothy',
 'Andrew','Kimberly','Kenneth','Emily','Joshua','Donna','Kevin','Michelle',
 'Brian','Carol','George','Amanda','Edward','Melissa','Ronald','Deborah',
 'Ryan','Stephanie','Jacob','Rebecca','Gary','Sharon','Nicholas','Laura']

LAST = ['Smith','Johnson','Williams','Brown','Jones','Garcia','Miller','Davis',
 'Rodriguez','Martinez','Hernandez','Lopez','Gonzalez','Wilson','Anderson',
 'Thomas','Taylor','Moore','Jackson','Martin','Lee','Perez','Thompson','White',
 'Harris','Sanchez','Clark','Ramirez','Lewis','Robinson','Walker','Young',
 'Allen','King','Wright','Scott','Torres','Nguyen','Hill','Flores','Green',
 'Adams','Nelson','Baker','Hall','Rivera','Campbell','Mitchell','Carter']

MAINT_TITLES = [
    'AC not cooling properly','Leaking faucet in bathroom','Electrical outlet not working',
    'Toilet running constantly','Broken window latch','Hot water heater issue',
    'Pest sighting — ants','Roof leak after rain','Door won\'t close properly',
    'Garbage disposal broken','Smoke detector beeping','Mold in bathroom corner',
    'Parking spot blocked','Common area light out','Water pressure low',
    'Sewer smell near unit','Gate access not working','Screen door torn',
    'Ceiling fan wobbling','Dishwasher not draining','Dryer vent needs cleaning',
    'Thermostat not responding','Cabinet hinge broken','Clogged shower drain',
]

MAINT_DESC = [
    'Please send someone as soon as possible.',
    'Has been an issue for about a week.',
    'Started noticing this yesterday evening.',
    'Getting worse — please prioritize.',
    'Not urgent but would appreciate a fix soon.',
    'Happened after the last storm.',
    'Affects daily use of the unit.',
    'Already tried resetting — still not working.',
]

# ── Property definitions ──────────────────────────────────────────────────────
def build_units(utype, prefix, count, rent_range, extra=None):
    units = []
    for i in range(1, count + 1):
        u = {
            'type': utype,
            'label': f'{prefix}{str(i).zfill(2)}',
            'rent': random.randint(*rent_range),
        }
        if extra:
            u.update(extra)
        units.append(u)
    return units

PROPERTIES = [
    {
        'name': 'Sunridge RV & Mobile Community',
        'address': '4801 W Camelback Rd',
        'city': 'Phoenix', 'state': 'AZ', 'zip': '85031',
        'type': 'rv_park',
        'description': 'Full-service RV and mobile home community in West Phoenix.',
        'units': (
            build_units('rv_spot',     'RV-', 14, (650, 950)) +
            build_units('mobile_home', 'MH-',  6, (800, 1100))
        ),
    },
    {
        'name': 'Mesa Storage & Mini-Warehouses',
        'address': '1220 E Main St',
        'city': 'Mesa', 'state': 'AZ', 'zip': '85203',
        'type': 'storage',
        'description': 'Climate-controlled and standard storage units, all sizes.',
        'units': (
            build_units('storage_unit', 'S-5x5-',   10, (55,  80),  {'sqft': 25}) +
            build_units('storage_unit', 'S-10x10-', 10, (100, 150), {'sqft': 100}) +
            build_units('storage_unit', 'S-10x20-',  5, (175, 225), {'sqft': 200})
        ),
    },
    {
        'name': 'Scottsdale Casitas & Short-Term Rentals',
        'address': '7400 E McCormick Pkwy',
        'city': 'Scottsdale', 'state': 'AZ', 'zip': '85258',
        'type': 'short_term_rental',
        'description': 'Furnished casitas for short-term and monthly stays.',
        'units': (
            build_units('short_term_rental', 'STR-', 8, (1400, 2800), {'bedrooms': 1, 'bathrooms': 1}) +
            build_units('short_term_rental', 'STR-', 4, (2200, 3600), {'bedrooms': 2, 'bathrooms': 2})
        ),
    },
    {
        'name': 'Tempe Urban Apartments',
        'address': '910 S Mill Ave',
        'city': 'Tempe', 'state': 'AZ', 'zip': '85281',
        'type': 'apartment',
        'description': 'Modern apartments near ASU campus.',
        'units': (
            build_units('apartment', '1A-', 8, (1100, 1400), {'bedrooms': 1, 'bathrooms': 1, 'sqft': 650}) +
            build_units('apartment', '2B-', 8, (1450, 1800), {'bedrooms': 2, 'bathrooms': 2, 'sqft': 950}) +
            build_units('apartment', '3C-', 4, (1900, 2400), {'bedrooms': 3, 'bathrooms': 2, 'sqft': 1250})
        ),
    },
    {
        'name': 'Chandler Mixed-Use Commons',
        'address': '2800 W Chandler Blvd',
        'city': 'Chandler', 'state': 'AZ', 'zip': '85224',
        'type': 'mixed',
        'description': 'Mixed-use development: apartments, storage, RV spots, and mobile homes.',
        'units': (
            build_units('apartment',    'APT-', 6, (1200, 1600), {'bedrooms': 1, 'bathrooms': 1}) +
            build_units('rv_spot',      'RV-',  4, (600,  850)) +
            build_units('storage_unit', 'STG-', 3, (90,   140)) +
            build_units('mobile_home',  'MH-',  2, (850,  1050))
        ),
    },
]

# ── Helpers ───────────────────────────────────────────────────────────────────
def uid(): return str(uuid.uuid4())

def add_days(d, n): return d + timedelta(days=n)
def add_months(d, n):
    import calendar
    month = d.month - 1 + n
    year = d.year + month // 12
    month = month % 12 + 1
    day = min(d.day, calendar.monthrange(year, month)[1])
    return d.replace(year=year, month=month, day=day)

def get_columns(cur, table):
    cur.execute("""
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = %s
    """, (table,))
    return {r[0] for r in cur.fetchall()}

def table_exists(cur, table):
    cur.execute("""
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = %s
    """, (table,))
    return cur.fetchone() is not None

def lease_scenario(unit_type):
    r = random.random()

    if unit_type in ('short_term_rental', 'rv_spot'):
        choice = random.choice(['past', 'current', 'upcoming', 'upcoming2'])
        if choice == 'past':
            s = add_days(START, random.randint(0, 200))
            return {'start': s, 'end': add_days(s, random.randint(7, 60)), 'status': 'expired', 'scenario': 'past'}
        elif choice == 'current':
            s = add_days(NOW, -random.randint(1, 20))
            return {'start': s, 'end': add_days(s, random.randint(7, 45)), 'status': 'active', 'scenario': 'current'}
        else:
            s = add_days(NOW, random.randint(5, 60))
            return {'start': s, 'end': add_days(s, random.randint(7, 30)), 'status': 'upcoming', 'scenario': 'upcoming'}

    if unit_type == 'storage_unit':
        if r < 0.6:
            s = add_days(START, random.randint(0, 60))
            return {'start': s, 'end': add_months(NOW, random.randint(1, 6)), 'status': 'active', 'scenario': 'current'}
        elif r < 0.8:
            s = add_days(START, random.randint(0, 100))
            return {'start': s, 'end': add_days(s, random.randint(30, 180)), 'status': 'expired', 'scenario': 'past'}
        else:
            s = add_days(NOW, random.randint(3, 30))
            return {'start': s, 'end': add_months(s, random.randint(1, 6)), 'status': 'upcoming', 'scenario': 'upcoming'}

    # Standard (apartment, mobile_home)
    if r < 0.15:
        s = add_days(START, random.randint(0, 60))
        e = add_days(s, random.randint(120, 270))
        return {'start': s, 'end': e, 'status': 'expired', 'scenario': 'past'}
    elif r < 0.25:
        s = add_days(NOW, random.randint(7, 75))
        return {'start': s, 'end': add_months(s, random.randint(6, 12)), 'status': 'upcoming', 'scenario': 'upcoming'}
    elif r < 0.4:
        s = add_days(NOW, -random.randint(30, 120))
        return {'start': s, 'end': add_months(s, random.randint(6, 12)), 'status': 'active', 'scenario': 'current'}
    else:
        s = add_days(START, random.randint(0, 30))
        return {'start': s, 'end': add_months(s, random.randint(10, 14)), 'status': 'active', 'scenario': 'current'}


def generate_payments(lease_id, tenant_id, lease, rent):
    if lease['scenario'] == 'upcoming':
        return []
    payments = []
    cursor = lease['start'].replace(day=1)
    end_cursor = NOW if lease['scenario'] == 'current' else lease['end']

    while cursor <= end_cursor:
        due = cursor
        is_past = due < NOW
        r = random.random()

        if not is_past:
            status = 'pending'; paid_date = None; amount = rent
        elif r < 0.04:
            status = 'late'; paid_date = add_days(due, random.randint(5, 18)); amount = rent + random.randint(50, 150)
        elif r < 0.07:
            status = 'missed'; paid_date = None; amount = rent
        else:
            status = 'paid'; paid_date = add_days(due, random.randint(-3, 3)); amount = rent

        payments.append({
            'id': uid(), 'lease_id': lease_id, 'tenant_id': tenant_id,
            'amount': amount, 'due_date': due,
            'paid_date': paid_date, 'status': status, 'type': 'rent',
            'created_at': datetime(due.year, due.month, due.day),
        })
        cursor = add_months(cursor, 1)
    return payments


def generate_maintenance(unit_id, tenant_id, start, end):
    reqs = []
    span = (end - start).days
    if span < 5:
        return reqs
    for _ in range(random.randint(0, 3)):
        created_offset = random.randint(5, max(6, span - 1))
        created = add_days(start, created_offset)
        r = random.random()
        status = 'open' if r < 0.2 else 'in_progress' if r < 0.5 else 'resolved'
        reqs.append({
            'id': uid(), 'unit_id': unit_id, 'tenant_id': tenant_id,
            'title': random.choice(MAINT_TITLES),
            'description': random.choice(MAINT_DESC),
            'status': status,
            'priority': random.choice(['low', 'medium', 'high']),
            'created_at': datetime(created.year, created.month, created.day),
        })
    return reqs


# ── Safe insert: only include columns that exist in the table ─────────────────
def safe_insert(cur, table, data, cols):
    row = {k: v for k, v in data.items() if k in cols}
    if not row:
        return
    fields = list(row.keys())
    vals   = list(row.values())
    ph = ', '.join(['%s'] * len(fields))
    sql = f"INSERT INTO {table} ({', '.join(fields)}) VALUES ({ph}) ON CONFLICT DO NOTHING"
    try:
        cur.execute(sql, vals)
    except Exception:
        pass  # skip on any constraint error


# ── Main ──────────────────────────────────────────────────────────────────────
def seed():
    conn = psycopg2.connect(DB_URL)
    conn.autocommit = False
    cur = conn.cursor(cursor_factory=psycopg2.extras.DictCursor)

    print('\n🌱  GAM Sample Data Seed — Starting\n')

    # Optional reset
    if RESET:
        print('⚠️   --reset: clearing existing seed data...')
        cur.execute("""
            DELETE FROM maintenance_requests WHERE unit_id IN (
                SELECT u.id FROM units u
                JOIN properties p ON u.property_id = p.id
                WHERE p.landlord_id = (SELECT id FROM landlords WHERE user_id = %s)
            )
        """, (LANDLORD_USER_ID,))
        cur.execute("""
            DELETE FROM payments WHERE lease_id IN (
                SELECT l.id FROM leases l
                JOIN units u ON l.unit_id = u.id
                JOIN properties p ON u.property_id = p.id
                WHERE p.landlord_id = (SELECT id FROM landlords WHERE user_id = %s)
            )
        """, (LANDLORD_USER_ID,))
        cur.execute("""
            DELETE FROM leases WHERE unit_id IN (
                SELECT u.id FROM units u
                JOIN properties p ON u.property_id = p.id
                WHERE p.landlord_id = (SELECT id FROM landlords WHERE user_id = %s)
            )
        """, (LANDLORD_USER_ID,))
        cur.execute("""
            DELETE FROM units WHERE property_id IN (
                SELECT id FROM properties
                WHERE landlord_id = (SELECT id FROM landlords WHERE user_id = %s)
            )
        """, (LANDLORD_USER_ID,))
        cur.execute("""
            DELETE FROM properties
            WHERE landlord_id = (SELECT id FROM landlords WHERE user_id = %s)
        """, (LANDLORD_USER_ID,))
        conn.commit()
        print('✅  Reset complete.\n')

    # Get landlord ID
    cur.execute('SELECT id FROM landlords WHERE user_id = %s', (LANDLORD_USER_ID,))
    row = cur.fetchone()
    if not row:
        print(f'❌  Landlord not found for user_id {LANDLORD_USER_ID}')
        print('    Ensure realestaterhoades@gmail.com exists.')
        sys.exit(1)
    landlord_id = row[0]
    print(f'✅  Landlord ID: {landlord_id}')

    # Introspect schemas
    prop_cols  = get_columns(cur, 'properties')
    unit_cols  = get_columns(cur, 'units')
    user_cols  = get_columns(cur, 'users')
    tenant_cols = get_columns(cur, 'tenants') if table_exists(cur, 'tenants') else set()
    lease_cols = get_columns(cur, 'leases')
    pay_cols   = get_columns(cur, 'payments')
    maint_cols = get_columns(cur, 'maintenance_requests')
    has_bookings = table_exists(cur, 'bookings')
    has_ann = table_exists(cur, 'platform_announcements')
    ann_cols = get_columns(cur, 'platform_announcements') if has_ann else set()
    print('✅  Schema introspected\n')

    # ── Create tenant pool ────────────────────────────────────────────────────
    print('👤  Creating tenant user pool...')
    tenant_pool = []
    bcrypt_hash = '$2b$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi'  # tenant1234

    for i in range(80):
        first = random.choice(FIRST)
        last  = random.choice(LAST)
        email = f'{first.lower()}.{last.lower()}{random.randint(1,999)}@tenant.dev'
        user_id = uid()

        cur.execute('SELECT id FROM users WHERE email = %s', (email,))
        existing = cur.fetchone()
        if existing:
            tenant_pool.append({'user_id': existing[0], 'first': first, 'last': last, 'tenant_id': existing[0]})
            continue

        user_data = {
            'id': user_id, 'email': email, 'role': 'tenant',
            'created_at': datetime(2025, random.randint(1, 4), random.randint(1, 28)),
        }
        if 'first_name' in user_cols: user_data['first_name'] = first
        if 'last_name'  in user_cols: user_data['last_name']  = last
        if 'name'       in user_cols: user_data['name']       = f'{first} {last}'
        if 'full_name'  in user_cols: user_data['full_name']  = f'{first} {last}'
        if 'phone'      in user_cols: user_data['phone']      = f'602{random.randint(1000000,9999999)}'
        if 'password_hash' in user_cols: user_data['password_hash'] = bcrypt_hash
        if 'is_verified'   in user_cols: user_data['is_verified'] = True
        if 'email_verified' in user_cols: user_data['email_verified'] = True
        safe_insert(cur, 'users', user_data, user_cols)

        tenant_id = user_id
        if tenant_cols:
            t_id = uid()
            t_data = {
                'id': t_id, 'user_id': user_id,
                'created_at': datetime.now(),
            }
            if 'first_name' in tenant_cols: t_data['first_name'] = first
            if 'last_name'  in tenant_cols: t_data['last_name']  = last
            if 'status'     in tenant_cols: t_data['status']     = 'active'
            if 'landlord_id' in tenant_cols: t_data['landlord_id'] = landlord_id
            safe_insert(cur, 'tenants', t_data, tenant_cols)

            cur.execute('SELECT id FROM tenants WHERE user_id = %s', (user_id,))
            tr = cur.fetchone()
            if tr:
                tenant_id = tr[0]

        tenant_pool.append({'user_id': user_id, 'first': first, 'last': last, 'tenant_id': tenant_id})

    conn.commit()
    print(f'✅  {len(tenant_pool)} tenant accounts ready\n')

    # ── Properties + Units + Leases + Payments + Maintenance ─────────────────
    total_units = total_leases = total_payments = total_maint = 0

    for prop_def in PROPERTIES:
        print(f'🏢  Seeding: {prop_def["name"]}')
        prop_id = uid()

        prop_data = {
            'id': prop_id, 'landlord_id': landlord_id,
            'name': prop_def['name'], 'address': prop_def['address'],
            'city': prop_def['city'], 'state': prop_def['state'],
            'created_at': datetime.now(),
        }
        # zip column name varies
        for zc in ('zip_code', 'zip', 'postal_code'):
            if zc in prop_cols:
                prop_data[zc] = prop_def['zip']
                break
        for tc in ('type', 'property_type'):
            if tc in prop_cols:
                prop_data[tc] = prop_def['type']
                break
        if 'description' in prop_cols: prop_data['description'] = prop_def['description']
        if 'status'      in prop_cols: prop_data['status']      = 'active'
        if 'is_active'   in prop_cols: prop_data['is_active']   = True

        safe_insert(cur, 'properties', prop_data, prop_cols)

        for unit_def in prop_def['units']:
            unit_id = uid()
            lease   = lease_scenario(unit_def['type'])
            unit_status = ('occupied' if lease['scenario'] == 'current'
                           else 'reserved' if lease['scenario'] == 'upcoming'
                           else 'vacant')

            unit_data = {'id': unit_id, 'property_id': prop_id, 'created_at': datetime.now()}
            for nc in ('unit_number', 'number', 'label', 'name'):
                if nc in unit_cols: unit_data[nc] = unit_def['label']; break
            for tc in ('unit_type', 'type'):
                if tc in unit_cols: unit_data[tc] = unit_def['type']; break
            for rc in ('rent_amount', 'monthly_rent', 'price'):
                if rc in unit_cols: unit_data[rc] = unit_def['rent']; break
            if 'bedrooms'    in unit_cols and 'bedrooms'  in unit_def: unit_data['bedrooms']    = unit_def['bedrooms']
            if 'bathrooms'   in unit_cols and 'bathrooms' in unit_def: unit_data['bathrooms']   = unit_def['bathrooms']
            if 'square_feet' in unit_cols and 'sqft'      in unit_def: unit_data['square_feet'] = unit_def['sqft']
            if 'sqft'        in unit_cols and 'sqft'      in unit_def: unit_data['sqft']        = unit_def['sqft']
            if 'status'    in unit_cols: unit_data['status']    = unit_status
            if 'is_active' in unit_cols: unit_data['is_active'] = True

            safe_insert(cur, 'units', unit_data, unit_cols)
            total_units += 1

            # Pick tenant
            t = random.choice(tenant_pool)
            tenant_id   = t['tenant_id']
            tenant_user_id = t['user_id']

            # Lease
            lease_id = uid()
            lease_data = {'id': lease_id, 'unit_id': unit_id, 'created_at': datetime.now()}
            if 'tenant_id' in lease_cols: lease_data['tenant_id'] = tenant_id
            if 'user_id'   in lease_cols: lease_data['user_id']   = tenant_user_id
            for sc in ('start_date', 'lease_start'):
                if sc in lease_cols: lease_data[sc] = lease['start']; break
            for ec in ('end_date', 'lease_end'):
                if ec in lease_cols: lease_data[ec] = lease['end']; break
            for rc in ('rent_amount', 'monthly_rent'):
                if rc in lease_cols: lease_data[rc] = unit_def['rent']; break
            if 'status' in lease_cols: lease_data['status'] = lease['status']

            safe_insert(cur, 'leases', lease_data, lease_cols)
            total_leases += 1

            # Payments
            if pay_cols:
                for pmt in generate_payments(lease_id, tenant_id, lease, unit_def['rent']):
                    pay_data = {'id': pmt['id'], 'lease_id': pmt['lease_id']}
                    for tc in ('tenant_id', 'user_id'):
                        if tc in pay_cols: pay_data[tc] = pmt['tenant_id']; break
                    for ac in ('amount', 'payment_amount'):
                        if ac in pay_cols: pay_data[ac] = pmt['amount']; break
                    if 'due_date'   in pay_cols: pay_data['due_date']   = pmt['due_date']
                    for pc in ('paid_date', 'payment_date'):
                        if pc in pay_cols: pay_data[pc] = pmt['paid_date']; break
                    if 'status'    in pay_cols: pay_data['status']    = pmt['status']
                    for tyc in ('type', 'payment_type'):
                        if tyc in pay_cols: pay_data[tyc] = pmt['type']; break
                    if 'created_at' in pay_cols: pay_data['created_at'] = pmt['created_at']
                    safe_insert(cur, 'payments', pay_data, pay_cols)
                    total_payments += 1

            # Maintenance
            if maint_cols and lease['scenario'] != 'upcoming':
                for req in generate_maintenance(unit_id, tenant_id, lease['start'], lease['end']):
                    maint_data = {'id': req['id'], 'unit_id': req['unit_id']}
                    for tc in ('tenant_id', 'user_id'):
                        if tc in maint_cols: maint_data[tc] = req['tenant_id']; break
                    for titlec in ('title', 'subject'):
                        if titlec in maint_cols: maint_data[titlec] = req['title']; break
                    for dc in ('description', 'notes', 'body'):
                        if dc in maint_cols: maint_data[dc] = req['description']; break
                    if 'status'     in maint_cols: maint_data['status']     = req['status']
                    if 'priority'   in maint_cols: maint_data['priority']   = req['priority']
                    if 'created_at' in maint_cols: maint_data['created_at'] = req['created_at']
                    if 'updated_at' in maint_cols: maint_data['updated_at'] = req['created_at']
                    safe_insert(cur, 'maintenance_requests', maint_data, maint_cols)
                    total_maint += 1

        conn.commit()
        print(f'   ↳ {len(prop_def["units"])} units seeded')

    # ── Platform Announcements ────────────────────────────────────────────────
    if has_ann:
        announcements = [
            ('Welcome to the Community!', 'We\'re excited to have you. Review the community rules posted at the main office.', 'general', 'normal', date(2025, 4, 3)),
            ('Pool Maintenance May 3–5', 'Pool closed for cleaning May 3–5. We apologize for the inconvenience.', 'maintenance', 'normal', date(2025, 4, 28)),
            ('Rent Due Date Reminder', 'Rent is due on the 1st. A $75 late fee applies after the 5th.', 'billing', 'high', date(2025, 5, 25)),
            ('New Package Lockers Installed', 'Smart package lockers are now available at the front office.', 'general', 'normal', date(2025, 6, 10)),
            ('Summer AC Tips', 'Keep thermostats above 78°F when away to avoid overloading the system.', 'general', 'normal', date(2025, 7, 1)),
            ('Pest Control — Quarterly Inspection', 'Pest control on-site July 15. Allow access 9am–3pm.', 'maintenance', 'normal', date(2025, 7, 8)),
            ('Lease Renewal Season', 'Leases expiring Oct/Nov — respond to renewal offer by Aug 31 to lock in rates.', 'billing', 'high', date(2025, 8, 1)),
            ('Fire Safety Inspection Sept 12', 'Annual fire safety inspection Sept 12. Smoke detectors and extinguishers will be checked.', 'maintenance', 'high', date(2025, 9, 5)),
            ('Holiday Office Hours', 'Office closed Nov 27–28 for Thanksgiving. Emergency maintenance available 24/7.', 'general', 'normal', date(2025, 11, 20)),
            ('2026 Rent Adjustments', '3% CPI adjustment takes effect Jan 1, 2026. Updated statements in your portal.', 'billing', 'high', date(2025, 12, 1)),
            ('New Year — Community Mixer', 'Join us Jan 5 at the clubhouse. Light refreshments served.', 'general', 'normal', date(2026, 1, 2)),
            ('Water Shutoff Feb 14', 'Emergency main work — 4hr shutoff Feb 14, 10am–2pm.', 'maintenance', 'urgent', date(2026, 2, 10)),
            ('Spring Landscaping Starting', 'Landscaping crew begins March 1. Expect morning noise on weekdays.', 'general', 'normal', date(2026, 2, 25)),
            ('Parking Lot Resurfacing April', 'Main lot resurfaced April 7–9. Use overflow lot during this time.', 'maintenance', 'normal', date(2026, 3, 28)),
            ('Summer Bookings Now Open', 'STR and seasonal bookings for June–August are open. Contact the office to reserve.', 'general', 'high', date(2026, 4, 1)),
        ]
        for title, body, atype, priority, adate in announcements:
            ann_data = {'id': uid(), 'created_at': datetime(adate.year, adate.month, adate.day)}
            if 'title'        in ann_cols: ann_data['title']        = title
            if 'body'         in ann_cols: ann_data['body']         = body
            if 'content'      in ann_cols: ann_data['content']      = body
            if 'type'         in ann_cols: ann_data['type']         = atype
            if 'priority'     in ann_cols: ann_data['priority']     = priority
            if 'landlord_id'  in ann_cols: ann_data['landlord_id']  = landlord_id
            if 'published_at' in ann_cols: ann_data['published_at'] = datetime(adate.year, adate.month, adate.day)
            if 'is_published' in ann_cols: ann_data['is_published'] = True
            safe_insert(cur, 'platform_announcements', ann_data, ann_cols)
        conn.commit()
        print(f'\n📢  Seeded {len(announcements)} platform announcements')

    # ── Bookings (master schedule / STR/RV) ───────────────────────────────────
    if has_bookings:
        book_cols = get_columns(cur, 'bookings')
        cur.execute("""
            SELECT u.id, u.unit_number FROM units u
            JOIN properties p ON u.property_id = p.id
            WHERE p.landlord_id = %s
              AND (u.unit_type IN ('short_term_rental','rv_spot')
                OR u.type IN ('short_term_rental','rv_spot'))
        """, (landlord_id,))
        str_units = cur.fetchall()
        booking_count = 0
        for unit_row in str_units:
            unit_id = unit_row[0]
            cursor_date = START
            for _ in range(random.randint(3, 8)):
                gap   = random.randint(1, 14)
                stay  = random.randint(3, 21)
                b_start = add_days(cursor_date, gap)
                b_end   = add_days(b_start, stay)
                if b_start > END:
                    break
                t = random.choice(tenant_pool)
                b_status = ('completed' if b_end < NOW else 'confirmed' if b_start > NOW else 'active')
                book_data = {'id': uid(), 'unit_id': unit_id, 'created_at': datetime.now()}
                for tc in ('tenant_id', 'user_id'):
                    if tc in book_cols: book_data[tc] = t['tenant_id']; break
                for sc in ('start_date', 'check_in'):
                    if sc in book_cols: book_data[sc] = b_start; break
                for ec in ('end_date', 'check_out'):
                    if ec in book_cols: book_data[ec] = b_end; break
                if 'status'     in book_cols: book_data['status']     = b_status
                if 'guest_name' in book_cols: book_data['guest_name'] = f'{t["first"]} {t["last"]}'
                safe_insert(cur, 'bookings', book_data, book_cols)
                cursor_date = b_end
                booking_count += 1
        conn.commit()
        print(f'📅  Seeded {booking_count} bookings on STR/RV units')

    cur.close()
    conn.close()

    print('\n' + '='*52)
    print('🎉  Seed Complete!\n')
    print(f'  Properties       : {len(PROPERTIES)}')
    print(f'  Units            : {total_units}')
    print(f'  Tenant accounts  : {len(tenant_pool)}')
    print(f'  Leases           : {total_leases}')
    print(f'  Payments         : {total_payments}')
    print(f'  Maintenance reqs : {total_maint}')
    print(f'\n  Date range       : Apr 2025 → Jun 2026')
    print(f'  Landlord login   : realestaterhoades@gmail.com / landlord1234')
    print('='*52 + '\n')


if __name__ == '__main__':
    seed()
