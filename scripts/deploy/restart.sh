#!/bin/bash
# pm2 restart wrapper -- always passes --update-env so ecosystem.config.js changes take effect
# Usage: ./scripts/deploy/restart.sh [worker|api|all]

set -euo pipefail

CDIR="$(cd "$(dirname "$0")/../.." && pwd)"

case "${1:-all}" in
  worker)
    echo "Restarting mai-push-worker with --update-env..."
    pm2 start "$CDIR/ecosystem.config.js" --only mai-push-worker --update-env
    ;;
  api)
    echo "Restarting mai-push-api with --update-env..."
    pm2 start "$CDIR/ecosystem.config.js" --only mai-push-api --update-env
    ;;
  all)
    echo "Restarting all mai-push processes with --update-env..."
    pm2 start "$CDIR/ecosystem.config.js" --update-env
    ;;
  *)
    echo "Usage: $0 [worker|api|all]"
    exit 1
    ;;
esac

echo "Done. Use 'pm2 status' to verify."
