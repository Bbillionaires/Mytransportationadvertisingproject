#!/usr/bin/env bash
# Verifies the isolated media worker end to end (R-023): a real upload is processed inside the hardened container,
# and the container's restrictions hold from the inside. Needs Docker. Uses its own compose project and port.
#   bash infra/media-worker/verify.sh
# Optional: POSTGRES_IMAGE / NODE_IMAGE (registry mirrors), MEDIA_WORKER_IMAGE (prebuilt image).
set -euo pipefail
cd "$(dirname "$0")/../.."
export PG_PORT=${PG_PORT:-55432} MEDIA_DB=rmn_dev
export MEDIA_HOST_DIR; MEDIA_HOST_DIR=$(mktemp -d) && chmod 777 "$MEDIA_HOST_DIR"
P="docker compose -p rmn-worker-verify --profile worker"
cleanup() { $P down -v >/dev/null 2>&1 || true; }
trap cleanup EXIT
KEYS=(-e APP_ENCRYPTION_KEY="$(openssl rand -base64 32)" -e MEDIA_SIGNING_KEY="$(openssl rand -base64 32)" -e STRIPE_WEBHOOK_SECRET=whsec_verify -e LOG_LEVEL=warn)

$P up -d --wait postgres >/dev/null
URL="postgres://rmn:rmn@127.0.0.1:${PG_PORT}/rmn_dev"
ffmpeg -hide_banner -loglevel error -y -f lavfi -i color=c=orange:s=640x360:d=6:r=24 -f lavfi -i sine=frequency=440:duration=6 -shortest \
  -c:v libx264 -preset ultrafast -pix_fmt yuv420p -c:a aac "$MEDIA_HOST_DIR/in.mp4"
UPLOAD=$(cd apps/api && DATABASE_URL="$URL" MEDIA_ROOT="$MEDIA_HOST_DIR" npx tsx ../../infra/media-worker/upload-fixture.mts "$MEDIA_HOST_DIR/in.mp4" | tail -1)
echo "uploaded $UPLOAD; starting the isolated worker"
chmod -R a+rwX "$MEDIA_HOST_DIR"

$P run -d --name rmn-worker-verify-w "${KEYS[@]}" media-worker >/dev/null
for i in $(seq 1 60); do
  S=$(psql "$URL" -tAc "SELECT status FROM media_uploads WHERE id = '$UPLOAD'")
  [ "$S" = READY ] && break; [ "$S" = FAILED ] && { psql "$URL" -tAc "SELECT error FROM media_uploads WHERE id = '$UPLOAD'"; exit 1; }
  sleep 2
done
[ "$S" = READY ] || { docker logs rmn-worker-verify-w; echo "FAIL: upload not processed ($S)"; exit 1; }
echo "PASS processed inside the container: $(psql "$URL" -tAc "SELECT kind || ' ' || duration_ms || ' ms' FROM media_assets WHERE upload_id = '$UPLOAD'")"
NETS=$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' rmn-worker-verify-w | xargs)
[ "$NETS" = "rmn-worker-verify_backend" ] && [ "$(docker network inspect -f '{{.Internal}}' rmn-worker-verify_backend)" = true ] \
  && echo "PASS attached only to the internal (no-route-out) database network" || { echo "FAIL networks: $NETS"; exit 1; }
docker rm -f rmn-worker-verify-w >/dev/null

check() { $P run --rm --no-deps "${KEYS[@]}" --entrypoint sh media-worker -c "$1"; }
check 'node -e "fetch(\"https://example.com\",{signal:AbortSignal.timeout(5000)}).then(()=>{console.log(\"FAIL internet reachable\");process.exit(1)}).catch(()=>console.log(\"PASS no internet access\"))"'
check 'touch /app/x 2>/dev/null && { echo "FAIL root filesystem writable"; exit 1; } || echo "PASS read-only root filesystem"'
check '[ "$(id -u)" = 1000 ] && echo "PASS runs as uid 1000 (not root)" || { echo FAIL root; exit 1; }'
check 'grep -q "^CapEff:[[:space:]]*0000000000000000" /proc/self/status && echo "PASS no Linux capabilities" || { echo FAIL capabilities; exit 1; }'
check 'grep -q "^NoNewPrivs:[[:space:]]*1" /proc/self/status && echo "PASS no privilege escalation" || { echo FAIL no_new_privs; exit 1; }'
check 'echo > /tmp/ok && echo "PASS /tmp is writable scratch (tmpfs)"'
echo "media worker isolation verified"
