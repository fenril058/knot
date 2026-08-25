#!/usr/bin/env bash
# knot Docker イメージのスモークテスト（plan-06 Task 9/10 の単一ソース。CI からもこのまま実行する）。
# build → init → account add → secureCookie: false 設定 → 起動待機 → 401 →
# ログイン 200 → 再起動後の volume 書き込み 200 → cleanup。
set -euo pipefail

IMAGE="knot:smoke-$$"
VOLUME="knot-smoke-$$"
CONTAINER="knot-smoke-$$"
PORT="${KNOT_SMOKE_PORT:-13000}"
BASE="http://127.0.0.1:$PORT"
COOKIES="$(mktemp)"

cleanup() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  docker volume rm "$VOLUME" >/dev/null 2>&1 || true
  docker rmi "$IMAGE" >/dev/null 2>&1 || true
  rm -f "$COOKIES"
}
trap cleanup EXIT

docker build -t "$IMAGE" .
docker volume create "$VOLUME" >/dev/null
docker run --rm -v "$VOLUME":/data "$IMAGE" init --data /data
echo -n 'pw12345678' | docker run --rm -i -v "$VOLUME":/data "$IMAGE" account add --data /data --name alice
# 既定 CMD は --hostname 0.0.0.0 で secureCookie: auto が true に解決されるため、
# HTTP のスモークでは Secure cookie を再送できない。テスト専用に無効化する
# （本番はリバースプロキシの HTTPS 終端配下で auto のまま使う。docs/ops.md 参照）。
docker run --rm -v "$VOLUME":/data --entrypoint /bin/sh "$IMAGE" \
  -c 'echo "{\"secureCookie\": false}" > /data/config.json'
docker run -d --name "$CONTAINER" -p "127.0.0.1:$PORT:3000" -v "$VOLUME":/data "$IMAGE" >/dev/null

wait_ready() {
  for _ in $(seq 1 60); do
    code="$(curl --connect-timeout 2 --max-time 10 -s -o /dev/null -w '%{http_code}' "$BASE/api/pages/none" || true)"
    if [ "$code" = "401" ]; then return 0; fi
    sleep 0.5
  done
  echo "server did not answer 401 in time" >&2
  docker logs "$CONTAINER" >&2 || true
  return 1
}

login() {
  curl --connect-timeout 2 --max-time 10 -s -o /dev/null -w '%{http_code}' -c "$COOKIES" \
    -H 'content-type: application/json' -H 'X-Knot-Client: smoke' \
    -d '{"name":"alice","password":"pw12345678"}' \
    "$BASE/api/knot/session"
}

wait_ready
code="$(login)"
[ "$code" = "200" ] || { echo "login failed: $code" >&2; exit 1; }

# 再起動後も named volume の所有権と永続化が保たれ、書き込み API が通ること
docker restart "$CONTAINER" >/dev/null
wait_ready
code="$(login)"
[ "$code" = "200" ] || { echo "re-login failed: $code" >&2; exit 1; }
code="$(curl --connect-timeout 2 --max-time 10 -s -o /dev/null -w '%{http_code}' -b "$COOKIES" -X POST \
  -H 'X-Knot-Client: smoke' "$BASE/api/knot/projects/smoke")"
[ "$code" = "200" ] || { echo "project create failed: $code" >&2; exit 1; }

echo "docker smoke OK"
