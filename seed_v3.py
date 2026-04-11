#!/usr/bin/env python3
"""
GAM Sample Data Seed — v3 (schema-accurate)
Run: python3 seed_v3.py
Reset: python3 seed_v3.py --reset
"""
import psycopg2, psycopg2.extras, uuid, random, sys, calendar
from datetime import date, datetime, timedelta

RESET = '--reset' in sys.argv
DB    = 'postgresql://postgres:gam_dev_password@localhost:5432/gam'

LANDLORD_USER_ID = 'e6ff2a94-0fb0-4b19-ae32-970e3030371a'

NOW   = date(2026, 4, 11)
START = date(2025, 4,  1)
END   = date(2026, 6, 30)

def uid(): return str(uuid.uuid4())

def add_days(d, n): return d + timedelta(days=n)

def add_months(d, n):
    month = d.month - 1 + n
    year  = d.year + month // 12
    month = month % 12 + 1
    day   = min(d.day, calendar.monthrange(year, month)[1])
    return d.replace(year=year, month=month, day=day)

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
    'Pest sighting - ants','Roof leak after rain','Door wont close properly',
    'Garbage disposal broken','Smoke detector beeping','Mold in bathroom corner',
    'Parking spot blocked','Common area light out','Water pressure low',
    'Sewer smell near unit','Gate access not working','Screen door torn',
    'Ceiling fan wobbling','Dishwasher not draining',
]
MAINT_DESC = [
    'Please send someone as soon as possible.',
    'Has been an issue for about a week.',
    'Started noticing this yesterday evening.',
    'Getting worse - please prioritize.',
    'Not urgent but would appreciate a fix soon.',
    'Happened after the last storm.',
]

# properties.type CHECK: residential, rv_longterm, rv_weekly, rv_nightly
PROPERTIES = [
    {'name':'Sunridge RV & Mobile Community',  'street1':'4801 W Camelback Rd','city':'Phoenix',   'state':'AZ','zip':'85031','type':'rv_longterm', 'units':
        [{'label':f'RV-{i:02d}','rent':random.randint(650,950),  'beds':0,'baths':0.0} for i in range(1,15)] +
        [{'label':f'MH-{i:02d}','rent':random.randint(800,1100), 'beds':2,'baths':1.0} for i in range(1,7)]},
    {'name':'Mesa Storage & Mini-Warehouses',  'street1':'1220 E Main St',     'city':'Mesa',      'state':'AZ','zip':'85203','type':'residential',  'units':
        [{'label':f'S5-{i:02d}', 'rent':random.randint(55,80),   'beds':0,'baths':0.0,'sqft':25}  for i in range(1,11)] +
        [{'label':f'S10-{i:02d}','rent':random.randint(100,150), 'beds':0,'baths':0.0,'sqft':100} for i in range(1,11)] +
        [{'label':f'S20-{i:02d}','rent':random.randint(175,225), 'beds':0,'baths':0.0,'sqft':200} for i in range(1,6)]},
    {'name':'Scottsdale Casitas STR',          'street1':'7400 E McCormick Pkwy','city':'Scottsdale','state':'AZ','zip':'85258','type':'rv_nightly',  'units':
        [{'label':f'STR-{i:02d}','rent':random.randint(1400,2800),'beds':1,'baths':1.0} for i in range(1,9)] +
        [{'label':f'STR-{i:02d}','rent':random.randint(2200,3600),'beds':2,'baths':2.0} for i in range(9,13)]},
    {'name':'Tempe Urban Apartments',          'street1':'910 S Mill Ave',     'city':'Tempe',     'state':'AZ','zip':'85281','type':'residential',  'units':
        [{'label':f'1A-{i:02d}','rent':random.randint(1100,1400),'beds':1,'baths':1.0,'sqft':650}  for i in range(1,9)] +
        [{'label':f'2B-{i:02d}','rent':random.randint(1450,1800),'beds':2,'baths':2.0,'sqft':950}  for i in range(1,9)] +
        [{'label':f'3C-{i:02d}','rent':random.randint(1900,2400),'beds':3,'baths':2.0,'sqft':1250} for i in range(1,5)]},
    {'name':'Chandler Mixed-Use Commons',      'street1':'2800 W Chandler Blvd','city':'Chandler', 'state':'AZ','zip':'85224','type':'residential',  'units':
        [{'label':f'APT-{i:02d}','rent':random.randint(1200,1600),'beds':1,'baths':1.0} for i in range(1,7)] +
        [{'label':f'RV-{i:02d}', 'rent':random.randint(600,850),  'beds':0,'baths':0.0} for i in range(1,5)] +
        [{'label':f'STG-{i:02d}','rent':random.randint(90,140),   'beds':0,'baths':0.0} for i in range(1,4)] +
        [{'label':f'MH-{i:02d}', 'rent':random.randint(850,1050), 'beds':2,'baths':1.0} for i in range(1,3)]},
]

def lease_scenario():
    r = random.random()
    if r < 0.15:
        s = add_days(START, random.randint(0, 60))
        e = add_days(s, random.randint(120, 270))
        return {'start':s,'end':e,'status':'expired','scenario':'past'}
    elif r < 0.25:
        s = add_days(NOW, random.randint(7, 75))
        return {'start':s,'end':add_months(s,random.randint(6,12)),'status':'pending','scenario':'upcoming'}
    elif r < 0.4:
        s = add_days(NOW, -random.randint(30,120))
        return {'start':s,'end':add_months(s,random.randint(6,12)),'status':'active','scenario':'current'}
    else:
        s = add_days(START, random.randint(0, 30))
        return {'start':s,'end':add_months(s,random.randint(10,14)),'status':'active','scenario':'current'}

def generate_payments(lease_id, tenant_id, unit_id, landlord_id, lease, rent):
    if lease['scenario'] == 'upcoming': return []
    payments = []
    cursor = lease['start'].replace(day=1)
    end_cursor = NOW if lease['scenario'] == 'current' else lease['end']
    while cursor <= end_cursor:
        due = cursor
        r = random.random()
        if due >= NOW:
            status = 'pending'
        elif r < 0.04:
            status = 'failed'
        elif r < 0.07:
            status = 'returned'
        else:
            status = 'settled'
        payments.append({
            'id': uid(), 'lease_id': lease_id, 'tenant_id': tenant_id,
            'unit_id': unit_id, 'landlord_id': landlord_id,
            'type': 'rent', 'amount': rent, 'status': status,
            'entry_description': 'RENT', 'due_date': due,
            'created_at': datetime(due.year, due.month, due.day),
        })
        cursor = add_months(cursor, 1)
    return payments

def generate_maintenance(unit_id, tenant_id, landlord_id, start, end):
    reqs = []
    span = (end - start).days
    if span < 5: return reqs
    for _ in range(random.randint(0, 3)):
        created = add_days(start, random.randint(5, max(6, span-1)))
        r = random.random()
        status = 'open' if r < 0.2 else 'in_progress' if r < 0.5 else 'completed'
        reqs.append({
            'id': uid(), 'unit_id': unit_id, 'tenant_id': tenant_id,
            'landlord_id': landlord_id,
            'title': random.choice(MAINT_TITLES),
            'description': random.choice(MAINT_DESC),
            'status': status,
            'priority': random.choice(['normal','high','low']),
            'created_at': datetime(created.year, created.month, created.day),
        })
    return reqs

def seed():
    conn = psycopg2.connect(DB)
    conn.autocommit = False
    cur  = conn.cursor(cursor_factory=psycopg2.extras.DictCursor)

    print('\n🌱  GAM Seed v3 — Starting\n')

    if RESET:
        print('⚠️  Resetting...')
        for tbl in ['maintenance_requests','payments','leases','units','properties']:
            cur.execute(f"""
                DELETE FROM {tbl} WHERE {'landlord_id' if tbl != 'leases' else 'landlord_id'} = (
                    SELECT id FROM landlords WHERE user_id = %s)
            """, (LANDLORD_USER_ID,))
        # also remove seed tenants/users
        cur.execute("DELETE FROM tenants WHERE user_id IN (SELECT id FROM users WHERE email LIKE '%@tenant.dev')")
        cur.execute("DELETE FROM users WHERE email LIKE '%@tenant.dev'")
        conn.commit()
        print('✅  Reset done\n')

    # Get landlord
    cur.execute('SELECT id FROM landlords WHERE user_id = %s', (LANDLORD_USER_ID,))
    row = cur.fetchone()
    if not row:
        print('❌  Landlord not found. Run: INSERT INTO landlords (user_id) VALUES (...)')
        sys.exit(1)
    landlord_id = row[0]
    print(f'✅  Landlord: {landlord_id}')

    # Build tenant pool
    print('👤  Creating tenants...')
    bcrypt = '$2b$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi'
    tenant_pool = []

    for _ in range(80):
        first = random.choice(FIRST)
        last  = random.choice(LAST)
        email = f'{first.lower()}.{last.lower()}{random.randint(1,999)}@tenant.dev'

        cur.execute('SELECT u.id, t.id FROM users u JOIN tenants t ON t.user_id = u.id WHERE u.email = %s', (email,))
        existing = cur.fetchone()
        if existing:
            tenant_pool.append({'user_id': existing[0], 'tenant_id': existing[1], 'first': first, 'last': last})
            continue

        user_id = uid()
        cur.execute("""
            INSERT INTO users (id, email, role, first_name, last_name, password_hash, created_at)
            VALUES (%s, %s, 'tenant', %s, %s, %s, %s)
            ON CONFLICT DO NOTHING
        """, (user_id, email, first, last, bcrypt, datetime(2025, random.randint(1,4), random.randint(1,28))))

        tenant_id = uid()
        cur.execute("""
            INSERT INTO tenants (id, user_id, created_at)
            VALUES (%s, %s, %s)
            ON CONFLICT DO NOTHING
        """, (tenant_id, user_id, datetime.now()))

        tenant_pool.append({'user_id': user_id, 'tenant_id': tenant_id, 'first': first, 'last': last})

    conn.commit()
    print(f'✅  {len(tenant_pool)} tenants ready\n')

    total_units = total_leases = total_payments = total_maint = 0

    for prop_def in PROPERTIES:
        print(f'🏢  {prop_def["name"]}')
        prop_id = uid()

        cur.execute("""
            INSERT INTO properties (id, landlord_id, name, street1, city, state, zip, type, created_at)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)
            ON CONFLICT DO NOTHING
        """, (prop_id, landlord_id, prop_def['name'], prop_def['street1'],
              prop_def['city'], prop_def['state'], prop_def['zip'],
              prop_def['type'], datetime.now()))

        for u in prop_def['units']:
            unit_id = uid()
            lease   = lease_scenario()
            # unit status: active=occupied, vacant=vacant/upcoming
            unit_status = 'active' if lease['scenario'] == 'current' else 'vacant'
            t = random.choice(tenant_pool)

            cur.execute("""
                INSERT INTO units
                  (id, property_id, landlord_id, tenant_id, unit_number,
                   bedrooms, bathrooms, sqft, rent_amount, security_deposit, status, created_at)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                ON CONFLICT DO NOTHING
            """, (unit_id, prop_id, landlord_id,
                  t['tenant_id'] if unit_status == 'active' else None,
                  u['label'], u.get('beds',1), u.get('baths',1.0),
                  u.get('sqft'), u['rent'], 0, unit_status, datetime.now()))
            total_units += 1

            # Lease
            lease_id = uid()
            cur.execute("""
                INSERT INTO leases
                  (id, unit_id, tenant_id, landlord_id, status,
                   start_date, end_date, rent_amount, security_deposit,
                   signed_by_landlord, signed_by_tenant, created_at)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                ON CONFLICT DO NOTHING
            """, (lease_id, unit_id, t['tenant_id'], landlord_id,
                  lease['status'], lease['start'], lease['end'],
                  u['rent'], 0,
                  True, True, datetime.now()))
            total_leases += 1

            # Payments
            for pmt in generate_payments(lease_id, t['tenant_id'], unit_id, landlord_id, lease, u['rent']):
                cur.execute("""
                    INSERT INTO payments
                      (id, lease_id, tenant_id, unit_id, landlord_id,
                       type, amount, status, entry_description, due_date, created_at)
                    VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                    ON CONFLICT DO NOTHING
                """, (pmt['id'], pmt['lease_id'], pmt['tenant_id'], pmt['unit_id'],
                      pmt['landlord_id'], pmt['type'], pmt['amount'], pmt['status'],
                      pmt['entry_description'], pmt['due_date'], pmt['created_at']))
                total_payments += 1

            # Maintenance
            if lease['scenario'] != 'upcoming':
                for req in generate_maintenance(unit_id, t['tenant_id'], landlord_id, lease['start'], lease['end']):
                    cur.execute("""
                        INSERT INTO maintenance_requests
                          (id, unit_id, tenant_id, landlord_id, title, description,
                           priority, status, created_at)
                        VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)
                        ON CONFLICT DO NOTHING
                    """, (req['id'], req['unit_id'], req['tenant_id'], req['landlord_id'],
                          req['title'], req['description'], req['priority'],
                          req['status'], req['created_at']))
                    total_maint += 1

        conn.commit()
        print(f'   ↳ {len(prop_def["units"])} units')

    cur.close()
    conn.close()

    print(f'\n{"="*50}')
    print(f'🎉  Done!\n')
    print(f'  Properties  : {len(PROPERTIES)}')
    print(f'  Units       : {total_units}')
    print(f'  Tenants     : {len(tenant_pool)}')
    print(f'  Leases      : {total_leases}')
    print(f'  Payments    : {total_payments}')
    print(f'  Maintenance : {total_maint}')
    print(f'  Date range  : Apr 2025 - Jun 2026')
    print(f'{"="*50}\n')

if __name__ == '__main__':
    seed()
