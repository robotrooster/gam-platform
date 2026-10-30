#!/usr/bin/env bash
# GCP plan C, step 5: the global HTTPS load balancer in front of gam-api and
# gam-storefront (~$20/month + traffic), with Google-managed certificates.
#
#   api.goldassetmanagement.com → gam-api
#   *.gam.biz (every other host) → gam-storefront
#
# Certificates are DNS-authorized, so they issue BEFORE any traffic moves:
# add the CNAMEs printed at the end (DNS only, never proxied), wait for the
# certificates to go ACTIVE, and only then point the A records at the IP.
set -euo pipefail
cd "$(dirname "$0")"; . ./env.sh

echo "── address"
ensure g compute addresses create gam-lb-ip --global --ip-version IPV4

echo "── backends (serverless NEGs → Cloud Run)"
for svc in gam-api gam-storefront; do
  ensure g compute network-endpoint-groups create "$svc-neg" --region "$REGION" \
    --network-endpoint-type serverless --cloud-run-service "$svc"
  ensure g compute backend-services create "$svc-backend" --global \
    --load-balancing-scheme EXTERNAL_MANAGED --enable-logging --logging-sample-rate 1.0
  ensure g compute backend-services add-backend "$svc-backend" --global \
    --network-endpoint-group "$svc-neg" --network-endpoint-group-region "$REGION"
done

echo "── routing"
ensure g compute url-maps create gam-lb --default-service gam-storefront-backend
ensure g compute url-maps add-path-matcher gam-lb --path-matcher-name api \
  --default-service gam-api-backend --new-hosts "$API_HOST"

echo "── certificates (DNS authorization)"
ensure g certificate-manager dns-authorizations create gam-api-dns --domain "$API_HOST"
ensure g certificate-manager dns-authorizations create gam-biz-dns --domain "$STOREFRONT_DOMAIN"
ensure g certificate-manager certificates create gam-api-cert \
  --domains "$API_HOST" --dns-authorizations gam-api-dns
ensure g certificate-manager certificates create gam-biz-cert \
  --domains "*.$STOREFRONT_DOMAIN" --dns-authorizations gam-biz-dns
ensure g certificate-manager maps create gam-certs
ensure g certificate-manager maps entries create gam-api --map gam-certs \
  --hostname "$API_HOST" --certificates gam-api-cert
ensure g certificate-manager maps entries create gam-biz --map gam-certs \
  --hostname "*.$STOREFRONT_DOMAIN" --certificates gam-biz-cert

echo "── HTTPS frontend"
ensure g compute target-https-proxies create gam-https --url-map gam-lb --certificate-map gam-certs
ensure g compute forwarding-rules create gam-https --global --load-balancing-scheme EXTERNAL_MANAGED \
  --address gam-lb-ip --target-https-proxy gam-https --ports 443

echo "── HTTP → HTTPS redirect"
cat > /tmp/gam-http-redirect.yaml <<'YAML'
name: gam-http-redirect
defaultUrlRedirect:
  httpsRedirect: true
  redirectResponseCode: MOVED_PERMANENTLY_DEFAULT
  stripQuery: false
YAML
ensure g compute url-maps import gam-http-redirect --global --source /tmp/gam-http-redirect.yaml --quiet
ensure g compute target-http-proxies create gam-http --url-map gam-http-redirect
ensure g compute forwarding-rules create gam-http --global --load-balancing-scheme EXTERNAL_MANAGED \
  --address gam-lb-ip --target-http-proxy gam-http --ports 80

ip=$(g compute addresses describe gam-lb-ip --global --format='value(address)')
echo
echo "DNS — 1) now: certificate validation (CNAME, DNS only / grey cloud)"
for a in gam-api-dns gam-biz-dns; do
  g certificate-manager dns-authorizations describe "$a" \
    --format='value(dnsResourceRecord.name,dnsResourceRecord.type,dnsResourceRecord.data)' | sed 's/^/  /'
done
echo "   status: g certificate-manager certificates list   (wait for ACTIVE)"
echo "DNS — 2) at cutover: A records → $ip"
echo "  $API_HOST.  A  $ip"
echo "  *.$STOREFRONT_DOMAIN.  A  $ip"
