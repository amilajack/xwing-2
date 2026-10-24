#!/bin/bash
set -euo pipefail
source /etc/xwing/deployment
cd /opt/xwing
if [[ "${1:-}" != "--installed" ]]; then
  release_key="${1:-releases/current.tar.gz}"
  version=$(aws s3api head-object --bucket "$BUCKET" --key "$release_key" --query VersionId --output text --region us-west-1)
  aws s3api get-object --bucket "$BUCKET" --key "$release_key" --version-id "$version" /tmp/xwing-release.tar.gz --region us-west-1 >/dev/null
  # Stop/drain before replacing files; migrations finish before the new process starts.
  systemctl stop xwing
  tar xzf /tmp/xwing-release.tar.gz -C /opt/xwing
fi
umask 077
aws ssm get-parameters --names /xwing-coop/database-url /xwing-coop/migration-database-url --with-decryption --region us-west-1 --output json | /opt/xwing/bin/node --input-type=module -e '
let input="";for await(const c of process.stdin)input+=c;const p=JSON.parse(input).Parameters;
const runtime=p.find(p=>p.Name.endsWith("/database-url"))?.Value;
const direct=p.find(p=>p.Name.endsWith("/migration-database-url"))?.Value;
if(!runtime||!direct)throw Error("Database credentials missing");
process.stdout.write(`DATABASE_URL=${JSON.stringify(runtime)}\nMIGRATION_DATABASE_URL=${JSON.stringify(direct)}\n`);
' > /etc/xwing/database.env
set -a; source /etc/xwing/database.env; set +a
PATH=/opt/xwing/bin:$PATH /opt/xwing/bin/node node_modules/prisma/build/index.js migrate deploy
cat > /etc/xwing/runtime.env <<CONFIG
ALLOWED_ORIGINS=$ALLOWED_ORIGINS
TRANSPORT_URL=https://$HOSTNAME/game
QUIC_PORT=443
API_PORT=8080
TLS_CERT=/etc/xwing/tls/cert.pem
TLS_KEY=/etc/xwing/tls/key.pem
EC2_METADATA=1
TRUST_PROXY=1
CONFIG
chown -R xwing:xwing /opt/xwing
systemctl enable --now xwing
