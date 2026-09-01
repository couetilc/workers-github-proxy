#!/usr/bin/env bash
# Can a git remote proxy stream BOTH directions through a fixed, small memory
# budget -- a push (pack in the request) AND a clone (pack in the response) --
# while still enforcing header auth and front-of-stream ref policy without ever
# buffering the pack?
#
# Topology (loopback, disposable repos + throwaway two-CA PKI in a temp dir):
#
#   git --TLS/proxy-ca--> [ proxy :8443 ] --TLS/upstream-ca--> [ upstream git :9443 ]
#
# The script:
#   SWEEP    for each pack size, push and clone through BOTH the streaming proxy
#            and the buffering proxy, recording each proxy's PEAK memory. Streaming
#            should stay flat; buffering should climb with the pack.
#   AUTH     the streaming proxy rejects an unauthenticated request from headers
#            alone (0 body bytes), and accepts the authenticated one.
#   POLICY   the streaming proxy rejects a push to a locked ref from the command
#            section alone, draining (not buffering) the pack -- memory stays flat.
#
# Env: KEEP=1 keeps the workdir. SIZES="16 64 256" (MB). PROXY_PORT / UPSTREAM_PORT.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/git-stream.XXXXXX")"
UPSTREAM_PORT=${UPSTREAM_PORT:-9443}
PROXY_PORT=${PROXY_PORT:-8443}
SIZES=${SIZES:-"16 64 256"}
SECRET="proxytoken-s3cr3t"
PIDS=()

cleanup() {
  for pid in "${PIDS[@]:-}"; do kill "$pid" 2>/dev/null || true; done
  if [ "${KEEP:-0}" = "1" ]; then echo "[kept workdir: $WORK]"; else rm -rf "$WORK"; fi
}
trap cleanup EXIT

wait_port() { for _ in $(seq 1 100); do (exec 3<>"/dev/tcp/$1/$2") 2>/dev/null && { exec 3>&- 3<&-; return 0; }; sleep 0.1; done; echo "timed out waiting for $1:$2" >&2; return 1; }
wait_gone() { for _ in $(seq 1 100); do (exec 3<>"/dev/tcp/$1/$2") 2>/dev/null && { exec 3>&- 3<&-; sleep 0.1; } || return 0; done; }
hr() { printf '\n########## %s ##########\n' "$1"; }
field() { sed -n "s/.*$2=\([0-9.]*\)MB.*/\1/p" <<<"$1"; }   # field "<PEAK line>" rss

CERTS="$WORK/certs"; BARE_ROOT="$WORK/bare-repos"
CA="-c http.sslCAInfo=$CERTS/proxy-ca.crt"
mkdir -p "$BARE_ROOT"

# ---------------------------------------------------------------------------
hr "SETUP: throwaway two-CA PKI (proxy leaf + upstream leaf)"
"$SCRIPT_DIR/gen-certs.sh" "$CERTS" | sed 's/^/  /'

hr "SETUP: start streaming upstream HTTPS git server on https://localhost:$UPSTREAM_PORT"
TLS_CERT="$CERTS/upstream.crt" TLS_KEY="$CERTS/upstream.key" \
  GIT_PROJECT_ROOT="$BARE_ROOT" PORT=$UPSTREAM_PORT \
  node "$SCRIPT_DIR/upstream-server.js" >"$WORK/upstream.log" 2>&1 &
UPSTREAM_PID=$!; PIDS+=($UPSTREAM_PID); wait_port 127.0.0.1 "$UPSTREAM_PORT"

# start_proxy MODE(streaming|buffering) LOGFILE  -> sets PROXY_PID
start_proxy() {
  local mode="$1" log="$2"
  local common=(TLS_CERT="$CERTS/proxy.crt" TLS_KEY="$CERTS/proxy.key"
                UPSTREAM_ORIGIN="https://localhost:$UPSTREAM_PORT"
                UPSTREAM_CA="$CERTS/upstream-ca.crt" UPSTREAM_SERVERNAME=localhost
                PORT=$PROXY_PORT)
  if [ "$mode" = streaming ]; then
    env "${common[@]}" AUTH_TOKEN="$SECRET" node "$SCRIPT_DIR/streaming-proxy.js" >"$log" 2>&1 &
  else
    env "${common[@]}" node "$SCRIPT_DIR/buffering-proxy.js" >"$log" 2>&1 &
  fi
  PROXY_PID=$!; PIDS+=($PROXY_PID); wait_port 127.0.0.1 "$PROXY_PORT"
}

# stop_proxy PID LOGFILE -> prints the PEAK line the sampler dumped on SIGTERM
stop_proxy() {
  kill -TERM "$1" 2>/dev/null || true
  for _ in $(seq 1 100); do kill -0 "$1" 2>/dev/null || break; sleep 0.05; done
  wait_gone 127.0.0.1 "$PROXY_PORT"
  grep -m1 '^PEAK ' "$2" || echo "PEAK rss=0MB arrayBuffers=0MB external=0MB heapUsed=0MB"
}

# build a source repo whose single blob is SIZE_MB of incompressible random data,
# so the resulting packfile is ~SIZE_MB (a controllable, unbounded-in-principle pack)
build_src() { # SIZE_MB  DIR
  local mb="$1" dir="$2"
  mkdir -p "$dir"; ( cd "$dir"
    git init -q -b main
    git config core.hooksPath /dev/null
    git config user.email exp@localhost; git config user.name Experimenter
    git config commit.gpgsign false
    head -c "$((mb * 1024 * 1024))" /dev/urandom > big.bin
    git add big.bin && git commit -q --no-verify -m "seed: ${mb}MB random blob"
  )
}

PUSH_URL()  { echo "https://x:$SECRET@127.0.0.1:$PROXY_PORT/$1.git"; }

declare -A RSS AB   # RSS[mode:dir:size]  AB[mode:dir:size]

# =========================== MEMORY SWEEP ==================================
for MB in $SIZES; do
  hr "SWEEP size=${MB}MB : build source repo (~${MB}MB packfile)"
  SRC="$WORK/src-$MB"; build_src "$MB" "$SRC"
  echo "  git object store (~ what will cross the wire, incompressible): $(du -sh "$SRC/.git/objects" 2>/dev/null | cut -f1 || echo n/a)"

  for MODE in streaming buffering; do
    # ---- PUSH: pack rides in the REQUEST -> measure proxy while it ingests it ----
    BARE="push-$MODE-$MB"; git init -q --bare "$BARE_ROOT/$BARE.git"
    git -C "$BARE_ROOT/$BARE.git" config http.receivepack true
    LOG="$WORK/proxy-$MODE-push-$MB.log"; start_proxy "$MODE" "$LOG"
    GIT_TERMINAL_PROMPT=0 git $CA -C "$SRC" push "$(PUSH_URL "$BARE")" main:main >/dev/null 2>&1 \
      && P=$(stop_proxy "$PROXY_PID" "$LOG") || { P=$(stop_proxy "$PROXY_PID" "$LOG"); echo "  !! push failed ($MODE $MB)"; }
    RSS[$MODE:push:$MB]=$(field "$P" rss); AB[$MODE:push:$MB]=$(field "$P" arrayBuffers)
    echo "  push  $MODE ${MB}MB -> peak rss=$(field "$P" rss)MB  arrayBuffers=$(field "$P" arrayBuffers)MB"

    # ---- CLONE: pack rides in the RESPONSE -> measure proxy while it emits it ----
    # clone from the streaming-pushed bare repo (identical contents either mode)
    SRCBARE="push-streaming-$MB"
    DEST="$WORK/clone-$MODE-$MB"
    LOG="$WORK/proxy-$MODE-clone-$MB.log"; start_proxy "$MODE" "$LOG"
    GIT_TERMINAL_PROMPT=0 git $CA clone -q "$(PUSH_URL "$SRCBARE")" "$DEST" >/dev/null 2>&1 \
      && P=$(stop_proxy "$PROXY_PID" "$LOG") || { P=$(stop_proxy "$PROXY_PID" "$LOG"); echo "  !! clone failed ($MODE $MB)"; }
    RSS[$MODE:clone:$MB]=$(field "$P" rss); AB[$MODE:clone:$MB]=$(field "$P" arrayBuffers)
    echo "  clone $MODE ${MB}MB -> peak rss=$(field "$P" rss)MB  arrayBuffers=$(field "$P" arrayBuffers)MB"
    rm -rf "$DEST"
  done
done

# =========================== RESULTS TABLE =================================
hr "RESULT: peak proxy memory vs pack size (MB)"
printf '\n  PUSH  (pack in request)                    CLONE (pack in response)\n'
printf '  %-6s | %-21s | %-21s || %-21s | %-21s\n' size "stream rss / arrayBuf" "buffer rss / arrayBuf" "stream rss / arrayBuf" "buffer rss / arrayBuf"
printf '  %-6s-+-%-21s-+-%-21s-++-%-21s-+-%-21s\n' "------" "---------------------" "---------------------" "---------------------" "---------------------"
for MB in $SIZES; do
  printf '  %-6s | %-21s | %-21s || %-21s | %-21s\n' "$MB" \
    "${RSS[streaming:push:$MB]} / ${AB[streaming:push:$MB]}" \
    "${RSS[buffering:push:$MB]} / ${AB[buffering:push:$MB]}" \
    "${RSS[streaming:clone:$MB]} / ${AB[streaming:clone:$MB]}" \
    "${RSS[buffering:clone:$MB]} / ${AB[buffering:clone:$MB]}"
done
echo
echo "  Read: streaming columns should stay ~flat across sizes; buffering columns"
echo "  should climb ~linearly with the pack. arrayBuffers is the git-bytes-held signal."

# =========================== AUTH CONTROL =================================
hr "CONTROL (auth): header-level auth is decided before any body byte is read"
build_src 8 "$WORK/src-auth"
git init -q --bare "$BARE_ROOT/auth-test.git"; git -C "$BARE_ROOT/auth-test.git" config http.receivepack true
LOG="$WORK/proxy-auth.log"; start_proxy streaming "$LOG"
echo "-- push with NO credentials (expect: rejected) --"
if GIT_TERMINAL_PROMPT=0 git $CA -C "$WORK/src-auth" push "https://127.0.0.1:$PROXY_PORT/auth-test.git" main:main 2>&1 | sed 's/^/   git: /'; then
  echo "   !! UNEXPECTED: unauthenticated push succeeded"
else
  echo "   => rejected, as expected."
fi
echo "-- push WITH credentials (expect: succeeds) --"
GIT_TERMINAL_PROMPT=0 git $CA -C "$WORK/src-auth" push "$(PUSH_URL auth-test)" main:main 2>&1 | sed 's/^/   git: /'
stop_proxy "$PROXY_PID" "$LOG" >/dev/null
echo "-- proxy log (note AUTH-DENY reads 0 body bytes, then the authed push streams) --"
grep -E 'AUTH-DENY|POLICY ALLOW|PEAK' "$LOG" | sed 's/^/   /'

# =========================== POLICY CONTROL ==============================
hr "CONTROL (policy): front-of-stream ref policy, pack drained not buffered"
POL_MB=64
build_src "$POL_MB" "$WORK/src-policy"
git -C "$WORK/src-policy" branch locked            # a ref the proxy refuses to update
git init -q --bare "$BARE_ROOT/policy-test.git"; git -C "$BARE_ROOT/policy-test.git" config http.receivepack true
LOG="$WORK/proxy-policy.log"; start_proxy streaming "$LOG"
echo "-- push the LOCKED ref with a ${POL_MB}MB pack (expect: rejected at the front) --"
if GIT_TERMINAL_PROMPT=0 git $CA -C "$WORK/src-policy" push "$(PUSH_URL policy-test)" locked:locked 2>&1 | sed 's/^/   git: /'; then
  echo "   !! UNEXPECTED: push to locked ref succeeded"
else
  echo "   => rejected, as expected."
fi
echo "-- push an ALLOWED ref (main) with the same ${POL_MB}MB pack (expect: succeeds) --"
GIT_TERMINAL_PROMPT=0 git $CA -C "$WORK/src-policy" push "$(PUSH_URL policy-test)" main:main 2>&1 | sed 's/^/   git: /'
P=$(stop_proxy "$PROXY_PID" "$LOG")
echo "-- proxy log: DENY decided from the command section; pack drained; peak flat --"
grep -E 'POLICY (DENY|ALLOW)|decided from|drained|PEAK' "$LOG" | sed 's/^/   /'
echo "   (peak arrayBuffers above << ${POL_MB}MB proves the ${POL_MB}MB pack was never buffered, even to reject it)"

hr "DONE"
