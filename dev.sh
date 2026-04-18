#!/bin/bash
echo "Killing existing processes on all GAM ports..."
for port in 3001 3002 3003 3004 3005 3006 3007 4000 4001; do
  pid=$(lsof -ti tcp:$port 2>/dev/null)
  [ -n "$pid" ] && kill -9 $pid 2>/dev/null && echo "  Killed :$port (pid $pid)"
done
sleep 2

cd "$(dirname "$0")"
echo "Starting servers..."
nohup npm run dev --workspace=apps/api       > /tmp/gam-api.log       2>&1 & echo "  API       → :4000"
sleep 3
nohup npm run dev --workspace=apps/landlord  > /tmp/gam-landlord.log  2>&1 & echo "  Landlord  → :3001"
nohup npm run dev --workspace=apps/tenant    > /tmp/gam-tenant.log    2>&1 & echo "  Tenant    → :3002"
nohup npm run dev --workspace=apps/admin     > /tmp/gam-admin.log     2>&1 & echo "  Admin     → :3003"
nohup npm run dev --workspace=apps/marketing > /tmp/gam-marketing.log 2>&1 & echo "  Marketing → :3004"
nohup npm run dev --workspace=apps/pos       > /tmp/gam-pos.log       2>&1 & echo "  POS       → :3005"
nohup npm run dev --workspace=apps/books     > /tmp/gam-books.log     2>&1 & echo "  Books     → :3006"
nohup npm run dev --workspace=apps/listings  > /tmp/gam-listings.log  2>&1 & echo "  Listings  → :3008"
nohup npm run dev --workspace=apps/admin-ops > /tmp/gam-admin-ops.log 2>&1 & echo "  AdminOps  → :3009"
nohup npm run dev --workspace=apps/admin-ops > /tmp/gam-admin-ops.log 2>&1 & echo "  AdminOps  → :3009"
sleep 4

echo ""
echo "═══════════════════════════════════"
echo "  GAM Platform — Port Map"
echo "═══════════════════════════════════"
echo "  API       http://localhost:4000"
echo "  Landlord  http://localhost:3001"
echo "  Tenant    http://localhost:3002"
echo "  Admin     http://localhost:3003"
echo "  Marketing http://localhost:3004"
echo "  POS       http://localhost:3005"
echo "  Books     http://localhost:3006"
echo "  PropIntel http://localhost:3007"
echo "  PropAPI   http://localhost:4001"
echo "═══════════════════════════════════"

# Verify all ports are actually listening
echo ""
echo "Listening ports:"
lsof -i tcp:3001,3002,3003,3004,3005,3006,4000 2>/dev/null | grep LISTEN | awk '{print "  " $9}' | sort
