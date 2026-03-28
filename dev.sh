#!/bin/bash
echo "Killing existing processes..."
for port in 3001 3002 3003 3004 4000; do
  pid=$(lsof -ti tcp:$port 2>/dev/null)
  [ -n "$pid" ] && kill -9 $pid 2>/dev/null && echo "Killed :$port"
done
sleep 2
cd "$(dirname "$0")"
echo "Starting servers..."
nohup npm run dev --workspace=apps/api > /tmp/gam-api.log 2>&1 &
sleep 3
nohup npm run dev --workspace=apps/landlord > /tmp/gam-landlord.log 2>&1 &
nohup npm run dev --workspace=apps/tenant > /tmp/gam-tenant.log 2>&1 &
nohup npm run dev --workspace=apps/admin > /tmp/gam-admin.log 2>&1 &
nohup npm run dev --workspace=apps/marketing > /tmp/gam-marketing.log 2>&1 &
sleep 4
echo ""
echo "GAM Platform running:"
lsof -i tcp:3001,3002,3003,3004,4000 | grep LISTEN | awk '{print $9}' | sort
