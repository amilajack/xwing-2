#!/bin/bash
set -euo pipefail
source /etc/xwing/deployment
export AWS_REGION=us-west-1 AWS_HOSTED_ZONE_ID=${AWS_HOSTED_ZONE_ID:-Z01849682MODSJLX20QLO}
base=/var/lib/xwing-acme
previous=$(sha256sum /etc/xwing/tls/cert.pem 2>/dev/null | cut -d" " -f1 || true)
if [[ -f "$base/certificates/$HOSTNAME.crt" ]]; then
  lego --path "$base" --email "$ACME_EMAIL" --accept-tos --dns route53 --domains "$HOSTNAME" --key-type ec256 renew --days 30
else
  lego --path "$base" --email "$ACME_EMAIL" --accept-tos --dns route53 --domains "$HOSTNAME" --key-type ec256 run
fi
install -o xwing -g xwing -m 640 "$base/certificates/$HOSTNAME.crt" /etc/xwing/tls/cert.pem
install -o xwing -g xwing -m 640 "$base/certificates/$HOSTNAME.key" /etc/xwing/tls/key.pem
chmod 750 /etc/xwing /etc/xwing/tls
chown root:xwing /etc/xwing /etc/xwing/tls
tar czf /tmp/tls.tar.gz -C "$base" .
aws s3 cp /tmp/tls.tar.gz "s3://$BUCKET/certificates/tls.tar.gz" --sse AES256 --region us-west-1
rm /tmp/tls.tar.gz
current=$(sha256sum /etc/xwing/tls/cert.pem | cut -d" " -f1)
if [[ "$previous" != "$current" ]]; then
  if systemctl is-active --quiet xwing; then systemctl restart xwing; fi
  if systemctl is-active --quiet xwing-proxy; then systemctl reload xwing-proxy; fi
fi
