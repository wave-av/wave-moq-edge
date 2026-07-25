#!/usr/bin/env bash
# Publish → subscribe round trip against any moq-edge instance. Prints PASS/FAIL and a measured p50.
#
#   examples/interop-test.sh --local                       # boots `wrangler dev` and tests that
#   examples/interop-test.sh                               # tests wss://moq.wave.online (needs a key)
#   examples/interop-test.sh --relay wss://moq.staging.wave.online --ns demo --track hello
#
# AUTH: the production relay accepts only a gateway-minted join token. Export WAVE_API_KEY and the
# publisher/subscriber mint their own, or export WAVE_MOQ_JOIN with a token you already hold. Neither
# is read from a file, echoed, or written anywhere. Against `--local` neither is needed, because a
# local `wrangler dev` runs with join enforcement off — that is the dev default in wrangler.toml, not
# something this script turns off.
#
# Requires: node >= 22 (for `--experimental-strip-types` and the global WebSocket). No npm install.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"

RELAY="${WAVE_MOQ_RELAY:-wss://moq.wave.online}"
NS="demo"
TRACK="interop-$(date +%s)"
SECONDS_RUN=8
FPS=15
LOCAL=0
LOCAL_PORT=8791   # not wrangler's 8787 default: that port is commonly already taken
MIN_OBJECTS=10

while [[ $# -gt 0 ]]; do
  case "$1" in
    --local)   LOCAL=1; shift ;;
    --relay)   RELAY="$2"; shift 2 ;;
    --ns)      NS="$2"; shift 2 ;;
    --track)   TRACK="$2"; shift 2 ;;
    --seconds) SECONDS_RUN="$2"; shift 2 ;;
    --fps)     FPS="$2"; shift 2 ;;
    --port)    LOCAL_PORT="$2"; shift 2 ;;
    -h|--help) sed -n '2,16p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
done

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [[ "$NODE_MAJOR" -lt 22 ]]; then
  echo "FAIL: node >= 22 required (found $(node -v 2>/dev/null || echo none)); this test uses the built-in TypeScript stripper and the global WebSocket." >&2
  exit 1
fi

WORKDIR="$(mktemp -d)"
DEV_PID=""
PUB_PID=""
cleanup() {
  [[ -n "$PUB_PID" ]] && kill "$PUB_PID" 2>/dev/null || true
  [[ -n "$DEV_PID" ]] && kill "$DEV_PID" 2>/dev/null || true
  wait 2>/dev/null || true
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

# Is the thing answering on this port actually moq-edge? Any port can have something else on it,
# and "connection refused" three steps later is a much worse error message than this one.
is_moq_edge() {
  curl -fsS --max-time 3 "http://127.0.0.1:$1/health" 2>/dev/null \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.exit(JSON.parse(s).service==="moq-edge"?0:1)}catch{process.exit(1)}})'
}

if [[ "$LOCAL" == "1" ]]; then
  if curl -fsS --max-time 3 "http://127.0.0.1:$LOCAL_PORT/health" >/dev/null 2>&1 && ! is_moq_edge "$LOCAL_PORT"; then
    echo "FAIL: something that is not moq-edge is already serving port $LOCAL_PORT. Re-run with --port <free port>." >&2
    exit 1
  fi
  echo "› starting a local relay: wrangler dev --port $LOCAL_PORT"
  ( cd "$ROOT" && npx --yes wrangler dev --port "$LOCAL_PORT" --local ) >"$WORKDIR/wrangler.log" 2>&1 &
  DEV_PID=$!
  RELAY="ws://127.0.0.1:$LOCAL_PORT"
  for _ in $(seq 1 60); do
    if is_moq_edge "$LOCAL_PORT"; then break; fi
    sleep 1
  done
  if ! is_moq_edge "$LOCAL_PORT"; then
    echo "FAIL: local relay did not become healthy on port $LOCAL_PORT. Last 20 lines of wrangler output:" >&2
    tail -20 "$WORKDIR/wrangler.log" >&2
    exit 1
  fi
  echo "› local relay healthy: $(curl -fsS "http://127.0.0.1:$LOCAL_PORT/health" | tr -d '\n ')"
fi

echo "› relay     : $RELAY"
echo "› track     : $NS/$TRACK"
echo "› duration  : ${SECONDS_RUN}s at ${FPS} fps"

NODE_RUN=(node --no-warnings --experimental-strip-types "$HERE/server-publisher.ts")

# 1. Publisher first — a subscriber that arrives after it is the realistic case, and it exercises the
#    relay's late-joiner group cache (MOQ_CACHED_GROUPS).
"${NODE_RUN[@]}" publish --relay "$RELAY" --ns "$NS" --track "$TRACK" \
  --fps "$FPS" --seconds "$((SECONDS_RUN + 4))" >"$WORKDIR/pub.json" 2>"$WORKDIR/pub.log" &
PUB_PID=$!
sleep 2

if ! kill -0 "$PUB_PID" 2>/dev/null; then
  echo "FAIL: the publisher exited before the subscriber connected." >&2
  cat "$WORKDIR/pub.log" >&2
  exit 1
fi

# 2. Subscriber — measures latency and emits one JSON line on stdout.
set +e
"${NODE_RUN[@]}" subscribe --relay "$RELAY" --ns "$NS" --track "$TRACK" \
  --seconds "$SECONDS_RUN" >"$WORKDIR/sub.json" 2>"$WORKDIR/sub.log"
SUB_RC=$?
set -e

wait "$PUB_PID" 2>/dev/null || true
PUB_PID=""

RESULT="$(tail -1 "$WORKDIR/sub.json" 2>/dev/null || true)"
if [[ -z "$RESULT" ]]; then
  echo "FAIL: the subscriber produced no result." >&2
  echo "--- subscriber log ---" >&2; cat "$WORKDIR/sub.log" >&2
  echo "--- publisher log ----" >&2; cat "$WORKDIR/pub.log" >&2
  exit 1
fi

read -r OBJECTS KEYFRAMES P50 P95 SUBOK BAD <<<"$(
  node -e '
    const r = JSON.parse(process.argv[1]);
    process.stdout.write([r.objects, r.keyframes, r.p50_ms ?? -1, r.p95_ms ?? -1, r.subscribe_ok, r.bad_envelope].join(" "));
  ' "$RESULT"
)"

echo
echo "─── moq-edge interop ────────────────────────────────────────"
printf '  subscribe_ok    %s\n' "$SUBOK"
printf '  objects         %s (%s keyframes, %s malformed envelopes)\n' "$OBJECTS" "$KEYFRAMES" "$BAD"
printf '  latency p50     %s ms\n' "$P50"
printf '  latency p95     %s ms\n' "$P95"
echo "  latency basis   publisher clock → subscriber clock (same host here, so no skew)"
echo "─────────────────────────────────────────────────────────────"

if [[ "$SUB_RC" -eq 0 && "$SUBOK" == "true" && "$OBJECTS" -ge "$MIN_OBJECTS" && "$BAD" -eq 0 ]]; then
  echo "PASS — publish → relay → subscribe round trip, $OBJECTS objects, p50 ${P50} ms"
  exit 0
fi

echo "FAIL — expected SUBSCRIBE_OK and >= $MIN_OBJECTS well-formed objects; got subscribe_ok=$SUBOK objects=$OBJECTS malformed=$BAD" >&2
echo "--- subscriber log ---" >&2; cat "$WORKDIR/sub.log" >&2
echo "--- publisher log ----" >&2; cat "$WORKDIR/pub.log" >&2
exit 1
